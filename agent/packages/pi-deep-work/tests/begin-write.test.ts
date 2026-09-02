import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	WritePreflight,
	WritePreflightError,
	assertWriteBaseline,
	type WriteBaseline,
} from "../src/application/begin-write.ts";
import { ControlAcceptedError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { BackendTreeService } from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy, decodeProjectPolicy } from "../src/policy/schemas.ts";
import { RunStore } from "../src/store/run-store.ts";
import { SubjectDriftError } from "../src/subject/drift.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandResult, CommandRunner } from "../src/vcs/types.ts";
import {
	createRepositoryFixture,
	detectJjAvailability,
	isolatedVcsEnvironment,
	type RepositoryFixtureKind,
} from "./helpers/repositories.ts";

const executeFile = promisify(execFile);
const temporary: string[] = [];
const jjAvailability = await detectJjAvailability();

type Hook = (command: string, args: readonly string[]) => Promise<void>;
type Interceptor = (command: string, args: readonly string[]) => CommandResult | undefined;

function policy(mainline?: string) {
	const machine = decodeMachinePolicy({
		schemaVersion: 2,
		models: {
			orchestrator: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
			reviewers: [{ provider: "test", id: "claude-opus-4-8", thinkingLevel: "max" }],
		},
		concurrency: 1,
		maxRepairRounds: 0,
		commandTimeoutMs: 10_000,
		minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
		minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
		observations: [],
		verificationContracts: [],
		selectors: [],
	});
	if (!mainline) return resolvePolicy(machine);
	return resolvePolicy(
		machine,
		decodeProjectPolicy({
			schemaVersion: 1,
			mainline,
			quickGates: [],
			fullGates: [],
			normalizers: [],
			observations: [],
			verificationContracts: [],
			selectors: [],
			languageScopes: [],
		}),
	);
}

