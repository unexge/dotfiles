import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSupervisedCommand, sanitizedGateEnvironment } from "../src/gates/supervised-command.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("supervised gate command", () => {
	it("removes credentials and runtime injection from the child environment", () => {
		expect(
			sanitizedGateEnvironment({
				PATH: "/bin",
				DEEP_API_KEY: "secret",
				AWS_SESSION_TOKEN: "secret",
				NODE_OPTIONS: "--require evil",
				VISIBLE_BUILD_FLAG: "yes",
			}),
		).toEqual({ PATH: "/bin", VISIBLE_BUILD_FLAG: "yes" });
	});

	it("captures complete stdout, stderr, and exit status", async () => {
		const result = await runSupervisedCommand(
			[process.execPath, "-e", 'process.stdout.write("out"); process.stderr.write("err")'],
			process.cwd(),
			5_000,
			new AbortController().signal,
		);
		expect(result).toMatchObject({
			status: "exited",
			exitCode: 0,
			stdoutComplete: true,
			stderrComplete: true,
		});
		expect(result.stdout.toString()).toBe("out");
		expect(result.stderr.toString()).toBe("err");
	});

	it("escalates an uncooperative timeout to SIGKILL", async () => {
		const started = Date.now();
		const result = await runSupervisedCommand(
			[process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
			process.cwd(),
			1_000,
			new AbortController().signal,
		);
		expect(result.status).toBe("timed_out");
		expect(result.terminationSignal).toBe("SIGKILL");
		expect(Date.now() - started).toBeLessThan(4_000);
	});

	it("bounds output and marks it incomplete", async () => {
		const result = await runSupervisedCommand(
			[process.execPath, "-e", "process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 120))"],
			process.cwd(),
			5_000,
			new AbortController().signal,
		);
		expect(result.status).toBe("output_overflow");
		expect(result.stdoutComplete).toBe(false);
		expect(result.stdout.length).toBe(10 * 1024 * 1024);
	});

	it("kills the command group when the coordinator process dies", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-gate-death-"));
		temporary.push(root);
		const started = join(root, "started");
		const late = join(root, "late");
		const worker = spawn(
			process.execPath,
			[join(import.meta.dirname, "helpers", "gate-coordinator-worker.ts"), started, late],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const exit = new Promise((resolve) => worker.once("exit", resolve));
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await access(started);
				break;
			} catch {
				if (attempt === 99) throw new Error("Gate command did not start");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		worker.kill("SIGKILL");
		await exit;
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		await expect(access(late)).rejects.toMatchObject({ code: "ENOENT" });
	}, 10_000);

	it("latches cancellation that arrives before the child spawn event", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-gate-early-cancel-"));
		temporary.push(root);
		const late = join(root, "late");
		const controller = new AbortController();
		controller.abort(new Error("early cancel"));
		const result = await runSupervisedCommand(
			[
				process.execPath,
				"-e",
				`setTimeout(() => require("fs").writeFileSync(${JSON.stringify(late)}, "late"), 750)`,
			],
			process.cwd(),
			5_000,
			controller.signal,
		);
		expect(result.status).toBe("cancelled");
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		await expect(access(late)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("settles cancellation without replacing its classification", async () => {
		const controller = new AbortController();
		const running = runSupervisedCommand(
			[process.execPath, "-e", "setInterval(() => {}, 1000)"],
			process.cwd(),
			10_000,
			controller.signal,
		);
		setTimeout(() => controller.abort(new Error("cancel")), 100).unref();
		expect((await running).status).toBe("cancelled");
	});
});
