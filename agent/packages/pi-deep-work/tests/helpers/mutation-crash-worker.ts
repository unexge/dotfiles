import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { detectRepository } from "../../src/vcs/detect.ts";
import type { CommandRunner } from "../../src/vcs/types.ts";
import { WorkspaceBoundary } from "../../src/workspace/boundary.ts";
import { MutationPhase } from "../../src/workspace/mutation-phase.ts";
import { createWorkspaceTools, type WorkspaceOperations } from "../../src/workspace/tools.ts";

const executeFile = promisify(execFile);
const [root] = process.argv.slice(2);
const runner: CommandRunner = async (command, args, options) => {
	try {
		const result = await executeFile(command, [...args], {
			cwd: options.cwd,
			env: process.env,
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

const repository = await detectRepository(root, runner);
const boundary = await WorkspaceBoundary.open(repository, runner);
const operations: WorkspaceOperations = {
	readFile,
	lstat,
	mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
	writeFile: async (path, content) => {
		await writeFile(path, content);
		process.stdout.write("written\n");
		await new Promise(() => undefined);
	},
};
const tools = createWorkspaceTools(boundary, new MutationPhase("implement"), operations);
await tools.write.execute(
	"crash",
	{ path: "README.md", content: "partial mutation\n" },
	undefined,
	() => undefined,
	undefined as never,
);
