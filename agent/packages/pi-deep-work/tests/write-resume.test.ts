import { describe, expect, it, vi } from "vitest";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import { resumeBuildFromContext } from "../src/service/write-resume.ts";
import { WorkflowRuntime } from "../src/service/runtime.ts";
import type { MutationPhaseCheckpoint } from "../src/store/schemas.ts";

const repairedObservation = {
	schemaVersion: 1 as const,
	kind: "git" as const,
	repositoryId: "1".repeat(64),
	root: "/repo",
	policyDigest: "a".repeat(64),
	workingDigest: "2".repeat(64),
	changedPathsDigest: "3".repeat(64),
	headOid: "4".repeat(40),
	symbolicRef: "refs/heads/main",
	conflicted: false,
	indexTree: "5".repeat(40),
};

function checkpoint(phase: string, subjectDigest: string): MutationPhaseCheckpoint {
	return {
		schemaVersion: 1,
		runId: "00000000-0000-4000-8000-000000000001",
		attemptId: "00000000-0000-4000-8000-000000000002",
		sequence: phase === "implement" ? 1 : 3,
		phase,
		policyDigest: "a".repeat(64),
		subjectDigest,
		eventRevision: 1,
		controlRevision: 0,
		createdAt: "2026-08-25T00:00:00.000Z",
		mutation: {
			artifact: `mutations/${phase}.json`,
			artifactDigest: "b".repeat(64),
			mutationDigest: "c".repeat(64),
			fileCount: 1,
		},
	};
}

describe("write resume", () => {
	it("uses an explicitly selected repair checkpoint instead of the stale implementation context", async () => {
		const original = checkpoint("implement", "d".repeat(64));
		const repaired = checkpoint("repair-1", "e".repeat(64));
		const writeArtifact = vi.fn().mockResolvedValue({ digest: "f".repeat(64) });
		const complete = vi.fn().mockResolvedValue(undefined);
		await resumeBuildFromContext({
			context: {
				schemaVersion: 1,
				workflow: "build",
				stage: "implemented",
				attemptId: original.attemptId,
				approvedDesign: { approvedDesignId: "f".repeat(64) } as never,
				implementationCheckpoint: original,
			},
			checkpoint: repaired,
			origin: userOriginFromRegisteredCommand("continue repaired build"),
			authority: { complete } as never,
			gateway: {} as never,
			trees: {
				captureObservation: vi.fn().mockResolvedValue({
					kind: "git",
					observation: repairedObservation,
					treeId: "1".repeat(40),
				}),
			} as never,
			implementation: { implement: vi.fn() } as never,
			qualifier: {
				run: vi.fn().mockResolvedValue({
					status: "ChangesRequired",
					findings: [
						{ id: "finding", reviewerId: "reviewer", severity: "important", title: "Fix", detail: "Still broken" },
					],
				}),
			} as never,
			store: {
				writeArtifact,
				load: vi.fn().mockResolvedValue({ lifecycle: "Completed" }),
			} as never,
			ref: { runId: original.runId } as never,
			completedAt: () => "2026-08-25T00:00:01.000Z",
		});

		const outputCall = writeArtifact.mock.calls.find((call) => call[1] === "outputs/build.json")!;
		const output = JSON.parse((outputCall[2] as Buffer).toString("utf8"));
		expect(output.implementationCheckpoint).toEqual(repaired);
		expect(complete).toHaveBeenCalledWith("ChangesRequired", "outputs/build.json", "2026-08-25T00:00:01.000Z");
	});

	it("selects the latest durable repair checkpoint when it matches the checkout", async () => {
		const original = checkpoint("implement", "d".repeat(64));
		const repaired = checkpoint("repair-1", "e".repeat(64));
		const runtime = Object.assign(Object.create(WorkflowRuntime.prototype), {
			store: {
				readArtifact: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(repaired))),
				readCheckpoint: vi.fn().mockImplementation(async (_ref, _attemptId, _sequence, phase) =>
					phase === repaired.phase ? repaired : original,
				),
			},
		}) as unknown as WorkflowRuntime;
		const select = runtime as unknown as {
			matchingWriteCheckpoint(
				ref: unknown,
				base: MutationPhaseCheckpoint,
				observationDigest: string,
				policyDigest: string,
			): Promise<MutationPhaseCheckpoint | undefined>;
		};

		await expect(
			select.matchingWriteCheckpoint({}, original, repaired.subjectDigest, repaired.policyDigest),
		).resolves.toEqual(repaired);
	});
});
