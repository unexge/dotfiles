import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { Normalizer } from "../src/gates/normalizer.ts";
import { BackendTreeService } from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { changedPathsDigest } from "../src/subject/content.ts";
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

function emptyNormalizerPolicy() {
	return resolvePolicy(
		decodeMachinePolicy({
			schemaVersion: 1,
			models: {
				gpt: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
				opusReviewers: [{ provider: "test", id: "claude-opus-4-8", thinkingLevel: "max" }],
			},
			concurrency: 1,
			maxRepairRounds: 0,
			commandTimeoutMs: 10_000,
			minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			observations: [],
			verificationContracts: [],
			selectors: [],
		}),
	);
}

async function setup(kind: RepositoryFixtureKind) {
	const fixture = await createRepositoryFixture(kind);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-tree-"));
	temporary.push(agentDir);
	const commands: Array<{ command: string; args: readonly string[] }> = [];
	const runner: CommandRunner = async (command, args, options) => {
		commands.push({ command, args });
		try {
			const result = await executeFile(command, [...args], {
				cwd: options.cwd,
				env: { ...isolatedVcsEnvironment(tmpdir()), ...options.env },
				signal: options.signal,
				timeout: options.timeoutMs,
				maxBuffer: 20 * 1024 * 1024,
			});
			return { code: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
			return {
				code: typeof failure.code === "number" ? failure.code : 1,
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? failure.message,
				errorCode: typeof failure.code === "string" ? failure.code : undefined,
			};
		}
	};
	const repository = await detectRepository(fixture.root, runner);
	const store = new RunStore(agentDir);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "build" as const,
		repositoryId: repository.repositoryId,
		policyDigest,
		goal: "seal candidate",
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
			phase: "seal",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	const trees = new BackendTreeService(authority, repository, policyDigest, runner, join(agentDir, "scratch"));
	const normalizer = new Normalizer(authority, emptyNormalizerPolicy(), trees);
	return { fixture, agentDir, commands, repository, authority, trees, normalizer };
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("backend tree sealing", () => {
	it("seals Git tracked, untracked, deleted, executable, symlink, and binary bytes without filters or hooks", async () => {
		const values = await setup("git");
		const marker = join(values.agentDir, "filter-ran");
		const hookMarker = join(values.agentDir, "hook-ran");
		try {
			const submoduleSource = await mkdtemp(join(tmpdir(), "pi-deep-submodule-source-"));
			temporary.push(submoduleSource);
			const submoduleEnv = isolatedVcsEnvironment(tmpdir());
			await executeFile("git", ["init", "-b", "main"], { cwd: submoduleSource, env: submoduleEnv });
			await writeFile(join(submoduleSource, "value.txt"), "one\n", "utf8");
			await executeFile("git", ["add", "."], { cwd: submoduleSource, env: submoduleEnv });
			await executeFile("git", ["commit", "-m", "initial"], { cwd: submoduleSource, env: submoduleEnv });
			await values.fixture.run("git", ["-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "sub"]);
			await values.fixture.write("delete.txt", "delete\n");
			await values.fixture.write("mode.sh", "#!/bin/sh\nexit 0\n");
			await values.fixture.write("filtered.flt", "base\n");
			await values.fixture.write(".gitattributes", "*.flt filter=evil\n");
			await values.fixture.write(".gitignore", "ignored.bin\n");
			await values.fixture.run("git", ["add", "."]);
			await values.fixture.run("git", ["commit", "-m", "candidate base"]);
			await values.fixture.run("git", ["config", "filter.evil.clean", `touch ${marker}; cat`]);
			await writeFile(join(values.fixture.root, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${hookMarker}\n`, "utf8");
			await chmod(join(values.fixture.root, ".git", "hooks", "pre-commit"), 0o755);
			await values.fixture.write("README.md", "edited\n");
			await values.fixture.write("filtered.flt", "changed\n");
			await values.fixture.write("new.txt", "new\n");
			await writeFile(join(values.fixture.root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
			await writeFile(join(values.fixture.root, "ignored.bin"), Buffer.from([9, 9, 9]));
			await unlink(join(values.fixture.root, "delete.txt"));
			await chmod(join(values.fixture.root, "mode.sh"), 0o755);
			await symlink("README.md", join(values.fixture.root, "link"));
			await values.fixture.write("sub/value.txt", "two\n");
			await values.fixture.run("git", ["-C", "sub", "add", "."]);
			await values.fixture.run("git", ["-C", "sub", "commit", "-m", "advance"]);
			const headBefore = (await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim();
			const indexBefore = (await values.fixture.run("git", ["write-tree"])).stdout.trim();
			const normalization = await values.normalizer.runExactlyTwoPasses();
			const candidate = await values.trees.sealCandidate({
				normalization,
				approvedDesignId: "c".repeat(64),
				behaviorContractId: "d".repeat(64),
			});
			expect(candidate.kind).toBe("git");
			if (candidate.kind !== "git") throw new Error("expected Git candidate");
			expect(candidate.changedPathsDigest).toBe(
				changedPathsDigest([
					"README.md",
					"binary.bin",
					"delete.txt",
					"filtered.flt",
					"link",
					"mode.sh",
					"new.txt",
					"sub",
				]),
			);
			expect((await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
			expect((await values.fixture.run("git", ["write-tree"])).stdout.trim()).toBe(indexBefore);
			await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
			const tree = (await values.fixture.run("git", ["ls-tree", "-r", candidate.treeOid])).stdout;
			expect(tree).toContain("100755 blob");
			expect(tree).toContain("120000 blob");
			expect(tree).toContain("160000 commit");
			await values.authority.cancel("done", "2026-08-25T00:00:02.000Z");
		} finally {
			await values.fixture.cleanup();
		}
	}, 15_000);

	const jjIt = jjAvailability.available ? it : it.skip;
	for (const kind of ["jj-native", "jj-colocated"] as const) {
		jjIt(`seals ${kind} through jj commands only (${jjAvailability.diagnostic})`, async () => {
			const values = await setup(kind);
			try {
				await values.fixture.write("delete.txt", "delete\n");
				await values.fixture.write("mode.sh", "#!/bin/sh\nexit 0\n");
				await values.fixture.run("jj", ["commit", "-m", "candidate base"]);
				await values.fixture.write("README.md", `${kind} edited\n`);
				await values.fixture.write("new.txt", "new\n");
				await unlink(join(values.fixture.root, "delete.txt"));
				await chmod(join(values.fixture.root, "mode.sh"), 0o755);
				await symlink("README.md", join(values.fixture.root, "link"));
				values.commands.length = 0;
				const normalization = await values.normalizer.runExactlyTwoPasses();
				const candidate = await values.trees.sealCandidate({
					normalization,
					approvedDesignId: "c".repeat(64),
					behaviorContractId: "d".repeat(64),
				});
				expect(candidate.kind).toBe("jj");
				if (candidate.kind !== "jj") throw new Error("expected Jujutsu candidate");
				expect(candidate.treeDigest).toMatch(/^[0-9a-f]{64}$/);
				expect(candidate.changedPathsDigest).toBe(
					changedPathsDigest(["README.md", "delete.txt", "link", "mode.sh", "new.txt"]),
				);
				expect(values.commands.every((entry) => entry.command === "jj")).toBe(true);
				await values.authority.cancel("done", "2026-08-25T00:00:02.000Z");
			} finally {
				await values.fixture.cleanup();
			}
		});
	}
});
