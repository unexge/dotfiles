import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../src/store/run-store.ts";
import { decode, MutationPhaseCheckpointSchema, type QueuedRun } from "../src/store/schemas.ts";
import { persistMutationCheckpoint } from "../src/workspace/checkpoint.ts";
import { MutationPhase } from "../src/workspace/mutation-phase.ts";

const temporary: string[] = [];

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-mutation-checkpoint-"));
	temporary.push(root);
	const store = new RunStore(root);
	const runId = randomUUID();
	const initial: QueuedRun = {
		schemaVersion: 1,
		runId,
		workflow: "build",
		repositoryId: "a".repeat(64),
		policyDigest: "b".repeat(64),
		goal: "checkpoint mutations",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued",
	};
	const ref = await store.create("git", initial);
	return { root, store, ref, initial };
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("mutation checkpoint", () => {
	it("persists immutable preimage/result records and binds them to the phase checkpoint", async () => {
		const values = await fixture();
		const phase = new MutationPhase("implement");
		const first = phase.begin("src/a.ts", Buffer.from("before"));
		phase.finish(first, Buffer.from("after"));
		const createdAt = "2026-08-25T00:00:01.000Z";
		const checkpoint = await persistMutationCheckpoint(
			values.store,
			values.ref,
			{
				schemaVersion: 1,
				runId: values.initial.runId,
				attemptId: randomUUID(),
				sequence: 1,
				phase: "implement",
				policyDigest: values.initial.policyDigest,
				subjectDigest: "c".repeat(64),
				eventRevision: 2,
				controlRevision: 0,
				createdAt,
			},
			phase,
			async () => "c".repeat(64),
		);
		expect(checkpoint.mutation).toMatchObject({ fileCount: 1, mutationDigest: phase.complete().mutationDigest });
		expect(phase.hasMutations()).toBe(true);
		const artifact = await readFile(join(values.ref.directory, "artifacts", checkpoint.mutation.artifact), "utf8");
		expect(JSON.parse(artifact)).toMatchObject({
			phase: "implement",
			mutations: [{ path: "src/a.ts" }],
		});
		const persisted = JSON.parse(
			await readFile(
				join(values.ref.directory, "checkpoints", checkpoint.attemptId, "00000001-implement.json"),
				"utf8",
			),
		);
		expect(persisted.mutation).toEqual(checkpoint.mutation);
		await expect(
			values.store.writeCheckpoint(values.ref, {
				...checkpoint,
				sequence: 2,
				mutation: { ...checkpoint.mutation, fileCount: 2 },
			}),
		).rejects.toThrow("contradicts");
	});

	it("recaptures the subject before and after artifact publication", async () => {
		const values = await fixture();
		const phase = new MutationPhase("implement");
		const mutation = phase.begin("src/a.ts", Buffer.from("before"));
		phase.finish(mutation, Buffer.from("after"));
		let captures = 0;
		await expect(
			persistMutationCheckpoint(
				values.store,
				values.ref,
				{
					schemaVersion: 1,
					runId: values.initial.runId,
					attemptId: randomUUID(),
					sequence: 1,
					phase: "implement",
					policyDigest: values.initial.policyDigest,
					subjectDigest: "c".repeat(64),
					eventRevision: 2,
					controlRevision: 0,
					createdAt: "2026-08-25T00:00:01.000Z",
				},
				phase,
				async () => (++captures === 1 ? "c" : "d").repeat(64),
			),
		).rejects.toThrow("drifted during artifact publication");
		expect(captures).toBe(2);
	});

	it("refuses to checkpoint an active or unsafe mutation phase", async () => {
		const values = await fixture();
		const phase = new MutationPhase("implement");
		phase.begin("src/a.ts", Buffer.from("before"));
		await expect(
			persistMutationCheckpoint(
				values.store,
				values.ref,
				{
					schemaVersion: 1,
					runId: values.initial.runId,
					attemptId: randomUUID(),
					sequence: 1,
					phase: "implement",
					policyDigest: values.initial.policyDigest,
					subjectDigest: "c".repeat(64),
					eventRevision: 2,
					controlRevision: 0,
					createdAt: "2026-08-25T00:00:01.000Z",
				},
				phase,
				async () => "c".repeat(64),
			),
		).rejects.toThrow("manual inspection");
	});

	it("rejects partial mutation metadata in checkpoint data", () => {
		expect(() =>
			decode(MutationPhaseCheckpointSchema, {
				schemaVersion: 1,
				runId: randomUUID(),
				attemptId: randomUUID(),
				sequence: 1,
				phase: "implement",
				policyDigest: "a".repeat(64),
				subjectDigest: "b".repeat(64),
				eventRevision: 2,
				controlRevision: 0,
				createdAt: "2026-08-25T00:00:01.000Z",
				mutation: { mutationDigest: "c".repeat(64) },
			}),
		).toThrow();
	});
});
