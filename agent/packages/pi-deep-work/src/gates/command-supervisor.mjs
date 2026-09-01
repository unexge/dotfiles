import { spawn } from "node:child_process";

const payload = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
let child;
let killTimer;
let terminateRequested = false;
let terminating = false;

function send(message) {
	if (process.connected) process.send(message);
}

function terminate() {
	terminateRequested = true;
	if (!child?.pid || child.exitCode !== null || terminating) return;
	terminating = true;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	killTimer = setTimeout(() => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, 500);
	killTimer.unref();
}

process.on("message", (message) => {
	if (message?.type === "terminate") terminate();
});
process.on("disconnect", terminate);

try {
	child = spawn(payload.command, payload.args, {
		cwd: payload.cwd,
		env: process.env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.pipe(process.stdout);
	child.stderr.pipe(process.stderr);
	child.once("spawn", () => {
		send({ type: "started", pid: child.pid });
		if (terminateRequested) terminate();
	});
	child.once("error", (error) => send({ type: "spawn-error", message: error.message }));
	child.once("close", (code, signal) => {
		if (killTimer) clearTimeout(killTimer);
		send({ type: "result", code, signal });
		if (process.connected) process.disconnect();
	});
} catch (error) {
	send({ type: "spawn-error", message: error instanceof Error ? error.message : String(error) });
	if (process.connected) process.disconnect();
}