async function setup(
	kind: RepositoryFixtureKind,
	options: { mainline?: string; createJjBookmark?: boolean } = {},
) {
	const fixture = await createRepositoryFixture(kind);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-begin-write-"));
	temporary.push(agentDir);
	const mainline = options.mainline === undefined ? "main" : options.mainline;
	if (kind !== "git" && options.createJjBookmark !== false && mainline) {
		await fixture.run("jj", ["bookmark", "create", mainline, "-r", "@-"]);
	}
	const commands: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
	let hook: Hook | undefined;
	let interceptor: Interceptor | undefined;
	const runner: CommandRunner = async (command, args, commandOptions) => {
		commands.push({ command, args, env: commandOptions.env });
		const intercepted = interceptor?.(command, args);
		if (intercepted) return intercepted;
		let value: CommandResult;
		try {
			const result = await executeFile(command, [...args], {
				cwd: commandOptions.cwd,
				env: { ...isolatedVcsEnvironment(tmpdir()), ...commandOptions.env },
				signal: commandOptions.signal,
				timeout: commandOptions.timeoutMs,
				maxBuffer: 20 * 1024 * 1024,
			});
			value = { code: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
			value = {
				code: typeof failure.code === "number" ? failure.code : 1,
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? failure.message,
				errorCode: typeof failure.code === "string" ? failure.code : undefined,
			};
		}
		if (hook) await hook(command, args);
		return value;
	};
	const repository = await detectRepository(fixture.root, runner);
	const resolved = policy(mainline || undefined);
	const store = new RunStore(agentDir);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "build" as const,
		repositoryId: repository.repositoryId,
		policyDigest: resolved.digest,
		goal: "begin write",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create(repository.kind, initial);
	const authority = await RunAuthority.start(
		{
			store,
			leases: new PortableLeaseManager(agentDir),
			ref,
			repository,
			attemptId: attemptId(randomUUID()),
			phase: "preflight",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	const trees = new BackendTreeService(authority, repository, resolved.digest, runner, join(agentDir, "scratch"));
	const preflight = new WritePreflight(authority, trees, repository, resolved, runner);
	commands.length = 0;
	return {
		fixture,
		agentDir,
		commands,
		repository,
		resolved,
		store,
		ref,
		authority,
		trees,
		preflight,
		setHook(value: Hook | undefined) {
			hook = value;
		},
		setInterceptor(value: Interceptor | undefined) {
			interceptor = value;
		},
	};
}

async function finish(values: Awaited<ReturnType<typeof setup>>): Promise<void> {
	const state = await values.store.load(values.ref);
	if (state.lifecycle === "Active") await values.authority.cancel("done", "2026-08-25T00:00:05.000Z");
	await values.fixture.cleanup();
}

async function expectBlockedPrecondition(
	values: Awaited<ReturnType<typeof setup>>,
	message: string,
): Promise<void> {
	await expect(values.preflight.begin()).rejects.toMatchObject({ name: "WritePreflightError", message: expect.stringContaining(message) });
	expect(values.authority.state().lifecycle).toBe("Active");
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("beginWrite", () => {
	it("rejects missing and unsafe configured mainline names before repository effects", async () => {
		for (const mainline of [undefined, "", "-main", ".hidden", "group//main", "group/../main", "main.lock", "HEAD", "main@{1}"]) {
			let resolved;
			try {
				resolved = policy(mainline);
			} catch {
				continue;
			}
			const preflight = new WritePreflight(
				{} as RunAuthority,
				{} as BackendTreeService,
				{} as never,
				resolved,
				async () => {
					throw new Error("runner must not execute");
				},
			);
			await expect(preflight.begin()).rejects.toBeInstanceOf(WritePreflightError);
		}
	});

	it("mints a clean Git mainline baseline without changing checkout topology", async () => {
		const values = await setup("git");
		try {
			const head = (await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim();
			const index = (await values.fixture.run("git", ["write-tree"])).stdout.trim();
			const source = await readFile(join(values.fixture.root, "README.md"));
			const baseline = await values.preflight.begin();
			expect(baseline).toMatchObject({
				kind: "git",
				mainline: "main",
				mainlineCommitId: head,
				headOid: head,
				indexTree: index,
				treeId: index,
			});
			assertWriteBaseline(baseline);
			expect((await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
			expect((await values.fixture.run("git", ["write-tree"])).stdout.trim()).toBe(index);
			expect(await readFile(join(values.fixture.root, "README.md"))).toEqual(source);
			expect(values.commands.every((entry) => entry.command === "git")).toBe(true);
			for (const forbidden of ["checkout", "switch", "branch", "update-ref", "commit", "reset"]) {
				expect(values.commands.some((entry) => entry.args.includes(forbidden))).toBe(false);
			}
		} finally {
			await finish(values);
		}
	}, 15_000);

	const jjIt = jjAvailability.available ? it : it.skip;
	for (const kind of ["jj-native", "jj-colocated"] as const) {
		jjIt(`mints a stable ${kind} mainline baseline through jj only`, async () => {
			const values = await setup(kind);
			try {
				const operation = (
					await values.fixture.run("jj", ["op", "log", "-n", "1", "--no-graph", "-T", "id"])
				).stdout.trim();
				const bookmark = (
					await values.fixture.run("jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id"])
				).stdout.trim();
				const source = await readFile(join(values.fixture.root, "README.md"));
				const baseline = await values.preflight.begin();
				expect(baseline).toMatchObject({ kind: "jj", mainline: "main", mainlineCommitId: bookmark, operationId: operation });
				assertWriteBaseline(baseline);
				expect(
					(await values.fixture.run("jj", ["op", "log", "-n", "1", "--no-graph", "-T", "id"])).stdout.trim(),
				).toBe(operation);
				expect(
					(await values.fixture.run("jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id"])).stdout.trim(),
				).toBe(bookmark);
				expect(await readFile(join(values.fixture.root, "README.md"))).toEqual(source);
				expect(values.commands.every((entry) => entry.command === "jj")).toBe(true);
				for (const forbidden of ["bookmark", "workspace", "new", "commit", "squash", "rebase"]) {
					expect(values.commands.some((entry) => entry.args.includes(forbidden))).toBe(false);
				}
			} finally {
				await finish(values);
			}
		}, 15_000);
	}

	it("keeps Git precondition failures Active for explicit Blocked settlement", async () => {
		for (const mutate of [
			async (values: Awaited<ReturnType<typeof setup>>) => values.fixture.write("README.md", "dirty\n"),
			async (values: Awaited<ReturnType<typeof setup>>) => values.fixture.write("new.txt", "untracked\n"),
			async (values: Awaited<ReturnType<typeof setup>>) => {
				await values.fixture.write("staged.txt", "staged\n");
				await values.fixture.run("git", ["add", "staged.txt"]);
			},
		] as const) {
			const values = await setup("git");
			try {
				await mutate(values);
				await expectBlockedPrecondition(values, "not empty");
			} finally {
				await finish(values);
			}
		}
	}, 15_000);

	it("blocks detached, wrong-branch, conflicted, missing-ref, and missing-mainline Git states", async () => {
		const detached = await setup("git");
		try {
			await detached.fixture.run("git", ["checkout", "--detach"]);
			await expectBlockedPrecondition(detached, "configured mainline");
		} finally {
			await finish(detached);
		}
		const wrong = await setup("git");
		try {
			await wrong.fixture.run("git", ["checkout", "-b", "feature"]);
			await expectBlockedPrecondition(wrong, "configured mainline");
		} finally {
			await finish(wrong);
		}
		const conflict = await setup("git");
		try {
			await conflict.fixture.run("git", ["checkout", "-b", "side"]);
			await conflict.fixture.write("README.md", "side\n");
			await conflict.fixture.run("git", ["commit", "-am", "side"]);
			await conflict.fixture.run("git", ["checkout", "main"]);
			await conflict.fixture.write("README.md", "main\n");
			await conflict.fixture.run("git", ["commit", "-am", "main"]);
			await expect(conflict.fixture.run("git", ["merge", "side"])).rejects.toThrow();
			await expectBlockedPrecondition(conflict, "unresolved conflicts");
		} finally {
			await finish(conflict);
		}
		const missingRef = await setup("git");
		try {
			missingRef.setInterceptor((command, args) =>
				command === "git" && args.some((arg) => arg.startsWith("refs/heads/main^"))
					? { code: 128, stdout: "", stderr: "missing ref" }
					: undefined,
			);
			await expectBlockedPrecondition(missingRef, "inspection failed");
		} finally {
			await finish(missingRef);
		}
		const missingMainline = await setup("git", { mainline: "" });
		try {
			await expectBlockedPrecondition(missingMainline, "requires a configured mainline");
		} finally {
			await finish(missingMainline);
		}
	}, 20_000);

	jjIt("keeps Jujutsu dirty, missing, divergent, and non-ancestor preconditions Active", async () => {
		const dirty = await setup("jj-native");
		try {
			await dirty.fixture.write("README.md", "dirty\n");
			await expectBlockedPrecondition(dirty, "not empty");
		} finally {
			await finish(dirty);
		}
		const missing = await setup("jj-native", { createJjBookmark: false });
		try {
			await expectBlockedPrecondition(missing, "is missing");
		} finally {
			await finish(missing);
		}
		const divergent = await setup("jj-native");
		try {
			divergent.setInterceptor((command, args) =>
				command === "jj" && args.some((arg) => arg.startsWith("--revisions=bookmarks("))
					? { code: 0, stdout: `${"1".repeat(40)}\n${"2".repeat(40)}\n`, stderr: "" }
					: undefined,
			);
			await expectBlockedPrecondition(divergent, "is divergent");
		} finally {
			await finish(divergent);
		}
		const nonAncestor = await setup("jj-native");
		try {
			await nonAncestor.fixture.run("jj", ["new", "root()"]);
			await expectBlockedPrecondition(nonAncestor, "not an ancestor");
		} finally {
			await finish(nonAncestor);
		}
	}, 20_000);

	jjIt("blocks Jujutsu conflict, merge, and immutable working-copy commits", async () => {
		const merge = await setup("jj-native");
		try {
			const initial = (await merge.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])).stdout.trim();
			await merge.fixture.run("jj", ["new", initial]);
			await merge.fixture.write("left.txt", "left\n");
			await merge.fixture.run("jj", ["commit", "-m", "left"]);
			const left = (await merge.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])).stdout.trim();
			await merge.fixture.run("jj", ["new", initial]);
			await merge.fixture.write("right.txt", "right\n");
			await merge.fixture.run("jj", ["commit", "-m", "right"]);
			const right = (await merge.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])).stdout.trim();
			await merge.fixture.run("jj", ["new", left, right]);
			await expectBlockedPrecondition(merge, "exactly one parent");
		} finally {
			await finish(merge);
		}
		const conflict = await setup("jj-native");
		try {
			const initial = (await conflict.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])).stdout.trim();
			await conflict.fixture.run("jj", ["new", initial]);
			await conflict.fixture.write("README.md", "left\n");
			await conflict.fixture.run("jj", ["commit", "-m", "left"]);
			const left = (await conflict.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])).stdout.trim();
			await conflict.fixture.run("jj", ["new", initial]);
			await conflict.fixture.write("README.md", "right\n");
			await conflict.fixture.run("jj", ["commit", "-m", "right"]);
			const right = (await conflict.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])).stdout.trim();
			await conflict.fixture.run("jj", ["new", left, right]);
			await expectBlockedPrecondition(conflict, "unresolved conflicts");
		} finally {
			await finish(conflict);
		}
		const immutable = await setup("jj-native");
		try {
			immutable.setInterceptor((command, args) =>
				command === "jj" && args.some((arg) => arg.includes("if(immutable"))
					? { code: 0, stdout: "true\n", stderr: "" }
					: undefined,
			);
			await expectBlockedPrecondition(immutable, "must be mutable");
		} finally {
			await finish(immutable);
		}
	}, 30_000);

	it("returns drift outside effects, propagates controls, and rejects foreign bindings", async () => {
		const drift = await setup("git");
		try {
			let changed = false;
			drift.setHook(async (command, args) => {
				if (!changed && command === "git" && args.some((arg) => arg.endsWith("^{tree}"))) {
					changed = true;
					await drift.fixture.write("drift.txt", "drift\n");
				}
			});
			await expect(drift.preflight.begin()).rejects.toBeInstanceOf(SubjectDriftError);
			expect(drift.authority.state().lifecycle).toBe("Active");
		} finally {
			await finish(drift);
		}
		const controlled = await setup("git");
		try {
			let requested = false;
			controlled.setHook(async (command, args) => {
				if (!requested && command === "git" && args.some((arg) => arg.startsWith("refs/heads/main^"))) {
					requested = true;
					await controlled.store.appendControl(controlled.ref, "Cancel", "2026-08-25T00:00:02.000Z");
				}
			});
			await expect(controlled.preflight.begin()).rejects.toBeInstanceOf(ControlAcceptedError);
			expect(await controlled.store.load(controlled.ref)).toMatchObject({ lifecycle: "Cancelled" });
		} finally {
			await finish(controlled);
		}
		const foreign = await setup("git");
		try {
			const preflight = new WritePreflight(
				foreign.authority,
				foreign.trees,
				{ ...foreign.repository },
				foreign.resolved,
				async () => ({ code: 0, stdout: "", stderr: "" }),
			);
			await expect(preflight.begin()).rejects.toThrow("another authority, repository, or policy");
			expect(await foreign.store.load(foreign.ref)).toMatchObject({ lifecycle: "Failed" });
		} finally {
			await finish(foreign);
		}
	}, 20_000);

	it("rejects direct and mutated write baselines", async () => {
		const values = await setup("git");
		try {
			expect(() => assertWriteBaseline({} as WriteBaseline)).toThrow("not minted");
			const baseline = await values.preflight.begin();
			(baseline.observation as { workingDigest: string }).workingDigest = "f".repeat(64);
			expect(() => assertWriteBaseline(baseline)).toThrow("modified");
		} finally {
			await finish(values);
		}
	});
});
