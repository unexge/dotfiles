import { blockRun, requireManualInspection } from "../application/lifecycle.ts";
import type { ActiveRun, RecoverableRun } from "../store/schemas.ts";
import { observationSubjectDigest } from "../subject/content.ts";
import type { ObservationSubject } from "../subject/types.ts";

/** observedControlRevision must come from the last complete checkpoint's controlRevision. */
export function projectInterruptedMutation(
	state: ActiveRun,
	lastCheckpointSubjectDigest: string,
	currentSubject: ObservationSubject,
	observedControlRevision: number,
	at: string,
): RecoverableRun {
	const currentDigest = observationSubjectDigest(currentSubject);
	if (currentDigest === lastCheckpointSubjectDigest) {
		return blockRun(
			state,
			"Interrupted attempt left the checkout at its last complete checkpoint",
			at,
			observedControlRevision,
		);
	}
	return requireManualInspection(
		state,
		"Checkout differs from the last complete mutation checkpoint",
		at,
		observedControlRevision,
	);
}
