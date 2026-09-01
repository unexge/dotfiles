import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGateway } from "../src/agents/gateway.ts";
import { ObservationSession } from "../src/application/observation-session.ts";
import { RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import {
	BackendTreeService,
	ObservedDiffPreconditionError,
	backendSnapshotDigest,
} from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { SubjectDriftError } from "../src/subject/drift.ts";
import { RunStore } from "../src/store/run-store.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner } from "../src/vcs/types.ts";
import {
	createRepositoryFixture,
	detectJjAvailability,
	isolatedVcsEnvironment,
	type RepositoryFixtureKind,
} from "./helpers/repositories.ts";

const executeFile = promisify(execFile);
const temporary: string[] = [];
const policyDigest = "b".repeat(64);
const jjAvailability = await detectJjAvailability();

type CommandHook = (command: string, args: readonly string[]) => Promise<void>;

async function setup(kind: RepositoryFixtureKind) {
	const fixture = await createRepositoryFixture(kind);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-observed-diff-"));
	temporary.push(agentDir);
	const commands: Array<{ command: string; args: readonly string[] }> = [];
	let hook: CommandHook | undefined;
	const runner: CommandRunner = async (command, args, options) => {
		commands.push({ command, args });
		let value;
		try {
			const result = await executeFile(command, [...args], {
				cwd: options.cwd,
				env: { ...isolatedVcsEnvironment(tmpdir()), ...options.env },
				signal: options.signal,
				timeout: options.timeoutMs,
				maxBuffer: 20 * 1024 * 1024,
			});
			value = { code: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
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
	const store = new RunStore(agentDir);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "review" as const,
		repositoryId: repository.repositoryId,
		policyDigest,
		goal: "render observed diff",
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
			phase: "observe",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	const trees = new BackendTreeService(authority, repository, policyDigest, runner, join(agentDir, "scratch"));
	return {
		fixture,
		agentDir,
		commands,
		repository,
		store,
		ref,
		authority,
		trees,
		setHook(value: CommandHook | undefined) {
			hook = value;
		},
	};
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("observed diff rendering", () => {
	it("renders Git default and explicit bases from one exact observed tree", async () => {
		const values = await setup("git");
		try {
			const initial = (await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim();
			await values.fixture.write("middle.txt", "middle\n");
			await values.fixture.run("git", ["add", "middle.txt"]);
			await values.fixture.run("git", ["commit", "-m", "middle"]);
			const head = (await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim();
			const index = (await values.fixture.run("git", ["write-tree"])).stdout.trim();
			await values.fixture.write("README.md", "working\n");
			await values.fixture.write("new.txt", "new\n");
			const gateway = {
				assertAuthority(authority: RunAuthority) {
					if (authority !== values.authority) throw new Error("wrong authority");
				},
			} as AgentGateway;
			const observed = await ObservationSession.begin(gateway, values.trees, values.authority);
			const snapshot = observed.subject;
			const digestBefore = backendSnapshotDigest(snapshot);
			values.commands.length = 0;
			await expect(observed.renderDiff(" ")).rejects.toBeInstanceOf(ObservedDiffPreconditionError);
			const local = await observed.renderDiff();
			const historical = await observed.renderDiff(initial);
			expect(local).toMatchObject({ kind: "git", baseRevision: head, paths: ["README.md", "new.txt"] });
			expect(historical.paths).toEqual(["README.md", "middle.txt", "new.txt"]);
			expect(local.diffDigest).toBe(sha256(local.patch));
			expect(historical.diffDigest).toBe(sha256(historical.patch));
			expect(await readFile(join(values.fixture.root, "README.md"), "utf8")).toBe("working\n");
			expect((await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
			expect((await values.fixture.run("git", ["write-tree"])).stdout.trim()).toBe(index);
			expect(backendSnapshotDigest(await values.trees.captureObservation())).toBe(digestBefore);
			expect(values.commands.every((entry) => entry.command === "git")).toBe(true);
			await values.authority.cancel("done", "2026-08-25T00:00:02.000Z");
		} finally {
			await values.fixture.cleanup();
		}
	}, 15_000);

	const jjIt = jjAvailability.available ? it : it.skip;
	for (const kind of ["jj-native", "jj-colocated"] as const) {
		jjIt(`renders ${kind} default and explicit revset bases through jj only`, async () => {
			const values = await setup(kind);
			try {
				const initial = (
					await values.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
				).stdout.trim();
				await values.fixture.write("middle.txt", "middle\n");
				await values.fixture.run("jj", ["commit", "-m", "middle"]);
				await values.fixture.write("README.md", "working\n");
				await values.fixture.write("new.txt", "new\n");
				const snapshot = await values.trees.captureObservation();
				if (snapshot.kind !== "jj") throw new Error("expected jj snapshot");
				const operationId = snapshot.observation.operationId;
				values.commands.length = 0;
				const local = await values.trees.renderObservedDiff(snapshot);
				const historical = await values.trees.renderObservedDiff(snapshot, initial);
				expect(local.paths).toEqual(["README.md", "new.txt"]);
				expect(historical.paths).toEqual(["README.md", "middle.txt", "new.txt"]);
				expect(local.diffDigest).toBe(sha256(local.patch));
				expect(historical.diffDigest).toBe(sha256(historical.patch));
				expect(values.commands.every((entry) => entry.command === "jj")).toBe(true);
				expect(
					values.commands.some((entry) => entry.args.includes(`--revisions=${initial}`)),
				).toBe(true);
				const after = await values.trees.captureObservation();
				if (after.kind !== "jj") throw new Error("expected jj snapshot");
				expect(after.observation.operationId).toBe(operationId);
				expect(await readFile(join(values.fixture.root, "README.md"), "utf8")).toBe("working\n");
				await values.authority.cancel("done", "2026-08-25T00:00:02.000Z");
			} finally {
				await values.fixture.cleanup();
			}
		}, 15_000);
	}

	it("observes a conflicted Git index but refuses to fabricate a diff tree", async () => {
		const values = await setup("git");
		try {
			await values.fixture.run("git", ["checkout", "-b", "side"]);
			await values.fixture.write("README.md", "side\n");
			await values.fixture.run("git", ["commit", "-am", "side"]);
			await values.fixture.run("git", ["checkout", "main"]);
			await values.fixture.write("README.md", "main\n");
			await values.fixture.run("git", ["commit", "-am", "main"]);
			await expect(values.fixture.run("git", ["merge", "side"])).rejects.toThrow();
			const snapshot = await values.trees.captureObservation();
			expect(snapshot).toMatchObject({ kind: "git", treeId: null, observation: { conflicted: true } });
			await expect(values.trees.renderObservedDiff(snapshot)).rejects.toMatchObject({
				name: "ObservedDiffPreconditionError",
				message: "Cannot render a Git diff with unresolved conflicts",
			});
			await expect(values.trees.capture()).rejects.toThrow("Git tree with conflicts");
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
		} finally {
			await values.fixture.cleanup();
		}
	});

	jjIt("observes a Jujutsu merge and requires an explicit diff base", async () => {
		const values = await setup("jj-native");
		try {
			const initial = (
				await values.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
			).stdout.trim();
			await values.fixture.run("jj", ["new", initial]);
			await values.fixture.write("left.txt", "left\n");
			await values.fixture.run("jj", ["commit", "-m", "left"]);
			const left = (
				await values.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
			).stdout.trim();
			await values.fixture.run("jj", ["new", initial]);
			await values.fixture.write("right.txt", "right\n");
			await values.fixture.run("jj", ["commit", "-m", "right"]);
			const right = (
				await values.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
			).stdout.trim();
			await values.fixture.run("jj", ["new", left, right]);
			const snapshot = await values.trees.captureObservation();
			if (snapshot.kind !== "jj") throw new Error("expected jj snapshot");
			expect(snapshot.observation.parentCommitIds).toHaveLength(2);
			await expect(values.trees.renderObservedDiff(snapshot)).rejects.toMatchObject({
				name: "ObservedDiffPreconditionError",
				message: "Jujutsu observed diff requires an explicit base for a multi-parent commit",
			});
			const rendered = await values.trees.renderObservedDiff(snapshot, left);
			expect(rendered.paths).toContain("right.txt");
			await expect(values.trees.capture()).rejects.toThrow("exactly one parent");
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
		} finally {
			await values.fixture.cleanup();
		}
	}, 15_000);

	jjIt("renders a conflicted Jujutsu subject from an explicit base without changing it", async () => {
		const values = await setup("jj-native");
		try {
			const initial = (
				await values.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
			).stdout.trim();
			await values.fixture.run("jj", ["new", initial]);
			await values.fixture.write("README.md", "left\n");
			await values.fixture.run("jj", ["commit", "-m", "left"]);
			const left = (
				await values.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
			).stdout.trim();
			await values.fixture.run("jj", ["new", initial]);
			await values.fixture.write("README.md", "right\n");
			await values.fixture.run("jj", ["commit", "-m", "right"]);
			const right = (
				await values.fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
			).stdout.trim();
			await values.fixture.run("jj", ["new", left, right]);
			const snapshot = await values.trees.captureObservation();
			if (snapshot.kind !== "jj") throw new Error("expected jj snapshot");
			expect(snapshot.observation.conflicted).toBe(true);
			const beforeDigest = backendSnapshotDigest(snapshot);
			const rendered = await values.trees.renderObservedDiff(snapshot, left);
			expect(rendered.paths).toContain("README.md");
			expect(backendSnapshotDigest(await values.trees.captureObservation())).toBe(beforeDigest);
			await expect(values.trees.capture()).rejects.toThrow("Jujutsu tree with conflicts");
		} finally {
			await values.fixture.cleanup();
		}
	}, 15_000);

	jjIt("discards a direct render result when the live Jujutsu subject drifts", async () => {
		const values = await setup("jj-native");
		try {
			await values.fixture.write("README.md", "working\n");
			const snapshot = await values.trees.captureObservation();
			let changed = false;
			values.setHook(async (command, args) => {
				if (!changed && command === "jj" && args.includes("--git")) {
					changed = true;
					await values.fixture.write("drift.txt", "drift\n");
				}
			});
			await expect(values.trees.renderObservedDiff(snapshot)).rejects.toBeInstanceOf(SubjectDriftError);
			expect(values.authority.state().lifecycle).toBe("Active");
			values.setHook(undefined);
			await values.authority.cancel("done", "2026-08-25T00:00:02.000Z");
		} finally {
			await values.fixture.cleanup();
		}
	}, 15_000);

	it("discards a direct render result when the live Git subject drifts", async () => {
		const values = await setup("git");
		try {
			await values.fixture.write("README.md", "working\n");
			const snapshot = await values.trees.captureObservation();
			let changed = false;
			values.setHook(async (command, args) => {
				if (!changed && command === "git" && args.includes("--binary")) {
					changed = true;
					await values.fixture.write("drift.txt", "drift\n");
				}
			});
			await expect(values.trees.renderObservedDiff(snapshot)).rejects.toBeInstanceOf(SubjectDriftError);
			expect(values.authority.state().lifecycle).toBe("Active");
			values.setHook(undefined);
			await values.authority.cancel("done", "2026-08-25T00:00:02.000Z");
		} finally {
			await values.fixture.cleanup();
		}
	});
});
