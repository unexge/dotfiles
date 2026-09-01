import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
	lstat,
	mkdir,
	readFile,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner } from "../src/vcs/types.ts";
import { WorkspaceBoundary } from "../src/workspace/boundary.ts";
import { MutationPhase } from "../src/workspace/mutation-phase.ts";
import { createWorkspaceTools, type WorkspaceOperations } from "../src/workspace/tools.ts";
import { createRepositoryFixture, isolatedVcsEnvironment } from "./helpers/repositories.ts";

const executeFile = promisify(execFile);

const runner: CommandRunner = async (command, args, options) => {
	try {
		const result = await executeFile(command, [...args], {
			cwd: options.cwd,
			env: isolatedVcsEnvironment(tmpdir()),
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

async function execute(tool: ToolDefinition, input: unknown, signal?: AbortSignal) {
	return tool.execute("test", input as never, signal, () => undefined, undefined as never);
}

function sha(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

async function workspace() {
	const fixture = await createRepositoryFixture("git");
	const boundary = await WorkspaceBoundary.open(await detectRepository(fixture.root, runner), runner);
	return { fixture, boundary };
}

describe("workspace tools", () => {
	it("reads, searches, writes, and seals exact mutation digests", async () => {
		const { fixture, boundary } = await workspace();
		try {
			await fixture.write(".gitignore", "ignored.txt\n");
			await fixture.write("src.ts", "const value = 1;\n");
			const phase = new MutationPhase("implement");
			const tools = createWorkspaceTools(boundary, phase);
			await execute(tools.write, { path: "nested/new.ts", content: "needle\n" });
			const read = await execute(tools.read, { path: "nested/new.ts" });
			expect(read.content[0]).toMatchObject({ text: "needle\n" });
			const search = await execute(tools.search, { query: "needle", path: "nested" });
			expect(search.content[0]).toMatchObject({ text: "nested/new.ts:1:needle" });
			await expect(execute(tools.write, { path: "ignored.txt", content: "secret" })).rejects.toThrow("ignored");
			const completed = phase.complete();
			expect(completed.mutations).toEqual([
				{
					path: "nested/new.ts",
					preimageDigest: null,
					resultDigest: sha("needle\n"),
				},
			]);
			expect(completed.mutationDigest).toMatch(/^[0-9a-f]{64}$/);
			expect(phase.complete()).toBe(completed);
			expect(Object.isFrozen(completed.mutations)).toBe(true);
			await expect(execute(tools.write, { path: "after.ts", content: "late" })).rejects.toThrow("sealed");
		} finally {
			await fixture.cleanup();
		}
	});

	it("serializes concurrent same-file edits through Pi's shared queue", async () => {
		const { fixture, boundary } = await workspace();
		try {
			await fixture.write("counter.txt", "value=0\n");
			const phase = new MutationPhase("repair");
			const tools = createWorkspaceTools(boundary, phase);
			const first = execute(tools.edit, {
				path: "counter.txt",
				edits: [{ oldText: "value=0", newText: "value=1" }],
			});
			const second = execute(tools.edit, {
				path: "counter.txt",
				edits: [{ oldText: "value=1", newText: "value=2" }],
			});
			await Promise.all([first, second]);
			expect(await readFile(join(fixture.root, "counter.txt"), "utf8")).toBe("value=2\n");
			expect(phase.complete().mutations).toEqual([
				{
					path: "counter.txt",
					preimageDigest: sha("value=0\n"),
					resultDigest: sha("value=2\n"),
				},
			]);
		} finally {
			await fixture.cleanup();
		}
	});

	it("rejects nonunique, overlapping, binary, and missing-file edits", async () => {
		const { fixture, boundary } = await workspace();
		try {
			await fixture.write("repeat.txt", "aaa");
			await fixture.write("overlap.txt", "abcdef");
			await fixture.write("multiple.txt", "left middle right");
			await writeFile(join(fixture.root, "binary"), Buffer.from([0, 1, 2]));
			await writeFile(join(fixture.root, "huge"), "x");
			await truncate(join(fixture.root, "huge"), 11 * 1024 * 1024);
			const tools = createWorkspaceTools(boundary, new MutationPhase("implement"));
			await expect(
				execute(tools.edit, { path: "repeat.txt", edits: [{ oldText: "aa", newText: "b" }] }),
			).rejects.toThrow("not unique");
			await expect(
				execute(tools.edit, {
					path: "overlap.txt",
					edits: [
						{ oldText: "abc", newText: "x" },
						{ oldText: "bcd", newText: "y" },
					],
				}),
			).rejects.toThrow("overlap");
			await execute(tools.edit, {
				path: "multiple.txt",
				edits: [
					{ oldText: "left", newText: "L" },
					{ oldText: "right", newText: "R" },
				],
			});
			expect(await readFile(join(fixture.root, "multiple.txt"), "utf8")).toBe("L middle R");
			await expect(execute(tools.read, { path: "binary" })).rejects.toThrow("binary");
			await expect(execute(tools.read, { path: "huge" })).rejects.toThrow("exceeds 10MB");
			await expect(
				execute(tools.edit, { path: "missing.txt", edits: [{ oldText: "x", newText: "y" }] }),
			).rejects.toThrow("missing");
		} finally {
			await fixture.cleanup();
		}
	});

	it("detects bytes changed outside the shared mutation queue", async () => {
		const { fixture, boundary } = await workspace();
		try {
			await fixture.write("drift.txt", "before\n");
			const phase = new MutationPhase("implement");
			const tools = createWorkspaceTools(boundary, phase);
			await execute(tools.write, { path: "drift.txt", content: "first\n" });
			await fixture.write("drift.txt", "outside\n");
			await expect(execute(tools.write, { path: "drift.txt", content: "second\n" })).rejects.toThrow(
				"outside the mutation queue",
			);
			expect(phase.requiresManualInspection()).toBe(true);
		} finally {
			await fixture.cleanup();
		}
	});

	it("leaves possibly written bytes untouched and requires manual inspection", async () => {
		const { fixture, boundary } = await workspace();
		try {
			await fixture.write("partial.txt", "before\n");
			const operations: WorkspaceOperations = {
				readFile,
				lstat,
				mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
				writeFile: async (path, content) => {
					await writeFile(path, content);
					throw new Error("simulated process interruption");
				},
			};
			const phase = new MutationPhase("implement");
			const tools = createWorkspaceTools(boundary, phase, operations);
			await expect(execute(tools.write, { path: "partial.txt", content: "after\n" })).rejects.toThrow(
				"simulated process interruption",
			);
			expect(await readFile(join(fixture.root, "partial.txt"), "utf8")).toBe("after\n");
			expect(phase.requiresManualInspection()).toBe(true);
			expect(() => phase.complete()).toThrow("manual inspection");
			await expect(execute(tools.write, { path: "other.txt", content: "blocked" })).rejects.toThrow(
				"manual inspection",
			);
		} finally {
			await fixture.cleanup();
		}
	});
});
