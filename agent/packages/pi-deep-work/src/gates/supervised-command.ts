import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const supervisorPath = fileURLToPath(new URL("./command-supervisor.mjs", import.meta.url));
const maxOutputBytes = 10 * 1024 * 1024;
const sensitiveEnvironmentName = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;
const injectedRuntimeEnvironment = new Set(["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV"]);

export function sanitizedGateEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(environment).filter(
			([name, value]) => value !== undefined && !sensitiveEnvironmentName.test(name) && !injectedRuntimeEnvironment.has(name),
		),
	);
}

export interface SupervisedCommandResult {
	stdout: Buffer;
	stderr: Buffer;
	stdoutComplete: boolean;
	stderrComplete: boolean;
	exitCode: number | null;
	terminationSignal: string | null;
	status: "exited" | "timed_out" | "cancelled" | "output_overflow" | "incomplete";
	diagnostic?: string;
}

function append(chunks: Buffer[], chunk: Buffer, size: number): { size: number; complete: boolean } {
	if (size >= maxOutputBytes) return { size, complete: false };
	const remaining = maxOutputBytes - size;
	chunks.push(chunk.subarray(0, remaining));
	return { size: size + Math.min(chunk.length, remaining), complete: chunk.length <= remaining };
}

export async function runSupervisedCommand(
	argv: readonly [string, ...string[]],
	cwd: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<SupervisedCommandResult> {
	const payload = Buffer.from(JSON.stringify({ command: argv[0], args: argv.slice(1), cwd })).toString("base64url");
	const supervisor = spawn(process.execPath, [supervisorPath, payload], {
		cwd,
		env: sanitizedGateEnvironment(),
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let stdoutSize = 0;
	let stderrSize = 0;
	let stdoutComplete = true;
	let stderrComplete = true;
	let childPid: number | undefined;
	let result: { code: number | null; signal: string | null } | undefined;
	let diagnostic: string | undefined;
	let requested: SupervisedCommandResult["status"] | undefined;
	let fallback: NodeJS.Timeout | undefined;

	const terminate = (status: SupervisedCommandResult["status"]) => {
		requested ??= status;
		if (supervisor.connected) supervisor.send({ type: "terminate" });
		fallback ??= setTimeout(() => {
			if (childPid) {
				try {
					process.kill(-childPid, "SIGKILL");
				} catch {}
			}
			supervisor.kill("SIGKILL");
		}, 1500);
		fallback.unref();
	};
	const abort = () => terminate("cancelled");
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const timeout = setTimeout(() => terminate("timed_out"), timeoutMs);
	timeout.unref();

	supervisor.stdout!.on("data", (value: Buffer) => {
		const appended = append(stdout, value, stdoutSize);
		stdoutSize = appended.size;
		stdoutComplete &&= appended.complete;
		if (!appended.complete) terminate("output_overflow");
	});
	supervisor.stderr!.on("data", (value: Buffer) => {
		const appended = append(stderr, value, stderrSize);
		stderrSize = appended.size;
		stderrComplete &&= appended.complete;
		if (!appended.complete) terminate("output_overflow");
	});
	supervisor.on("message", (message: unknown) => {
		if (!message || typeof message !== "object" || !("type" in message)) return;
		const value = message as { type: string; pid?: number; code?: number | null; signal?: string | null; message?: string };
		if (value.type === "started") childPid = value.pid;
		else if (value.type === "result") result = { code: value.code ?? null, signal: value.signal ?? null };
		else if (value.type === "spawn-error") diagnostic = value.message ?? "command spawn failed";
	});
	const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		supervisor.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
		supervisor.once("error", (error) => {
			diagnostic = error.message;
		});
	});
	clearTimeout(timeout);
	if (fallback) clearTimeout(fallback);
	signal.removeEventListener("abort", abort);
	const status = requested ?? (diagnostic ? "incomplete" : result ? "exited" : "incomplete");
	return {
		stdout: Buffer.concat(stdout),
		stderr: Buffer.concat(stderr),
		stdoutComplete,
		stderrComplete,
		exitCode: result?.code ?? null,
		terminationSignal: result?.signal ?? close.signal,
		status,
		...(diagnostic ? { diagnostic } : {}),
	};
}
