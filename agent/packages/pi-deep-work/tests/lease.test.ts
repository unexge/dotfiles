import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { LeaseBusyError, LeaseRecoveryError, PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { createRepositoryFixture } from "./helpers/repositories.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner } from "../src/vcs/types.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const temporary: string[] = [];

const runner: CommandRunner = async (command, args, options) => {
	try {
		const result = await executeFile(command, [...args], { cwd: options.cwd, maxBuffer: 10 * 1024 * 1024 });
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

const request = (seed = "a") => ({
	scope: "repository" as const,
	repositoryId: seed.repeat(64),
	runId: randomUUID(),
	attemptId: randomUUID(),
});

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("portable lease", () => {
	it("allows one owner and verifies exact release", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-lease-"));
		temporary.push(agentDir);
		const first = new PortableLeaseManager(agentDir);
		const second = new PortableLeaseManager(agentDir);
		const leaseRequest = request("a");
		const handle = await first.acquire(leaseRequest);
		await expect(second.acquire(leaseRequest)).rejects.toBeInstanceOf(LeaseBusyError);
		expect((await first.inspect(handle.path)).status).toBe("live");
		await handle.release();
		expect((await first.inspect(handle.path)).status).toBe("available");
		expect(await second.acquire(leaseRequest)).toBeTruthy();
	});

	it("allows exactly one winner in a concurrent acquire race", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-race-lease-"));
		temporary.push(agentDir);
		const first = new PortableLeaseManager(agentDir);
		const second = new PortableLeaseManager(agentDir);
		const leaseRequest = request("1");
		const results = await Promise.allSettled([first.acquire(leaseRequest), second.acquire(leaseRequest)]);
		const winners = results.filter((result) => result.status === "fulfilled");
		expect(winners).toHaveLength(1);
		await (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof first.acquire>>>).value.release();
	});

	it("automatically reclaims only a positively dead valid owner", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-dead-lease-"));
		temporary.push(agentDir);
		const manager = new PortableLeaseManager(agentDir);
		const leaseRequest = request("b");
		const path = manager.pathFor(leaseRequest);
		await mkdir(path, { recursive: true });
		await writeFile(
			join(path, "owner.json"),
			JSON.stringify({
				schemaVersion: 1,
				scope: "repository",
				leaseId: leaseRequest.repositoryId,
				repositoryId: leaseRequest.repositoryId,
				runId: leaseRequest.runId,
				attemptId: leaseRequest.attemptId,
				pid: 999_999,
				token: randomUUID(),
				createdAt: new Date().toISOString(),
			}),
		);
		const handle = await manager.acquire(leaseRequest);
		expect(handle.owner.pid).toBe(process.pid);
		await handle.release();
	});

	it("fails closed when owner liveness is unknown", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-unknown-lease-"));
		temporary.push(agentDir);
		const writer = new PortableLeaseManager(agentDir);
		const leaseRequest = request("c");
		const handle = await writer.acquire(leaseRequest);
		const uncertain = new PortableLeaseManager(agentDir, () => "unknown");
		expect((await uncertain.inspect(handle.path)).status).toBe("unknown");
		await expect(uncertain.acquire(leaseRequest)).rejects.toBeInstanceOf(LeaseBusyError);
		await expect(uncertain.recover(handle.path, uncertain.challenge(handle.owner))).rejects.toThrow("found unknown");
		await handle.release();
	});

	it("refuses release after owner-token replacement", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-token-lease-"));
		temporary.push(agentDir);
		const manager = new PortableLeaseManager(agentDir);
		const handle = await manager.acquire(request("d"));
		await writeFile(join(handle.path, "owner.json"), JSON.stringify({ ...handle.owner, token: randomUUID() }));
		await expect(handle.release()).rejects.toThrow("owner changed");
		expect((await manager.inspect(handle.path)).status).toBe("live");
	});

	it("fails closed on malformed locks and requires exact recovery challenge", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-malformed-lease-"));
		temporary.push(agentDir);
		const manager = new PortableLeaseManager(agentDir);
		const leaseRequest = request("e");
		const path = manager.pathFor(leaseRequest);
		await mkdir(path, { recursive: true });
		await writeFile(join(path, "owner.json"), "not json");
		await expect(manager.acquire(leaseRequest)).rejects.toBeInstanceOf(LeaseBusyError);
		await expect(manager.recover(path, "wrong")).rejects.toBeInstanceOf(LeaseRecoveryError);
		expect(await readFile(join(path, "owner.json"), "utf8")).toBe("not json");
		await expect(manager.recoverMalformed(path, leaseRequest.repositoryId, "wrong")).rejects.toThrow("challenge");
		const quarantine = await manager.recoverMalformed(
			path,
			leaseRequest.repositoryId,
			manager.malformedChallenge(leaseRequest.repositoryId),
		);
		expect(await readFile(join(quarantine, "owner.json"), "utf8")).toBe("not json");
	});

	it("preserves a dead lock in quarantine for explicit recovery", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-recover-lease-"));
		temporary.push(agentDir);
		const manager = new PortableLeaseManager(agentDir);
		const leaseRequest = request("f");
		const path = manager.pathFor(leaseRequest);
		const owner = {
			schemaVersion: 1 as const,
			scope: "repository" as const,
			leaseId: leaseRequest.repositoryId,
			repositoryId: leaseRequest.repositoryId,
			runId: leaseRequest.runId,
			attemptId: leaseRequest.attemptId,
			pid: 999_999,
			token: randomUUID(),
			createdAt: new Date().toISOString(),
		};
		await mkdir(path, { recursive: true });
		await writeFile(join(path, "owner.json"), JSON.stringify(owner));
		await expect(manager.recover(path, "wrong")).rejects.toThrow("challenge");
		const recovered = await manager.recover(path, manager.challenge(owner));
		expect(recovered.owner.token).toBe(owner.token);
		expect(await readFile(join(recovered.quarantinePath, "owner.json"), "utf8")).toContain(owner.token);
	});

	it("holds run and repository leases as one branded recovery guard", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-recovery-guard-"));
		temporary.push(agentDir);
		const manager = new PortableLeaseManager(agentDir);
		const repositoryId = "9".repeat(64);
		const runId = randomUUID();
		const guard = await manager.acquireRecoveryGuard({ repositoryId, runId, attemptId: randomUUID() });
		expect(() => guard.assert(repositoryId, runId)).not.toThrow();
		expect(() => guard.assert("8".repeat(64), runId)).toThrow("another run/repository");
		await expect(manager.acquire({ scope: "run", runId, attemptId: randomUUID() })).rejects.toBeInstanceOf(
			LeaseBusyError,
		);
		await guard.release();
		expect(() => guard.assert(repositoryId, runId)).toThrow("released");
	});
});

