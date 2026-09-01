import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner } from "../src/vcs/types.ts";
import { VcsDetectionError } from "../src/vcs/types.ts";
import {
	createRepositoryFixture,
	detectJjAvailability,
	isolatedVcsEnvironment,
} from "./helpers/repositories.ts";

const executeFile = promisify(execFile);
const temporary: string[] = [];
const jjAvailability = await detectJjAvailability();

const runner: CommandRunner = async (command, args, options) => {
	try {
		const result = await executeFile(command, [...args], {
			cwd: options.cwd,
			env: isolatedVcsEnvironment(tmpdir()),
			timeout: options.timeoutMs,
			signal: options.signal,
			maxBuffer: 10 * 1024 * 1024,
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

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("VCS detection", () => {
	it("selects plain Git only when no Jujutsu metadata exists", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			const repository = await detectRepository(fixture.root, runner);
			expect(repository).toMatchObject({ kind: "git", root: fixture.root });
			expect(repository.repositoryId).toMatch(/^[0-9a-f]{64}$/);
			expect(repository.sharedRoot).toBe(await fixture.sharedRepositoryIdentity());
		} finally {
			await fixture.cleanup();
		}
	});

	const jjIt = jjAvailability.available ? it : it.skip;
	jjIt(`selects native Jujutsu (${jjAvailability.diagnostic})`, async () => {
		const fixture = await createRepositoryFixture("jj-native");
		try {
			const repository = await detectRepository(fixture.root, runner);
			expect(repository).toMatchObject({ kind: "jj", root: fixture.root, workspaceId: "default" });
			expect(repository.sharedRoot).toBe(await fixture.sharedRepositoryIdentity());
		} finally {
			await fixture.cleanup();
		}
	});

	jjIt(`does not snapshot Jujutsu working-copy changes during detection (${jjAvailability.diagnostic})`, async () => {
		const fixture = await createRepositoryFixture("jj-native");
		try {
			await fixture.write("unsnapshotted.txt", "pending\n");
			const before = (
				await fixture.run("jj", ["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"])
			).stdout;
			await detectRepository(fixture.root, runner);
			const after = (
				await fixture.run("jj", ["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"])
			).stdout;
			expect(after).toBe(before);
		} finally {
			await fixture.cleanup();
		}
	});

	jjIt(`canonicalizes symlinked Jujutsu workspace paths (${jjAvailability.diagnostic})`, async () => {
		const fixture = await createRepositoryFixture("jj-native");
		const alias = join(fixture.root, "..", "jj-alias");
		try {
			await symlink(fixture.root, alias);
			const repository = await detectRepository(alias, runner);
			expect(repository).toMatchObject({ kind: "jj", root: fixture.root, workspaceId: "default" });
		} finally {
			await fixture.cleanup();
		}
	});

	jjIt(`selects Jujutsu in a colocated repository (${jjAvailability.diagnostic})`, async () => {
		const fixture = await createRepositoryFixture("jj-colocated");
		try {
			const repository = await detectRepository(fixture.root, runner);
			expect(repository.kind).toBe("jj");
			expect(repository.sharedRoot).toBe(await fixture.sharedRepositoryIdentity());
		} finally {
			await fixture.cleanup();
		}
	});

	it("uses one Git repository identity across linked worktrees", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			const sibling = join(fixture.root, "..", "linked-git");
			await fixture.run("git", ["worktree", "add", "-b", "linked", sibling]);
			const primary = await detectRepository(fixture.root, runner);
			const linked = await detectRepository(sibling, runner);
			expect(primary.root).not.toBe(linked.root);
			expect(primary.repositoryId).toBe(linked.repositoryId);
			expect(primary.sharedRoot).toBe(linked.sharedRoot);
		} finally {
			await fixture.cleanup();
		}
	});

	jjIt(`uses one Jujutsu repository identity across workspaces (${jjAvailability.diagnostic})`, async () => {
		const fixture = await createRepositoryFixture("jj-native");
		try {
			const sibling = join(fixture.root, "..", "linked-jj");
			await fixture.run("jj", ["workspace", "add", "--name", "sibling", sibling]);
			const primary = await detectRepository(fixture.root, runner);
			const linked = await detectRepository(sibling, runner);
			expect(primary.root).not.toBe(linked.root);
			expect(primary.repositoryId).toBe(linked.repositoryId);
			expect(primary.sharedRoot).toBe(linked.sharedRoot);
			expect(linked).toMatchObject({ kind: "jj", workspaceId: "sibling" });
		} finally {
			await fixture.cleanup();
		}
	});

	it("blocks broken Jujutsu metadata instead of falling back to Git", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-broken-jj-"));
		temporary.push(root);
		await runner("git", ["init", "-b", "main"], { cwd: root });
		await mkdir(join(root, ".jj"));
		const noJj: CommandRunner = async (command, args, options) => {
			if (command === "jj") return { code: 1, stdout: "", stderr: "missing", errorCode: "ENOENT" };
			return runner(command, args, options);
		};
		await expect(detectRepository(root, noJj)).rejects.toThrow("jj binary is not installed");
		const corruptJj: CommandRunner = async (command, args, options) => {
			if (command === "jj") return { code: 2, stdout: "", stderr: "corrupt workspace metadata" };
			return runner(command, args, options);
		};
		await expect(detectRepository(root, corruptJj)).rejects.toThrow("corrupt workspace metadata");
	});

	it("rejects directories outside either backend", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-no-vcs-"));
		temporary.push(root);
		await expect(detectRepository(root, runner)).rejects.toMatchObject({
			name: "VcsDetectionError",
			code: "not_repository",
		});
		const noGit: CommandRunner = async () => ({
			code: 1,
			stdout: "",
			stderr: "spawn git ENOENT",
			errorCode: "ENOENT",
		});
		await expect(detectRepository(root, noGit)).rejects.toMatchObject({
			name: "VcsDetectionError",
			code: "probe_failed",
			message: "git binary is not installed",
		});
		await expect(detectRepository(join(root, "missing"), runner)).rejects.toMatchObject({
			name: "VcsDetectionError",
			code: "probe_failed",
		});
	});
});
