import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureDirectoryDurable, syncParentDirectory, writeImmutable } from "../store/atomic.ts";
import { decodeLeaseOwner, type LeaseOwner } from "./schemas.ts";

export interface LeaseRequest {
	scope: "repository" | "run";
	repositoryId?: string;
	runId: string;
	attemptId: string;
}

export interface LeaseInspection {
	path: string;
	status: "available" | "live" | "dead" | "unknown" | "malformed";
	owner?: LeaseOwner;
	raw?: string;
}

export interface LeaseHandle {
	path: string;
	owner: LeaseOwner;
	release(): Promise<void>;
}

const recoveryGuardToken = Symbol("recovery-lease-guard");
const recoveryGuards = new WeakSet<RecoveryLeaseGuard>();

export class RecoveryLeaseGuard {
	readonly repositoryId: string;
	readonly runId: string;
	private readonly runLease: LeaseHandle;
	private readonly repositoryLease: LeaseHandle;
	private released = false;

	constructor(
		token: typeof recoveryGuardToken,
		repositoryId: string,
		runId: string,
		runLease: LeaseHandle,
		repositoryLease: LeaseHandle,
	) {
		if (token !== recoveryGuardToken) throw new LeaseRecoveryError("RecoveryLeaseGuard lacks lease authority");
		this.repositoryId = repositoryId;
		this.runId = runId;
		this.runLease = runLease;
		this.repositoryLease = repositoryLease;
		recoveryGuards.add(this);
	}

	assert(repositoryId: string, runId: string): void {
		if (!recoveryGuards.has(this) || this.released || this.repositoryId !== repositoryId || this.runId !== runId) {
			throw new LeaseRecoveryError("Recovery lease guard is missing, released, or belongs to another run/repository");
		}
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		const errors: unknown[] = [];
		await this.repositoryLease.release().catch((error) => errors.push(error));
		await this.runLease.release().catch((error) => errors.push(error));
		if (errors.length > 0) throw new AggregateError(errors, "Failed to release recovery leases");
	}
}

export class LeaseBusyError extends Error {
	readonly inspection: LeaseInspection;

	constructor(inspection: LeaseInspection) {
		super(`${inspection.status} lease blocks acquisition: ${inspection.path}`);
		this.name = "LeaseBusyError";
		this.inspection = inspection;
	}
}

export class LeaseRecoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LeaseRecoveryError";
	}
}

export type ProcessProbe = (pid: number) => "live" | "dead" | "unknown";

function probeProcess(pid: number): "live" | "dead" | "unknown" {
	try {
		process.kill(pid, 0);
		return "live";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
	}
}

function ownerChallenge(owner: LeaseOwner): string {
	return `${owner.runId.slice(0, 8)}/${owner.attemptId.slice(0, 8)}`;
}

export class PortableLeaseManager {
	readonly lockDirectory: string;
	private readonly processProbe: ProcessProbe;

	constructor(agentDir: string, processProbe: ProcessProbe = probeProcess) {
		this.lockDirectory = join(agentDir, "pi-deep-work", "locks");
		this.processProbe = processProbe;
	}

	async acquireRecoveryGuard(request: {
		repositoryId: string;
		runId: string;
		attemptId: string;
	}): Promise<RecoveryLeaseGuard> {
		const runLease = await this.acquire({ scope: "run", runId: request.runId, attemptId: request.attemptId });
		let repositoryLease: LeaseHandle | undefined;
		try {
			repositoryLease = await this.acquire({
				scope: "repository",
				repositoryId: request.repositoryId,
				runId: request.runId,
				attemptId: request.attemptId,
			});
			return new RecoveryLeaseGuard(
				recoveryGuardToken,
				request.repositoryId,
				request.runId,
				runLease,
				repositoryLease,
			);
		} catch (error) {
			if (repositoryLease) await repositoryLease.release().catch(() => undefined);
			await runLease.release().catch(() => undefined);
			throw error;
		}
	}

