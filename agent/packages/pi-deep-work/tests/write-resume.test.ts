import { describe, expect, it, vi } from "vitest";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import { resumeBuildFromContext } from "../src/service/write-resume.ts";
import { isImplementationCheckpoint } from "../src/service/continuation.ts";
import { canonicalDigest } from "../src/policy/canonical-json.ts";
import { approvedDesignIdFor, type ApprovedDesignRecord } from "../src/review/design.ts";
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
	conflicted: false as const,
	indexTree: "5".repeat(40),
};

function approvedDesign(): ApprovedDesignRecord {
	const core = { schemaVersion: 1 as const, selectors: [], observationIds: ["behavior"], claimKeys: ["behavior.ok"] };
	const contract = { ...core, id: canonicalDigest(core) };
	const designDigest = "a".repeat(64);
	const reviewSubject = { schemaVersion: 1 as const, kind: "behavior-design" as const, observation: repairedObservation, designDigest, behaviorContractDigest: contract.id };
	const reviewSubjectDigest = canonicalDigest(reviewSubject);
	const panelArtifactDigest = "b".repeat(64);
	return {
		schemaVersion: 1, caller: "build",
		approvedDesignId: approvedDesignIdFor({ reviewSubjectDigest, panelArtifactDigest, designDigest, behaviorDigest: contract.id }),
		reviewSubject, reviewSubjectDigest,
		design: { artifactPath: "design.json", artifactDigest: designDigest },
		behavior: { kind: "contract", digest: contract.id, contract, artifactPath: "behavior.json", artifactDigest: "c".repeat(64) },
		panel: { recordPath: "record.json", recordDigest: "d".repeat(64), artifactPath: "panel.json", artifactDigest: panelArtifactDigest },
		approvedAt: "2026-08-25T00:00:00.000Z",
	};
}

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
	it.each(["quick gates", "full gates", "behavior observations", "code review"])("renders true stopping phase %s using the latest repair checkpoint", async (phase) => {
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
				approvedDesign: approvedDesign(),
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
					phase, repairRounds: 2,
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

		const contextCalls = writeArtifact.mock.calls.filter((call) => call[1] === "workflow/build-context.json");
		expect(contextCalls).toHaveLength(2);
		expect(JSON.parse((contextCalls[1][2] as Buffer).toString()).implementationCheckpoint).toEqual(repaired);
		const outputCall = writeArtifact.mock.calls.find((call) => call[1] === "outputs/build.json")!;
		const output = JSON.parse((outputCall[2] as Buffer).toString("utf8"));
		expect(output.implementationCheckpoint).toEqual(repaired);
		expect(output).toMatchObject({ phase, repairRounds: 2 });
		expect(output.output).toContain(`**Stopped during:** ${phase}`);
		expect(output.output).toContain("**Corrective iterations completed:** 2");
		expect(complete).toHaveBeenCalledWith("ChangesRequired", "outputs/build.json", "2026-08-25T00:00:01.000Z");
	});

	it.each(["regression", "normalize", "design"])("does not treat %s as implementation", (phase) => {
		expect(isImplementationCheckpoint(checkpoint(phase, "d".repeat(64)))).toBe(false);
	});
});
