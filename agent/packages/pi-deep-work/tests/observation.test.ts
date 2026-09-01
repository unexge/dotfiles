import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureGitObservation, gitStatus, resolveGitRevision } from "../src/vcs/git-backend.ts";
import { captureJjObservation, jjStatus, resolveJjRevision } from "../src/vcs/jj-backend.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner, GitRepository, JjRepository } from "../src/vcs/types.ts";
import {
	createRepositoryFixture,
	detectJjAvailability,
	isolatedVcsEnvironment,
	type RepositoryFixture,
} from "./helpers/repositories.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const executeFile = promisify(execFile);
const policyDigest = "a".repeat(64);
const jjAvailability = await detectJjAvailability();

const runner: CommandRunner = async (command, args, options) => {
	try {
		const result = await executeFile(command, [...args], {
			cwd: options.cwd,
			env: isolatedVcsEnvironment(tmpdir()),
			signal: options.signal,
			timeout: options.timeoutMs,
			maxBuffer: 20 * 1024 * 1024,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
		return {
			code: typeof failure.code === "number" ? failure.code : 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message,
			errorCode: typeof failure.code === "string" ? failure.code : undefined,
		};
	}
};

async function addIgnoreFile(fixture: RepositoryFixture): Promise<void> {
	await fixture.write(".gitignore", "target/\n");
	if (fixture.kind === "git") {
		await fixture.run("git", ["add", ".gitignore"]);
		await fixture.run("git", ["commit", "-m", "ignore target"]);
	} else {
		await fixture.run("jj", ["commit", "-m", "ignore target"]);
	}
}

describe("revision resolution argv", () => {
	it("rejects option-like Git selectors and contains Jujutsu revsets in one argument", async () => {
		const calls: Array<{ command: string; args: readonly string[] }> = [];
		const capturingRunner: CommandRunner = async (command, args) => {
			calls.push({ command, args });
			return { code: 0, stdout: `${command === "git" ? "1".repeat(40) : "2".repeat(64)}\n`, stderr: "" };
		};
		const gitRepository: GitRepository = {
			kind: "git",
			root: "/repo",
			sharedRoot: "/repo/.git",
			commonDir: "/repo/.git",
			repositoryId: "a".repeat(64),
		};
		const jjRepository: JjRepository = {
			kind: "jj",
			root: "/repo",
			sharedRoot: "/repo/.jj/repo",
			gitStore: "/repo/.jj/repo/store/git",
			workspaceId: "default",
			repositoryId: "b".repeat(64),
		};
		await expect(resolveGitRevision(gitRepository, "--help", capturingRunner)).rejects.toThrow(
			"Invalid Git revision selector",
		);
		await resolveGitRevision(gitRepository, "HEAD", capturingRunner);
		await resolveJjRevision(jjRepository, "--help", capturingRunner);
		expect(calls[0]).toMatchObject({
			command: "git",
			args: ["rev-parse", "--verify", "HEAD^{commit}"],
		});
		expect(calls[1]).toMatchObject({
			command: "jj",
			args: ["--ignore-working-copy", "log", "--revisions=--help", "--no-graph", "-T", 'commit_id ++ "\\n"'],
		});
	});
});

describe("Git observation subjects", () => {
	it("tracks staged, unstaged, untracked, deleted, mode, and symlink changes", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			const repository = await detectRepository(fixture.root, runner);
			if (repository.kind !== "git") throw new Error("expected Git");
			await addIgnoreFile(fixture);
			const clean = await captureGitObservation(repository, policyDigest, runner);
			expect((await gitStatus(repository, runner)).clean).toBe(true);
			await fixture.run("git", ["config", "diff.algorithm", "minimal"]);
			await fixture.run("git", ["config", "core.quotepath", "true"]);
			expect(await captureGitObservation(repository, policyDigest, runner)).toEqual(clean);
			expect((await captureGitObservation(repository, "b".repeat(64), runner)).policyDigest).not.toBe(
				clean.policyDigest,
			);
			expect(await captureGitObservation(repository, policyDigest, runner)).toEqual(clean);

			await mkdir(join(fixture.root, "target"));
			await writeFile(join(fixture.root, "target/cache"), "ignored");
			expect(await captureGitObservation(repository, policyDigest, runner)).toEqual(clean);

			await fixture.write("README.md", "unstaged\n");
			const unstaged = await captureGitObservation(repository, policyDigest, runner);
			expect(unstaged.workingDigest).not.toBe(clean.workingDigest);
			expect((await gitStatus(repository, runner)).changedPaths).toContain("README.md");

			await fixture.run("git", ["add", "README.md"]);
			const staged = await captureGitObservation(repository, policyDigest, runner);
			if (clean.conflicted || staged.conflicted) throw new Error("expected conflict-free Git subjects");
			expect(staged.indexTree).not.toBe(clean.indexTree);
			await fixture.write("README.md", "git\n");
			const stagedWithRevertedWorktree = await gitStatus(repository, runner);
			expect(stagedWithRevertedWorktree.clean).toBe(false);
			expect(stagedWithRevertedWorktree.changedPaths).toContain("README.md");

			await fixture.write("new.bin", "\0binary\n");
			await fixture.write("line\nbreak.txt", "unusual path\n");
			const untracked = await captureGitObservation(repository, policyDigest, runner);
			expect(untracked.changedPathsDigest).not.toBe(staged.changedPathsDigest);

			await rm(join(fixture.root, "README.md"));
			await writeFile(join(fixture.root, "script.sh"), "#!/bin/sh\n");
			await chmod(join(fixture.root, "script.sh"), 0o755);
			await symlink("script.sh", join(fixture.root, "script-link"));
			const mixed = await captureGitObservation(repository, policyDigest, runner);
			expect(mixed.workingDigest).not.toBe(untracked.workingDigest);
			expect((await gitStatus(repository, runner)).changedPaths).toEqual(
				expect.arrayContaining(["README.md", "new.bin", "line\nbreak.txt", "script.sh", "script-link"]),
			);
			expect(await resolveGitRevision(repository, "HEAD", runner)).toBe(clean.headOid);
		} finally {
			await fixture.cleanup();
		}
	}, 15_000);

	it("captures an unmerged index without fabricating an index tree", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			await fixture.run("git", ["checkout", "-b", "side"]);
			await fixture.write("README.md", "side\n");
			await fixture.run("git", ["commit", "-am", "side"]);
			await fixture.run("git", ["checkout", "main"]);
			await fixture.write("README.md", "main\n");
			await fixture.run("git", ["commit", "-am", "main"]);
			const merge = await runner("git", ["merge", "side"], { cwd: fixture.root });
			expect(merge.code).not.toBe(0);
			const repository = await detectRepository(fixture.root, runner);
			if (repository.kind !== "git") throw new Error("expected Git");
			expect((await gitStatus(repository, runner)).conflicted).toBe(true);
			const subject = await captureGitObservation(repository, policyDigest, runner);
			expect(subject).toMatchObject({ kind: "git", conflicted: true });
			if (!subject.conflicted) throw new Error("expected conflicted subject");
			expect(subject.indexEntriesDigest).toMatch(/^[0-9a-f]{64}$/);
			expect("indexTree" in subject).toBe(false);
		} finally {
			await fixture.cleanup();
		}
	});
});