describe("multi-process lease", () => {
	it("permits one process for a shared repository identity", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-process-lease-"));
		temporary.push(agentDir);
		const repositoryId = "a".repeat(64);
		const args = [
			agentDir,
			"repository",
			repositoryId,
			randomUUID(),
			randomUUID(),
			"1200",
		];
		const workerPath = join(import.meta.dirname, "helpers", "lease-worker.ts");
		const first = spawn(process.execPath, [workerPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		const firstExit = new Promise((resolve) => first.once("exit", resolve));
		const firstOutput = await new Promise<string>((resolve) => first.stdout.once("data", (data) => resolve(String(data))));
		expect(firstOutput).toContain("acquired");
		const second = spawn(process.execPath, [workerPath, ...args.slice(0, 3), randomUUID(), randomUUID(), "10"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let secondOutput = "";
		second.stdout.on("data", (data) => (secondOutput += String(data)));
		await new Promise((resolve) => second.once("exit", resolve));
		expect(secondOutput).toContain("blocked:");
		await firstExit;
	}, 30_000);

	it("reclaims a real lock after its owner process is killed", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-killed-lease-"));
		temporary.push(agentDir);
		const repositoryId = "2".repeat(64);
		const runId = randomUUID();
		const attemptId = randomUUID();
		const workerPath = join(import.meta.dirname, "helpers", "lease-worker.ts");
		const worker = spawn(
			process.execPath,
			[workerPath, agentDir, "repository", repositoryId, runId, attemptId, "30000"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const exit = new Promise((resolve) => worker.once("exit", resolve));
		const output = await new Promise<string>((resolve) => worker.stdout.once("data", (data) => resolve(String(data))));
		expect(output).toContain("acquired");
		worker.kill("SIGKILL");
		await exit;
		const manager = new PortableLeaseManager(agentDir);
		const handle = await manager.acquire({ scope: "repository", repositoryId, runId, attemptId: randomUUID() });
		expect(handle.owner.pid).toBe(process.pid);
		await handle.release();
	}, 30_000);

	it("keys linked Git worktrees and Jujutsu workspaces to one lease", async () => {
		for (const kind of ["git", "jj-native"] as const) {
			const fixture = await createRepositoryFixture(kind);
			try {
				const sibling = join(fixture.root, "..", `${kind}-sibling`);
				if (kind === "git") await fixture.run("git", ["worktree", "add", "-b", "lease-test", sibling]);
				else await fixture.run("jj", ["workspace", "add", "--name", "lease-test", sibling]);
				const primary = await detectRepository(fixture.root, runner);
				const linked = await detectRepository(sibling, runner);
				expect(primary.repositoryId).toBe(linked.repositoryId);
				const agentDir = await mkdtemp(join(tmpdir(), `pi-deep-shared-${kind}-`));
				temporary.push(agentDir);
				const first = new PortableLeaseManager(agentDir);
				const second = new PortableLeaseManager(agentDir);
				const handle = await first.acquire({
					scope: "repository",
					repositoryId: primary.repositoryId,
					runId: randomUUID(),
					attemptId: randomUUID(),
				});
				await expect(
					second.acquire({
						scope: "repository",
						repositoryId: linked.repositoryId,
						runId: randomUUID(),
						attemptId: randomUUID(),
					}),
				).rejects.toBeInstanceOf(LeaseBusyError);
				await handle.release();
			} finally {
				await fixture.cleanup();
			}
		}
	}, 15_000);
});
