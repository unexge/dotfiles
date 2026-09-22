import { canonicalDigest, canonicalJson } from "../../src/policy/canonical-json.ts";
import { approvedDesignIdFor, type ApprovedDesignRecord } from "../../src/review/design.ts";
import { digestFrozenArtifact } from "../../src/review/subjects.ts";
import type { RunRef, RunStore } from "../../src/store/run-store.ts";
import type { ObservationSubject } from "../../src/subject/types.ts";

export const structuredDesign = {
	status: "ok", summary: "Keep cancellation owned by the existing worker", citations: [],
	usage: "Cancel the active worker", constraints: ["No scheduler abstraction"],
	decisions: [{ decision: "Use the existing worker", rationale: "It owns cancellation" }],
	dataShape: "Worker state", interfaces: ["cancel()"], modules: ["worker"],
	invariants: ["Cancellation closes the worker"], alternatives: [], tradeoffs: [],
	verification: ["Prove cancellation"], openQuestions: [], testSelectors: [],
};

export async function persistApprovedDesign(store: RunStore, ref: RunRef, observation: ObservationSubject): Promise<ApprovedDesignRecord> {
	const core = { schemaVersion: 1 as const, selectors: [], observationIds: ["behavior"], claimKeys: ["behavior.ok"] };
	const contract = { ...core, id: canonicalDigest(core) };
	const design = canonicalJson(structuredDesign);
	const designDigest = digestFrozenArtifact(design);
	const reviewSubject = { schemaVersion: 1 as const, kind: "behavior-design" as const, observation, designDigest, behaviorContractDigest: contract.id };
	const reviewSubjectDigest = canonicalDigest(reviewSubject);
	const panelArtifactDigest = "b".repeat(64);
	const id = approvedDesignIdFor({ reviewSubjectDigest, panelArtifactDigest, designDigest, behaviorDigest: contract.id });
	const record: ApprovedDesignRecord = {
		schemaVersion: 1, caller: "build", approvedDesignId: id, reviewSubject, reviewSubjectDigest,
		design: { artifactPath: `approved-designs/${id}/design.json`, artifactDigest: designDigest },
		behavior: { kind: "contract", digest: contract.id, contract, artifactPath: "behavior.json", artifactDigest: "c".repeat(64) },
		panel: { recordPath: "record.json", recordDigest: "d".repeat(64), artifactPath: "panel.json", artifactDigest: panelArtifactDigest },
		approvedAt: "2026-08-25T00:00:00.000Z",
	};
	await store.writeImmutableArtifact(ref, record.design.artifactPath, design);
	await store.writeImmutableArtifact(ref, `approved-designs/${id}/record.json`, canonicalJson(record));
	return record;
}