	pathFor(request: LeaseRequest): string {
		const leaseId = request.scope === "repository" ? request.repositoryId : request.runId;
		if (!leaseId) throw new LeaseRecoveryError("Repository lease request requires repositoryId");
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(leaseId)) {
			throw new LeaseRecoveryError(`Invalid lease identity: ${leaseId}`);
		}
		return join(this.lockDirectory, `${request.scope}-${leaseId}.lock`);
	}

	challenge(owner: LeaseOwner): string {
		return ownerChallenge(owner);
	}

	malformedChallenge(leaseId: string): string {
		return `malformed/${leaseId}`;
	}

	async acquire(request: LeaseRequest): Promise<LeaseHandle> {
		await ensureDirectoryDurable(this.lockDirectory);
		const leaseId = request.scope === "repository" ? request.repositoryId : request.runId;
		const owner = decodeLeaseOwner({
			schemaVersion: 1,
			scope: request.scope,
			leaseId,
			...(request.repositoryId ? { repositoryId: request.repositoryId } : {}),
			runId: request.runId,
			attemptId: request.attemptId,
			pid: process.pid,
			token: randomUUID(),
			createdAt: new Date().toISOString(),
		});
		const path = this.pathFor(request);

		for (let attempt = 0; attempt < 3; attempt++) {
			const scratch = `${path}.acquire.${randomUUID()}`;
			await mkdir(scratch, { mode: 0o700 });
			try {
				await writeImmutable(join(scratch, "owner.json"), `${JSON.stringify(owner)}\n`);
				try {
					await rename(scratch, path);
					await syncParentDirectory(path);
					return {
						path,
						owner,
						release: () => this.release(path, owner),
					};
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
				}
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
			const inspection = await this.inspect(path);
			if (inspection.status !== "dead" || !inspection.owner || inspection.raw === undefined) {
				throw new LeaseBusyError(inspection);
			}
			await this.quarantineExact(path, inspection.raw, inspection.owner.token);
		}
		throw new LeaseBusyError(await this.inspect(path));
	}

	async inspect(path: string): Promise<LeaseInspection> {
		let raw: string;
		try {
			raw = await readFile(join(path, "owner.json"), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				try {
					await readFile(path);
					return { path, status: "malformed" };
				} catch (pathError) {
					if ((pathError as NodeJS.ErrnoException).code === "EISDIR") return { path, status: "malformed" };
					if ((pathError as NodeJS.ErrnoException).code === "ENOENT") return { path, status: "available" };
					throw pathError;
				}
			}
			throw error;
		}
		try {
			const owner = decodeLeaseOwner(JSON.parse(raw));
			return { path, status: this.processProbe(owner.pid), owner, raw };
		} catch {
			return { path, status: "malformed", raw };
		}
	}

	async recoverMalformed(path: string, leaseId: string, challenge: string): Promise<string> {
		const inspection = await this.inspect(path);
		if (inspection.status !== "malformed") throw new LeaseRecoveryError(`Malformed recovery found ${inspection.status}`);
		if (challenge !== this.malformedChallenge(leaseId)) throw new LeaseRecoveryError("Malformed recovery challenge mismatch");
		const quarantine = `${path}.quarantine.${randomUUID()}`;
		await rename(path, quarantine);
		await syncParentDirectory(path);
		const quarantined = await this.inspect(quarantine);
		if (quarantined.status !== "malformed" || quarantined.raw !== inspection.raw) {
			await rename(quarantine, path);
			await syncParentDirectory(path);
			throw new LeaseRecoveryError("Malformed lease identity changed during quarantine");
		}
		return quarantine;
	}

	async recover(path: string, challenge: string): Promise<{ quarantinePath: string; owner: LeaseOwner }> {
		const inspection = await this.inspect(path);
		if (inspection.status !== "dead" || !inspection.owner || inspection.raw === undefined) {
			throw new LeaseRecoveryError(`Recovery requires a positively dead valid owner; found ${inspection.status}`);
		}
		if (challenge !== ownerChallenge(inspection.owner)) throw new LeaseRecoveryError("Recovery challenge does not match owner");
		const quarantinePath = await this.quarantineExact(path, inspection.raw, inspection.owner.token, false);
		return { quarantinePath, owner: inspection.owner };
	}

	private async release(path: string, owner: LeaseOwner): Promise<void> {
		const inspection = await this.inspect(path);
		if (inspection.status === "available") return;
		if (
			!inspection.owner ||
			inspection.raw === undefined ||
			inspection.owner.token !== owner.token ||
			inspection.owner.pid !== owner.pid
		) {
			throw new LeaseRecoveryError("Lease owner changed before release");
		}
		await this.quarantineExact(path, inspection.raw, owner.token);
	}

	private async quarantineExact(
		path: string,
		expectedRaw: string,
		expectedToken: string,
		remove = true,
	): Promise<string> {
		const quarantine = `${path}.quarantine.${randomUUID()}`;
		await rename(path, quarantine);
		await syncParentDirectory(path);
		const actualRaw = await readFile(join(quarantine, "owner.json"), "utf8");
		let actual: LeaseOwner;
		try {
			actual = decodeLeaseOwner(JSON.parse(actualRaw));
		} catch (error) {
			try {
				await rename(quarantine, path);
				await syncParentDirectory(path);
			} catch (rollbackError) {
				throw new LeaseRecoveryError(`Lease quarantine rollback failed: ${String(rollbackError)}`);
			}
			throw error;
		}
		if (actualRaw !== expectedRaw || actual.token !== expectedToken) {
			try {
				await rename(quarantine, path);
				await syncParentDirectory(path);
			} catch (rollbackError) {
				throw new LeaseRecoveryError(`Lease identity changed and rollback failed: ${String(rollbackError)}`);
			}
			throw new LeaseRecoveryError("Lease identity changed during quarantine");
		}
		if (remove) await rm(quarantine, { recursive: true, force: true });
		return quarantine;
	}
}
