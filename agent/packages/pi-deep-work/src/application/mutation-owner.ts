import {
	ControlAcceptedError,
	MutationRecoveryRequiredError,
	RunAuthorityClosedError,
	type MutationEffectOptions,
	type RunAuthority,
} from "./run-authority.ts";
import type { MutationPhase } from "../workspace/mutation-phase.ts";

export function mutationEffectOptions(phase: MutationPhase, reason: string): MutationEffectOptions {
	return {
		reason,
		requiresManualInspection: () => phase.hasMutations() || phase.requiresManualInspection(),
	};
}

export async function settleMutationError(
	authority: RunAuthority,
	phase: MutationPhase,
	error: unknown,
	reason: string,
	at: string,
): Promise<never> {
	if (
		error instanceof ControlAcceptedError ||
		error instanceof MutationRecoveryRequiredError ||
		error instanceof RunAuthorityClosedError
	) {
		throw error;
	}
	if (phase.hasMutations() || phase.requiresManualInspection()) {
		await authority.manualInspection(reason, at);
		throw new MutationRecoveryRequiredError(reason, error);
	}
	throw error;
}
