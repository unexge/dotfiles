import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner } from "../src/vcs/types.ts";
import { WorkspaceBoundary, WorkspaceBoundaryError } from "../src/workspace/boundary.ts";
import {
	createRepositoryFixture,
	detectJjAvailability,
	isolatedVcsEnvironment,
	type RepositoryFixtureKind,
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

async function verifyBackend(kind: RepositoryFixtureKind): Promise<void> {
	const fixture = await createRepositoryFixture(kind);
	try {
		await fixture.write(".gitignore", "ignored*\ncache/\nREADME.md\n");
		await fixture.write("ignored-existing", "secret\n");
		await fixture.write("visible-new.ts", "visible\n");
		const repository = await detectRepository(fixture.root, runner);
		const boundary = await WorkspaceBoundary.open(repository, runner);
		await expect(boundary.admit("README.md")).resolves.toMatchObject({ relative: "README.md" });
		await expect(boundary.admit("allowed-new.ts")).resolves.toMatchObject({ relative: "allowed-new.ts" });
		await expect(boundary.admit("ignored-existing")).rejects.toThrow("ignored");
		await expect(boundary.admit("ignored-new")).rejects.toThrow("ignored");
		await expect(boundary.admit("cache/new.ts")).rejects.toThrow("ignored");
		const searchable = (await boundary.searchableFiles()).map((path) => path.relative);
		expect(searchable).toContain("README.md");
		expect(searchable).toContain("visible-new.ts");
		expect(searchable).not.toContain("ignored-existing");
		expect(searchable.some((path) => path.startsWith(".git/") || path.startsWith(".jj/"))).toBe(false);
	} finally {
		await fixture.cleanup();
	}
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace boundary", () => {
	it("uses Git ignore and tracked-file semantics", async () => verifyBackend("git"));
	const jjIt = jjAvailability.available ? it : it.skip;
	jjIt(`uses native Jujutsu ignore and tracked-file semantics (${jjAvailability.diagnostic})`, async () =>
		verifyBackend("jj-native"),
	);
	jjIt(`uses colocated Jujutsu ignore and tracked-file semantics (${jjAvailability.diagnostic})`, async () =>
		verifyBackend("jj-colocated"),
	);

	it("rejects traversal, metadata, deep-work artifacts, and NUL", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			const boundary = await WorkspaceBoundary.open(await detectRepository(fixture.root, runner), runner);
			for (const path of [
				join(fixture.root, "README.md"),
				"../escape",
				"a/../../escape",
				".git/config",
				".GIT/config",
				".jj/repo/store",
				".pi/pi-deep-work/state.json",
				".pi/deep-work/state.json",
				".deep-work/state.json",
				"nul\0path",
			]) {
				await expect(boundary.admit(path)).rejects.toBeInstanceOf(WorkspaceBoundaryError);
			}
		} finally {
			await fixture.cleanup();
		}
	});

	it("rejects existing targets and new descendants through symlinks", async () => {
		const fixture = await createRepositoryFixture("git");
		const outside = await mkdtemp(join(tmpdir(), "pi-deep-workspace-outside-"));
		temporary.push(outside);
		try {
			await writeFile(join(outside, "secret"), "secret", "utf8");
			await symlink(join(outside, "secret"), join(fixture.root, "file-link"));
			await symlink(outside, join(fixture.root, "dir-link"));
			const boundary = await WorkspaceBoundary.open(await detectRepository(fixture.root, runner), runner);
			await expect(boundary.admit("file-link")).rejects.toThrow("symlink");
			await expect(boundary.admit("dir-link/new.ts")).rejects.toThrow("symlink");
			await expect(boundary.admit("dir-link/missing/child.ts")).rejects.toThrow("symlink");
		} finally {
			await fixture.cleanup();
		}
	});

	it("uses one mutation queue key for case and Unicode normalization aliases", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			const boundary = await WorkspaceBoundary.open(await detectRepository(fixture.root, runner), runner);
			expect(boundary.mutationQueueKey("Source/Café.ts")).toBe(boundary.mutationQueueKey("source/Cafe\u0301.ts"));
		} finally {
			await fixture.cleanup();
		}
	});

	it("rejects traversal through a non-directory ancestor", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			const boundary = await WorkspaceBoundary.open(await detectRepository(fixture.root, runner), runner);
			await expect(boundary.admit("README.md/child")).rejects.toThrow("non-directory");
		} finally {
			await fixture.cleanup();
		}
	});
});
