import { canonicalJson } from "../policy/canonical-json.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import type { MutationPhaseCheckpoint } from "../store/schemas.ts";
import { MutationPhase } from "./mutation-phase.ts";

export type MutationCheckpointBase = Omit<MutationPhaseCheckpoint, "mutation">;

export async function persistMutationCheckpoint(
	store: RunStore,
	ref: RunRef,
	base: MutationCheckpointBase,
	phase: MutationPhase,
	captureCurrentSubjectDigest: () => Promise<string>,
): Promise<MutationPhaseCheckpoint> {
	if (base.phase !== phase.phase) throw new Error(`Mutation phase mismatch: ${base.phase} != ${phase.phase}`);
	const completed = phase.complete();
	if (completed.mutations.length === 0) throw new Error("Mutation checkpoint requires at least one changed file");
	if ((await captureCurrentSubjectDigest()) !== base.subjectDigest) {
		throw new Error("Mutation checkpoint subject does not match the current checkout");
	}
	const artifact = `mutations/${base.attemptId}/${String(base.sequence).padStart(8, "0")}-${base.phase}.json`;
	const written = await store.writeArtifact(ref, artifact, canonicalJson(completed));
	if ((await captureCurrentSubjectDigest()) !== base.subjectDigest) {
		throw new Error("Mutation checkpoint subject drifted during artifact publication");
	}
	const checkpoint: MutationPhaseCheckpoint = {
		...base,
		mutation: {
			artifact,
			artifactDigest: written.digest,
			mutationDigest: completed.mutationDigest,
			fileCount: completed.mutations.length,
		},
	};
	await store.writeCheckpoint(ref, checkpoint);
	return checkpoint;
}
