import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attemptId } from "../src/application/types.ts";
import { startRun } from "../src/application/lifecycle.ts";
import { writeImmutable } from "../src/store/atomic.ts";
import { RunStore, StoreError } from "../src/store/run-store.ts";
import { decodeRunProjection, type QueuedRun } from "../src/store/schemas.ts";

const temporary: string[] = [];
const now = "2026-08-25T00:00:00.000Z";

function queued(runId = randomUUID()): QueuedRun {
	return decodeRunProjection({
		schemaVersion: 1,
		runId,
		workflow: "build",
		repositoryId: "a".repeat(64),
		policyDigest: "b".repeat(64),
		goal: "build ",
		createdAt: now,
		updatedAt: now,
		lastEventRevision: 0,
		lifecycle: "Queued",
	}) as QueuedRun;
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("run store", () => {
	it("creates, transitions, checkpoints, and finds only runs", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-store-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const initial = queued();
		const ref = await store.create("jj", initial);
		const active = startRun(
			{ ...initial, lastEventRevision: 1 },
			attemptId(randomUUID()),
			"frame",
			"2026-08-25T00:01:00.000Z",
		);
		await store.appendTransition(ref, "AttemptStarted", active, active.updatedAt);
		expect(await store.load(ref)).toEqual(active);
		const checkpointValue = {
			schemaVersion: 1 as const,
			runId: initial.runId,
			attemptId: active.attemptId,
			sequence: 1,
			phase: "frame",
			policyDigest: initial.policyDigest,
			subjectDigest: "c".repeat(64),
			eventRevision: active.lastEventRevision,
			controlRevision: 0,
			createdAt: active.updatedAt,
		};
		const checkpoint = await store.writeCheckpoint(ref, checkpointValue);
		expect(await store.writeCheckpoint(ref, checkpointValue)).toBe(checkpoint);
		await expect(store.writeCheckpoint(ref, { ...checkpointValue, subjectDigest: "d".repeat(64) })).rejects.toThrow(
			"contradictory",
		);
		expect(JSON.parse(await readFile(checkpoint, "utf8"))).toMatchObject({ phase: "frame" });
		expect((await store.find(initial.runId.slice(0, 8))).runId).toBe(initial.runId);

		const junk = join(agentDir, "pi-deep-work", "runs", "junk-run");
		await mkdir(junk, { recursive: true });
		await writeFile(join(junk, "state.json"), JSON.stringify({ id: initial.runId }));
		await expect(store.find("junk")).rejects.toThrow("run not found");
	});

	it("reconciles one complete event ahead of the projection", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-reconcile-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const initial = queued();
		const ref = await store.create("git", initial);
		const queuedAtOne = await store.load(ref);
		const active = startRun(queuedAtOne as QueuedRun, attemptId(randomUUID()), "frame", "2026-08-25T00:01:00.000Z");
		await store.appendTransition(ref, "AttemptStarted", active, active.updatedAt);
		await writeFile(join(ref.directory, "state.json"), `${JSON.stringify(queuedAtOne)}\n`);
		expect(await store.load(ref)).toEqual(active);
	});

	it("recovers state from the initial immutable event after create interruption", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-create-recover-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const initial = queued();
		const ref = await store.create("git", initial);
		await rm(join(ref.directory, "state.json"));
		await rm(join(ref.directory, "controls.json"));
		expect((await store.find(initial.runId.slice(0, 8))).runId).toBe(initial.runId);
		expect(await store.load(ref)).toMatchObject({ runId: initial.runId, lastEventRevision: 1 });
		expect((await store.controls(ref)).revision).toBe(0);
	});

	it("rejects contradictory or skipped event history", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-event-gap-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const initial = queued();
		const ref = await store.create("git", initial);
		const eventOne = JSON.parse(await readFile(join(ref.directory, "events", "000000000001.json"), "utf8"));
		await writeFile(
			join(ref.directory, "events", "000000000003.json"),
			JSON.stringify({ ...eventOne, revision: 3, previousRevision: 1 }),
		);
		await expect(store.load(ref)).rejects.toThrow(StoreError);
	});

	it("rejects a mutable projection that disagrees with its authoritative event", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-state-tamper-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const ref = await store.create("git", queued());
		const statePath = join(ref.directory, "state.json");
		const state = JSON.parse(await readFile(statePath, "utf8"));
		await writeFile(statePath, JSON.stringify({ ...state, goal: "tampered at same revision" }));
		await expect(store.load(ref)).rejects.toThrow("does not match the authoritative event");
	});

	it("rejects event projections whose revision contradicts the event", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-event-projection-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const ref = await store.create("git", queued());
		const path = join(ref.directory, "events", "000000000001.json");
		const event = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...event, projection: { ...event.projection, lastEventRevision: 9 } }));
		await expect(store.load(ref)).rejects.toThrow("Contradictory event history");
	});

	it("allows only one concurrent transition at each immutable revision", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-transition-race-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const initial = queued();
		const ref = await store.create("git", initial);
		const current = (await store.load(ref)) as QueuedRun;
		const first = startRun(current, attemptId(randomUUID()), "frame", "2026-08-25T00:01:00.000Z");
		const second = startRun(current, attemptId(randomUUID()), "frame", "2026-08-25T00:01:00.000Z");
		const outcomes = await Promise.allSettled([
			store.appendTransition(ref, "AttemptStarted", first, first.updatedAt),
			store.appendTransition(ref, "AttemptStarted", second, second.updatedAt),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
	});

	it("serializes concurrent controls with monotonic revisions", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-controls-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const initial = queued();
		const ref = await store.create("git", initial);
		const requests = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				store.appendControl(ref, index % 2 === 0 ? "Pause" : "Cancel", `2026-08-25T00:00:${String(index).padStart(2, "0")}.000Z`),
			),
		);
		expect(requests.map((request) => request.revision).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 12 }, (_, index) => index + 1),
		);
		expect((await store.controls(ref)).revision).toBe(12);
		const path = join(ref.directory, "controls.json");
		const controls = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...controls, revision: 13 }));
		await expect(store.controls(ref)).rejects.toThrow("revision or run identity is inconsistent");
	});

	it("recovers a positively dead control lock without losing controls", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-control-recovery-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const ref = await store.create("git", queued());
		const lock = join(ref.directory, "controls.lock");
		await writeFile(lock, JSON.stringify({ pid: 999_999, token: "dead" }));
		expect((await store.appendControl(ref, "Pause", now)).revision).toBe(1);
		expect((await store.controls(ref)).requests.map((request) => request.kind)).toEqual(["Pause"]);
	});

	it("does not clobber controls when missing-file recovery races an append", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-control-create-race-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const ref = await store.create("git", queued());
		await rm(join(ref.directory, "controls.json"));
		await Promise.all([store.controls(ref), store.appendControl(ref, "Cancel", now)]);
		expect(await store.controls(ref)).toMatchObject({ revision: 1, requests: [{ kind: "Cancel" }] });
	});

	it("publishes immutable files atomically without overwriting", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-immutable-"));
		temporary.push(root);
		const path = join(root, "event.json");
		await writeImmutable(path, "complete");
		await expect(writeImmutable(path, "replacement")).rejects.toMatchObject({ code: "EEXIST" });
		expect(await readFile(path, "utf8")).toBe("complete");
		expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("contains artifacts and rejects path escape", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-artifacts-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const ref = await store.create("git", queued());
		const artifact = await store.writeArtifact(ref, "evidence/output.bin", Buffer.from([0, 1, 2, 3]));
		expect(artifact.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(await readFile(artifact.path)).toEqual(Buffer.from([0, 1, 2, 3]));
		await expect(store.writeArtifact(ref, "../escape", "bad")).rejects.toThrow("escapes run directory");
		await expect(
			store.writeCheckpoint(ref, {
				schemaVersion: 1,
				runId: ref.runId,
				attemptId: randomUUID(),
				sequence: 1,
				phase: "../escape",
				policyDigest: "b".repeat(64),
				subjectDigest: "c".repeat(64),
				eventRevision: 1,
				controlRevision: 0,
				createdAt: now,
			}),
		).rejects.toThrow();
	});
});
