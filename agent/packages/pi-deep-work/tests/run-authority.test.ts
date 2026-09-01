import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ControlAcceptedError,
	RunAuthority,
	RunAuthorityClosedError,
} from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { RunStore } from "../src/store/run-store.ts";
import { decodeRunProjection, type QueuedRun, type RecoverableRun } from "../src/store/schemas.ts";
import type { GitRepository } from "../src/vcs/types.ts";

const temporary: string[] = [];
const now = "2026-08-25T00:00:00.000Z";
const later = "2026-08-25T00:00:01.000Z";

function queued(repositoryId = "a".repeat(64)): QueuedRun {
	return decodeRunProjection({
		schemaVersion: 1,
		runId: randomUUID(),
		workflow: "build",
		repositoryId,
		policyDigest: "b".repeat(64),
		goal: "authority",
		createdAt: now,
		updatedAt: now,
		lastEventRevision: 0,
		lifecycle: "Queued",
	}) as QueuedRun;
}

async function fixture() {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-authority-"));
	temporary.push(agentDir);
	const store = new RunStore(agentDir);
	const leases = new PortableLeaseManager(agentDir);
	const initial = queued();
	const ref = await store.create("git", initial);
	const repository: GitRepository = {
		kind: "git",
		root: "/repo",
		sharedRoot: "/repo/.git",
		commonDir: "/repo/.git",
		repositoryId: initial.repositoryId,
	};
	return { agentDir, store, leases, initial, ref, repository };
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RunAuthority", () => {
	it("owns one effect and completes with a truthful outcome", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "implement", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		expect(await authority.runEffect("work", async () => "done")).toBe("done");
		const completed = await authority.complete("LocalCommitCreated", "final.md", later);
		expect(completed).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
		const repositoryLease = await values.leases.acquire({
			scope: "repository",
			repositoryId: values.repository.repositoryId,
			runId: randomUUID(),
			attemptId: randomUUID(),
		});
		const runLease = await values.leases.acquire({
			scope: "run",
			runId: values.ref.runId,
			attemptId: randomUUID(),
		});
		await repositoryLease.release();
		await runLease.release();
		expect(() => authority.state()).toThrow(RunAuthorityClosedError);
	});

	it("accepts pause before an effect without running it and releases leases", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "explore", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		await authority.requestControl("Pause", later);
		let called = false;
		await expect(
			authority.runEffect("model", async () => {
				called = true;
			}),
		).rejects.toMatchObject({ kind: "Pause" });
		expect(called).toBe(false);
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Paused", lastEventRevision: 4 });
	});

	it("aborts a waiting effect on cancel and records Cancelled", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "gates", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		const running = authority.runEffect("long command", async (signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		const rejected = expect(running).rejects.toBeInstanceOf(ControlAcceptedError);
		await new Promise((resolve) => setTimeout(resolve, 15));
		await authority.requestControl("Cancel", later);
		await rejected;
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Cancelled", lastEventRevision: 4 });
	});

	it("records a genuine effect failure when cancel races", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "model", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		const running = authority.runEffect("racing failure", async (signal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			throw new Error("effect broke independently");
		});
		const rejected = expect(running).rejects.toThrow("effect broke independently");
		await new Promise((resolve) => setTimeout(resolve, 15));
		await authority.requestControl("Cancel", later);
		await rejected;
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed", reason: "effect broke independently" });
	});

	it("settles an in-flight pause before releasing leases", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "model", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		const running = authority.runEffect("long model", async (signal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		});
		const rejected = expect(running).rejects.toMatchObject({ kind: "Pause" });
		await new Promise((resolve) => setTimeout(resolve, 15));
		await authority.requestControl("Pause", later);
		await rejected;
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Paused" });
	});

	it("releases leases for manual inspection", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "mutate", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		expect(await authority.manualInspection("partial write", later)).toMatchObject({
			lifecycle: "NeedsManualInspection",
		});
		await expect(
			values.leases.acquire({
				scope: "repository",
				repositoryId: values.repository.repositoryId,
				runId: randomUUID(),
				attemptId: randomUUID(),
			}),
		).resolves.toBeTruthy();
	});

	it("settles mutation errors and controls as manual inspection after potential writes", async () => {
		for (const interruption of ["error", "Cancel"] as const) {
			const values = await fixture();
			const authority = await RunAuthority.start(
				{ ...values, attemptId: attemptId(randomUUID()), phase: "mutate", pollIntervalMs: 5 },
				{ ...values.initial, lastEventRevision: 1 },
				later,
			);
			let mutated = false;
			const running = authority.runMutationEffect(
				"mutation",
				async (signal) => {
					mutated = true;
					if (interruption === "error") throw new Error("provider failed after write");
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				},
				{ requiresManualInspection: () => mutated, reason: "mutation checkpoint missing" },
			);
			if (interruption === "Cancel") {
				await new Promise((resolve) => setTimeout(resolve, 15));
				await authority.requestControl("Cancel", later);
			}
			await expect(running).rejects.toMatchObject({
				name: "MutationRecoveryRequiredError",
				...(interruption === "Cancel" ? { controlKind: "Cancel" } : {}),
			});
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "NeedsManualInspection" });
			await expect(
				values.leases.acquire({
					scope: "repository",
					repositoryId: values.repository.repositoryId,
					runId: randomUUID(),
					attemptId: randomUUID(),
				}),
			).resolves.toBeTruthy();
		}
	});

	it("settles pending control and control-read failure as manual inspection after earlier writes", async () => {
		const pending = await fixture();
		const pendingAuthority = await RunAuthority.start(
			{ ...pending, attemptId: attemptId(randomUUID()), phase: "mutate", pollIntervalMs: 5 },
			{ ...pending.initial, lastEventRevision: 1 },
			later,
		);
		await pendingAuthority.requestControl("Cancel", later);
		await expect(
			pendingAuthority.runMutationEffect("post-write capture", async () => undefined, {
				requiresManualInspection: () => true,
				reason: "mutation checkpoint missing",
			}),
		).rejects.toMatchObject({ name: "MutationRecoveryRequiredError", controlKind: "Cancel" });
		expect(await pending.store.load(pending.ref)).toMatchObject({ lifecycle: "NeedsManualInspection" });

		const polling = await fixture();
		const pollingAuthority = await RunAuthority.start(
			{ ...polling, attemptId: attemptId(randomUUID()), phase: "mutate", pollIntervalMs: 5 },
			{ ...polling.initial, lastEventRevision: 1 },
			later,
		);
		polling.store.controls = async () => {
			throw new Error("control read failed");
		};
		await expect(
			pollingAuthority.runMutationEffect("post-write capture", async () => undefined, {
				requiresManualInspection: () => true,
				reason: "mutation checkpoint missing",
			}),
		).rejects.toMatchObject({ name: "MutationRecoveryRequiredError" });
		expect(await polling.store.load(polling.ref)).toMatchObject({ lifecycle: "NeedsManualInspection" });
	});

	it("keeps ordinary failure and control settlement before a mutation starts", async () => {
		const failed = await fixture();
		const failedAuthority = await RunAuthority.start(
			{ ...failed, attemptId: attemptId(randomUUID()), phase: "mutate", pollIntervalMs: 5 },
			{ ...failed.initial, lastEventRevision: 1 },
			later,
		);
		await expect(
			failedAuthority.runMutationEffect("before write", async () => Promise.reject(new Error("provider failed")), {
				requiresManualInspection: () => false,
				reason: "unused",
			}),
		).rejects.toThrow("provider failed");
		expect(await failed.store.load(failed.ref)).toMatchObject({ lifecycle: "Failed" });

		const cancelled = await fixture();
		const cancelledAuthority = await RunAuthority.start(
			{ ...cancelled, attemptId: attemptId(randomUUID()), phase: "mutate", pollIntervalMs: 5 },
			{ ...cancelled.initial, lastEventRevision: 1 },
			later,
		);
		await cancelledAuthority.requestControl("Cancel", later);
		await expect(
			cancelledAuthority.runMutationEffect("before write", async () => undefined, {
				requiresManualInspection: () => false,
				reason: "unused",
			}),
		).rejects.toBeInstanceOf(ControlAcceptedError);
		expect(await cancelled.store.load(cancelled.ref)).toMatchObject({ lifecycle: "Cancelled" });
	});

	it("lets manual-inspection safety supersede a pending Cancel", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "mutate", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		await authority.requestControl("Cancel", later);
		await authority.manualInspection("partial write", later);
		const manual = await values.store.load(values.ref);
		expect(manual).toMatchObject({ lifecycle: "NeedsManualInspection", observedControlRevision: 0 });
		if (manual.lifecycle !== "NeedsManualInspection") throw new Error("expected manual inspection");
		await expect(
			RunAuthority.resume(
				{ ...values, attemptId: attemptId(randomUUID()), phase: "recover", pollIntervalMs: 5 },
				manual,
				"2026-08-25T00:00:03.000Z",
			),
		).rejects.toMatchObject({ kind: "Cancel" });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Cancelled" });
	});

	it("fails and releases leases when control polling errors", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "model", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		const originalControls = values.store.controls.bind(values.store);
		const running = authority.runEffect("wait", async (signal) => {
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
			);
		});
		values.store.controls = async () => {
			throw new Error("control read failed");
		};
		await expect(running).rejects.toThrow("control read failed");
		values.store.controls = originalControls;
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
		await expect(
			values.leases.acquire({
				scope: "repository",
				repositoryId: values.repository.repositoryId,
				runId: randomUUID(),
				attemptId: randomUUID(),
			}),
		).resolves.toBeTruthy();
	});

	it("fails an unhandled effect and releases both leases", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "verify", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		await expect(authority.runEffect("failure", async () => Promise.reject(new Error("provider failed")))).rejects.toThrow(
			"provider failed",
		);
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed", reason: "provider failed" });
	});

	it("lets a pending control override completion", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "finish", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		await authority.requestControl("Pause", later);
		await expect(authority.complete("LocalCommitCreated", "final.md", later)).rejects.toMatchObject({ kind: "Pause" });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Paused" });
	});

	it("fails safely when controls cannot be loaded while opening", async () => {
		const values = await fixture();
		values.store.controls = async () => {
			throw new Error("controls unavailable");
		};
		await expect(
			RunAuthority.start(
				{ ...values, attemptId: attemptId(randomUUID()), phase: "frame", pollIntervalMs: 5 },
				{ ...values.initial, lastEventRevision: 1 },
				later,
			),
		).rejects.toThrow("controls unavailable");
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
	});

	it("honors controls queued before an attempt starts", async () => {
		const values = await fixture();
		await values.store.appendControl(values.ref, "Cancel", later);
		await expect(
			RunAuthority.start(
				{ ...values, attemptId: attemptId(randomUUID()), phase: "frame", pollIntervalMs: 5 },
				{ ...values.initial, lastEventRevision: 1 },
				later,
			),
		).rejects.toBeInstanceOf(ControlAcceptedError);
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Cancelled" });
	});

	it("honors a Cancel queued after the Pause that settled the prior attempt", async () => {
		const values = await fixture();
		const first = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "frame", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		await first.requestControl("Pause", later);
		await expect(first.runEffect("pause", async () => undefined)).rejects.toMatchObject({ kind: "Pause" });
		const paused = await values.store.load(values.ref);
		if (paused.lifecycle !== "Paused") throw new Error("expected paused run");
		await values.store.appendControl(values.ref, "Cancel", "2026-08-25T00:00:02.000Z");
		await expect(
			RunAuthority.resume(
				{ ...values, attemptId: attemptId(randomUUID()), phase: "frame", pollIntervalMs: 5 },
				paused,
				"2026-08-25T00:00:03.000Z",
			),
		).rejects.toMatchObject({ kind: "Cancel" });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Cancelled" });
	});

	it("reacquires both leases before resuming a recoverable run", async () => {
		const values = await fixture();
		const first = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "frame", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		const blocked = (await first.block("needs config", later)) as RecoverableRun;
		const secondAttempt = attemptId(randomUUID());
		const resumed = await RunAuthority.resume(
			{ ...values, attemptId: secondAttempt, phase: "frame", pollIntervalMs: 5 },
			blocked,
			later,
		);
		expect(resumed.state()).toMatchObject({ lifecycle: "Active", attemptId: secondAttempt });
		await resumed.cancel("done", later);
	});

	it("preserves the effect cause when its failure transition cannot be written", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "verify", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		values.store.appendTransition = async () => {
			throw new Error("terminal write failed");
		};
		const rejection = await authority.runEffect("broken", async () => {
			throw new Error("original provider failure");
		}).catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(AggregateError);
		expect((rejection as AggregateError).errors[0]).toMatchObject({ message: "original provider failure" });
		expect(() => authority.state()).toThrow(RunAuthorityClosedError);
	});

	it("attempts both releases and closes after a release failure", async () => {
		const values = await fixture();
		const releases: string[] = [];
		const failingLeases = {
			acquire: async (request: { scope: string; runId: string; attemptId: string; repositoryId?: string }) => ({
				path: request.scope,
				owner: {
					schemaVersion: 1,
					scope: request.scope,
					leaseId: request.scope === "run" ? request.runId : request.repositoryId,
					...(request.repositoryId ? { repositoryId: request.repositoryId } : {}),
					runId: request.runId,
					attemptId: request.attemptId,
					pid: process.pid,
					token: randomUUID(),
					createdAt: later,
				},
				release: async () => {
					releases.push(request.scope);
					if (request.scope === "repository") throw new Error("repository release failed");
				},
			}),
		} as unknown as PortableLeaseManager;
		const authority = await RunAuthority.start(
			{ ...values, leases: failingLeases, attemptId: attemptId(randomUUID()), phase: "frame" },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		await expect(authority.complete("LocalCommitCreated", "final.md", later)).rejects.toThrow(
			"RunAuthority stop did not complete cleanly",
		);
		expect(releases).toEqual(["repository", "run"]);
		expect(() => authority.state()).toThrow(RunAuthorityClosedError);
	});

	it("rejects a second concurrent effect", async () => {
		const values = await fixture();
		const authority = await RunAuthority.start(
			{ ...values, attemptId: attemptId(randomUUID()), phase: "frame", pollIntervalMs: 5 },
			{ ...values.initial, lastEventRevision: 1 },
			later,
		);
		let finish!: () => void;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => (markStarted = resolve));
		const first = authority.runEffect(
			"first",
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
					markStarted();
				}),
		);
		await started;
		await expect(authority.runEffect("second", async () => undefined)).rejects.toThrow("Effect already active");
		finish();
		await first;
		await authority.cancel("done", later);
	});

	it("blocks a second run for the same repository and releases its run lease", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-authority-same-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const leases = new PortableLeaseManager(agentDir);
		const firstInitial = queued("a".repeat(64));
		const secondInitial = queued("a".repeat(64));
		const firstRef = await store.create("git", firstInitial);
		const secondRef = await store.create("git", secondInitial);
		const repository: GitRepository = {
			kind: "git",
			root: "/repo/a",
			sharedRoot: "/repo/a/.git",
			commonDir: "/repo/a/.git",
			repositoryId: firstInitial.repositoryId,
		};
		const first = await RunAuthority.start(
			{ store, leases, ref: firstRef, repository, attemptId: attemptId(randomUUID()), phase: "frame" },
			{ ...firstInitial, lastEventRevision: 1 },
			later,
		);
		const secondAttempt = attemptId(randomUUID());
		await expect(
			RunAuthority.start(
				{ store, leases, ref: secondRef, repository, attemptId: secondAttempt, phase: "frame" },
				{ ...secondInitial, lastEventRevision: 1 },
				later,
			),
		).rejects.toThrow();
		const runLease = await leases.acquire({ scope: "run", runId: secondRef.runId, attemptId: secondAttempt });
		await runLease.release();
		await first.cancel("done", later);
	});

	it("allows different repositories to proceed concurrently under one lease manager", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-authority-multi-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const leases = new PortableLeaseManager(agentDir);
		const firstInitial = queued("a".repeat(64));
		const secondInitial = queued("c".repeat(64));
		const firstRef = await store.create("git", firstInitial);
		const secondRef = await store.create("git", secondInitial);
		const repository = (initial: QueuedRun): GitRepository => ({
			kind: "git",
			root: `/repo/${initial.repositoryId[0]}`,
			sharedRoot: `/repo/${initial.repositoryId[0]}/.git`,
			commonDir: `/repo/${initial.repositoryId[0]}/.git`,
			repositoryId: initial.repositoryId,
		});
		const firstAuthority = await RunAuthority.start(
			{
				store,
				leases,
				ref: firstRef,
				repository: repository(firstInitial),
				attemptId: attemptId(randomUUID()),
				phase: "frame",
				pollIntervalMs: 5,
			},
			{ ...firstInitial, lastEventRevision: 1 },
			later,
		);
		const secondAuthority = await RunAuthority.start(
			{
				store,
				leases,
				ref: secondRef,
				repository: repository(secondInitial),
				attemptId: attemptId(randomUUID()),
				phase: "frame",
				pollIntervalMs: 5,
			},
			{ ...secondInitial, lastEventRevision: 1 },
			later,
		);
		expect(firstAuthority.state().lifecycle).toBe("Active");
		expect(secondAuthority.state().lifecycle).toBe("Active");
		await firstAuthority.cancel("done", later);
		await secondAuthority.cancel("done", later);
	});
});