const jjIt = jjAvailability.available ? it : it.skip;

describe("Jujutsu observation subjects", () => {
	jjIt(`forces snapshots and ignores ignored-only churn (${jjAvailability.diagnostic})`, async () => {
		const fixture = await createRepositoryFixture("jj-native");
		try {
			const repository = await detectRepository(fixture.root, runner);
			if (repository.kind !== "jj") throw new Error("expected Jujutsu");
			await addIgnoreFile(fixture);
			const clean = await captureJjObservation(repository, policyDigest, runner);
			expect((await jjStatus(repository, runner)).clean).toBe(true);
			expect((await captureJjObservation(repository, "b".repeat(64), runner)).policyDigest).not.toBe(
				clean.policyDigest,
			);
			expect(await captureJjObservation(repository, policyDigest, runner)).toEqual(clean);

			await mkdir(join(fixture.root, "target"));
			await writeFile(join(fixture.root, "target/cache"), "ignored");
			expect(await captureJjObservation(repository, policyDigest, runner)).toEqual(clean);

			await fixture.write("README.md", "changed\n");
			const changed = await captureJjObservation(repository, policyDigest, runner);
			expect(changed.operationId).not.toBe(clean.operationId);
			expect(changed.commitId).not.toBe(clean.commitId);
			expect(changed.workingDigest).not.toBe(clean.workingDigest);
			expect((await jjStatus(repository, runner)).changedPaths).toContain("README.md");

			await rm(join(fixture.root, "README.md"));
			await fixture.write("new.bin", "\0binary\n");
			await fixture.write("line\nbreak.txt", "unusual path\n");
			await writeFile(join(fixture.root, "script.sh"), "#!/bin/sh\n");
			await chmod(join(fixture.root, "script.sh"), 0o755);
			await symlink("script.sh", join(fixture.root, "script-link"));
			const mixed = await captureJjObservation(repository, policyDigest, runner);
			expect(mixed.workingDigest).not.toBe(changed.workingDigest);
			expect((await jjStatus(repository, runner)).changedPaths).toEqual(
				expect.arrayContaining(["README.md", "new.bin", "line\nbreak.txt", "script.sh", "script-link"]),
			);
			expect(await resolveJjRevision(repository, "@", runner)).toBe(mixed.commitId);
		} finally {
			await fixture.cleanup();
		}
	}, 15_000);

	jjIt(`captures a real Jujutsu conflict (${jjAvailability.diagnostic})`, async () => {
		const fixture = await createRepositoryFixture("jj-native");
		try {
			const initial = (
				await fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
			).stdout.trim();
			await fixture.run("jj", ["new", initial]);
			await fixture.write("README.md", "left\n");
			await fixture.run("jj", ["commit", "-m", "left"]);
			const left = (
				await fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
			).stdout.trim();
			await fixture.run("jj", ["new", initial]);
			await fixture.write("README.md", "right\n");
			await fixture.run("jj", ["commit", "-m", "right"]);
			const right = (
				await fixture.run("jj", ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
			).stdout.trim();
			await fixture.run("jj", ["new", left, right]);
			const repository = await detectRepository(fixture.root, runner);
			if (repository.kind !== "jj") throw new Error("expected Jujutsu");
			expect((await jjStatus(repository, runner)).conflicted).toBe(true);
			expect(await captureJjObservation(repository, policyDigest, runner)).toMatchObject({ conflicted: true });
		} finally {
			await fixture.cleanup();
		}
	}, 15_000);
});
