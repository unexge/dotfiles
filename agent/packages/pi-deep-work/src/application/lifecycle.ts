import type { AttemptId, WorkflowOutcome } from "./types.ts";
import type {
	ActiveRun,
	CompletedRun,
	QueuedRun,
	RecoverableRun,
	RunProjection,
	TerminalRun,
} from "../store/schemas.ts";

export class LifecycleTransitionError extends Error {
	constructor(from: string, action: string) {
		super(`Cannot ${action} a run in ${from}`);
		this.name = "LifecycleTransitionError";
	}
}

const allowedOutcomes: Record<RunProjection["workflow"], readonly WorkflowOutcome[]> = {
	how: ["ExplanationProduced"],
	unslop: ["UnslopReportProduced"],
	design: ["DesignApproved", "ChangesRequired"],
	review: ["ReviewApproved", "ChangesRequired"],
	verify: ["Verified", "NotVerified", "Inconclusive"],
	fix: ["LocalCommitCreated", "ChangesRequired", "NotVerified", "Inconclusive"],
	build: ["LocalCommitCreated", "ChangesRequired", "NotVerified", "Inconclusive"],
};

function common(state: RunProjection, updatedAt: string) {
	return {
		schemaVersion: 1 as const,
		runId: state.runId,
		workflow: state.workflow,
		repositoryId: state.repositoryId,
		policyDigest: state.policyDigest,
		goal: state.goal,
		createdAt: state.createdAt,
		updatedAt,
		lastEventRevision: state.lastEventRevision + 1,
	};
}

function requireActive(state: ActiveRun, action: string): void {
	if (state.lifecycle !== "Active") throw new LifecycleTransitionError(state.lifecycle, action);
}

function requireNonEmpty(value: string, name: string): void {
	if (value.length === 0) throw new Error(`${name} cannot be empty`);
}

export function startRun(state: QueuedRun, attemptId: AttemptId, phase: string, updatedAt: string): ActiveRun {
	requireNonEmpty(phase, "phase");
	return {
		...common(state, updatedAt),
		lifecycle: "Active",
		attemptId,
		phase,
	};
}

export function observeControl(state: ActiveRun, updatedAt: string): ActiveRun {
	return {
		...common(state, updatedAt),
		lifecycle: state.lifecycle,
		attemptId: state.attemptId,
		phase: state.phase,
	};
}

export function requestPause(state: ActiveRun, updatedAt: string): ActiveRun {
	requireActive(state, "request pause for");
	return {
		...common(state, updatedAt),
		lifecycle: "Pausing",
		attemptId: state.attemptId,
		phase: state.phase,
	};
}

export function settlePause(
	state: ActiveRun,
	reason: string,
	updatedAt: string,
	observedControlRevision: number,
): RecoverableRun {
	if (state.lifecycle !== "Pausing") throw new LifecycleTransitionError(state.lifecycle, "settle pause for");
	requireNonEmpty(reason, "reason");
	return {
		...common(state, updatedAt),
		lifecycle: "Paused",
		lastAttemptId: state.attemptId,
		observedControlRevision,
		reason,
	};
}

export function requireManualInspection(
	state: ActiveRun,
	reason: string,
	updatedAt: string,
	observedControlRevision: number,
): RecoverableRun {
	requireNonEmpty(reason, "reason");
	return {
		...common(state, updatedAt),
		lifecycle: "NeedsManualInspection",
		lastAttemptId: state.attemptId,
		observedControlRevision,
		reason,
	};
}

export function blockRun(
	state: ActiveRun,
	reason: string,
	updatedAt: string,
	observedControlRevision: number,
): RecoverableRun {
	requireActive(state, "block");
	requireNonEmpty(reason, "reason");
	return {
		...common(state, updatedAt),
		lifecycle: "Blocked",
		lastAttemptId: state.attemptId,
		observedControlRevision,
		reason,
	};
}

export function resumeRun(state: RecoverableRun, attemptId: AttemptId, phase: string, updatedAt: string): ActiveRun {
	requireNonEmpty(phase, "phase");
	return {
		...common(state, updatedAt),
		lifecycle: "Active",
		attemptId,
		phase,
	};
}

export function cancelRun(state: ActiveRun | RecoverableRun, reason: string, updatedAt: string): TerminalRun {
	requireNonEmpty(reason, "reason");
	return {
		...common(state, updatedAt),
		lifecycle: "Cancelled",
		lastAttemptId: "attemptId" in state ? state.attemptId : state.lastAttemptId,
		reason,
	};
}

/** Records the reserved startup attempt ID without claiming that an AttemptStarted event occurred. */
export function failQueuedRun(
	state: QueuedRun,
	failedAttemptId: AttemptId,
	reason: string,
	updatedAt: string,
): TerminalRun {
	requireNonEmpty(reason, "reason");
	return {
		...common(state, updatedAt),
		lifecycle: "Failed",
		lastAttemptId: failedAttemptId,
		reason,
	};
}

export function failRun(state: ActiveRun, reason: string, updatedAt: string): TerminalRun {
	requireActive(state, "fail");
	requireNonEmpty(reason, "reason");
	return {
		...common(state, updatedAt),
		lifecycle: "Failed",
		lastAttemptId: state.attemptId,
		reason,
	};
}

export function completeRun(
	state: ActiveRun,
	outcome: WorkflowOutcome,
	summaryArtifact: string,
	updatedAt: string,
): CompletedRun {
	requireActive(state, "complete");
	requireNonEmpty(summaryArtifact, "summaryArtifact");
	if (!allowedOutcomes[state.workflow].includes(outcome)) {
		throw new Error(`Outcome ${outcome} is not valid for ${state.workflow}`);
	}
	return {
		...common(state, updatedAt),
		lifecycle: "Completed",
		lastAttemptId: state.attemptId,
		outcome,
		summaryArtifact,
	};
}
