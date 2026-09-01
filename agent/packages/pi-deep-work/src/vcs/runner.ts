import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandRunner } from "./types.ts";

const executeFile = promisify(execFile);

export const commandRunner: CommandRunner = async (command, args, options) => {
	try {
		const result = await executeFile(command, [...args], {
			cwd: options.cwd,
			// Only package/catalog-owned argv reaches this runner; explicit transaction env overrides are merged without a shell.
			env: { ...process.env, ...options.env },
			signal: options.signal,
			timeout: options.timeoutMs,
			maxBuffer: 20 * 1024 * 1024,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const failure = error as Error & {
			code?: string | number;
			stdout?: string;
			stderr?: string;
		};
		return {
			code: typeof failure.code === "number" ? failure.code : 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message,
			errorCode: typeof failure.code === "string" ? failure.code : undefined,
		};
	}
};
