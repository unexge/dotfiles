import type { AgentGateway } from "../agents/gateway.ts";
import { ObservationSession } from "../application/observation-session.ts";
import {
	ControlAcceptedError,
	RunAuthorityClosedError,
	type RunAuthority,
} from "../application/run-authority.ts";
import type { UserOrigin } from "../application/user-origin.ts";
import { assertUserOrigin } from "../application/user-origin.ts";
import { ObservedDiffPreconditionError, type BackendTreeService } from "../gates/tree-backend.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import {
	assertCompletePanelResult,
	type CanonicalFinding,
	type PanelDiagnostic,
	type ReviewPanel,
} from "../review/panel.ts";
import { reviewSubjectDigest, type ReviewSubject } from "../review/subjects.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { SubjectDriftError } from "../subject/drift.ts";

export interface ReviewWorkflowResult {
	outcome: "ReviewApproved" | "ChangesRequired" | "Blocked" | "Failed";
	artifactPath: string;
	findings?: readonly CanonicalFinding[];
	reason?: string;
}

interface ReviewWorkflowInput {
	origin: UserOrigin;
	base?: string;
	authority: RunAuthority;
	gateway: AgentGateway;
	trees: BackendTreeService;
	panel: ReviewPanel;
	store: RunStore;
	ref: RunRef;
	completedAt: string;
}

export async function runReviewWorkflow(input: ReviewWorkflowInput): Promise<ReviewWorkflowResult> {
	const artifactPath = "outputs/review.json";
	try {
		assertUserOrigin(input.origin);
		input.panel.assertGateway(input.gateway);
		input.panel.assertRun(input.store, input.ref);
		const observed = await ObservationSession.begin(input.gateway, input.trees, input.authority);
		const diff = await observed.renderDiff(input.base);
		if (!diff.patch.trim()) throw new ReviewPreconditionError("No diff to review");
		const frame = await observed.run({
			kind: "plan",
			label: "frame code review",
			task: [
				"Frame the operator's intent and the highest-value review focus for this exact observed diff.",
				`Operator intent: ${input.origin.goal}`,
				`Changed paths: ${diff.paths.join(", ")}`,
				`Diff digest: ${diff.diffDigest}`,
			].join("\n\n"),
		});
		if (frame.report.value.status !== "ok") {
			throw new ReviewAgentStatusError(frame.report.value.status);
		}
		const subject: ReviewSubject = {
			schemaVersion: 1,
			kind: "observed-code",
			observation: observed.subject.observation,
			diffDigest: diff.diffDigest,
		};
		const expectedSubjectDigest = reviewSubjectDigest(subject);
		await observed.assertCurrent();
		const panelResult = await input.panel.review({
			subject,
			frozenArtifact: diff.patch,
			task: [
				"Review this exact observed code diff against the original operator intent.",
				`Operator intent: ${input.origin.goal}`,
				"Untrusted orchestrator framing:",
				canonicalJson(frame.report.value),
			].join("\n\n"),
			recaptureSubjectDigest: async () => {
				const current = await input.trees.captureObservation();
				return reviewSubjectDigest({ ...subject, observation: current.observation });
			},
		});
		if (!panelResult.complete) {
			// A subject-drift diagnostic proves the panel callback recaptured; every other incomplete exit still needs a boundary recapture.
			if (!panelResult.diagnostics.some((diagnostic) => diagnostic.cause === "subject_drift")) {
				try {
					await observed.assertCurrent();
				} catch (error) {
					if (!(error instanceof SubjectDriftError)) throw error;
					throw new IncompleteReviewPanelError(
						[
							...panelResult.diagnostics,
							{ cause: "subject_drift", retryable: true, detail: error.message },
						],
						error,
					);
				}
			}
			throw new IncompleteReviewPanelError(panelResult.diagnostics);
		}
		assertCompletePanelResult(panelResult);
		if (panelResult.subjectDigest !== expectedSubjectDigest) throw new Error("Review panel returned a foreign subject");
		await observed.assertCurrent();
		const outcome = panelResult.record.approved ? "ReviewApproved" : "ChangesRequired";
		const artifact = {
			schemaVersion: 1,
			proposedOutcome: outcome,
			authoritative: false,
			lifecycleAuthority: "state.json",
			intent: input.origin.goal,
			observationSubjectDigest: observed.subjectDigest,
			reviewSubjectDigest: expectedSubjectDigest,
			baseRevision: diff.baseRevision,
			diffDigest: diff.diffDigest,
			paths: diff.paths,
			panel: {
				recordPath: panelResult.recordArtifact.path,
				recordDigest: panelResult.recordArtifact.digest,
				artifactPath: panelResult.panelArtifact.path,
				artifactDigest: panelResult.panelArtifact.digest,
			},
			findings: panelResult.findings,
			notices: panelResult.notices,
		};
		await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact)));
		await observed.assertCurrent();
		await input.authority.complete(outcome, artifactPath, input.completedAt);
		return { outcome, artifactPath, findings: panelResult.findings };
	} catch (error) {
		if (error instanceof ControlAcceptedError || error instanceof RunAuthorityClosedError) throw error;
		if (
			error instanceof ReviewPreconditionError ||
			error instanceof ObservedDiffPreconditionError ||
			error instanceof IncompleteReviewPanelError ||
			(error instanceof ReviewAgentStatusError && error.status === "blocked")
		) {
			await input.authority.block(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Blocked", error.message, panelDiagnostics(error));
			return { outcome: "Blocked", artifactPath, reason: error.message };
		}
		if (error instanceof ReviewAgentStatusError) {
			await input.authority.fail(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Failed", error.message);
			return { outcome: "Failed", artifactPath, reason: error.message };
		}
		if (error instanceof SubjectDriftError) {
			await input.authority.block(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Blocked", error.message, {
				beforeSubjectDigest: error.beforeDigest,
				afterSubjectDigest: error.afterDigest,
			});
			return { outcome: "Blocked", artifactPath, reason: error.message };
		}
		const reason = error instanceof Error ? error.message : String(error);
		let state = await input.store.load(input.ref);
		if (state.lifecycle === "Active") {
			await input.authority.fail(reason, input.completedAt);
			state = await input.store.load(input.ref);
		}
		if (state.lifecycle !== "Failed") throw error;
		await writeDiagnostic(input, artifactPath, "Failed", reason, { lifecycle: state.lifecycle });
		return { outcome: "Failed", artifactPath, reason };
	}
}

function panelDiagnostics(error: Error): Record<string, unknown> {
	if (!(error instanceof IncompleteReviewPanelError)) return {};
	return {
		diagnostics: error.diagnostics,
		...(error.drift
			? { beforeSubjectDigest: error.drift.beforeDigest, afterSubjectDigest: error.drift.afterDigest }
			: {}),
	};
}

async function writeDiagnostic(
	input: ReviewWorkflowInput,
	artifactPath: string,
	outcome: "Blocked" | "Failed",
	reason: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	await input.store.writeArtifact(
		input.ref,
		artifactPath,
		Buffer.from(
			canonicalJson({
				schemaVersion: 1,
				proposedOutcome: outcome,
				authoritative: false,
				lifecycleAuthority: "state.json",
				intent: input.origin.goal,
				reason,
				...extra,
			}),
		),
	);
}

class ReviewPreconditionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewPreconditionError";
	}
}

class ReviewAgentStatusError extends Error {
	constructor(readonly status: "blocked" | "failed") {
		super(`review planner returned ${status}`);
		this.name = "ReviewAgentStatusError";
	}
}

class IncompleteReviewPanelError extends Error {
	constructor(
		readonly diagnostics: readonly PanelDiagnostic[],
		readonly drift?: SubjectDriftError,
	) {
		super(`Review panel incomplete: ${diagnostics.map((diagnostic) => diagnostic.cause).join(", ")}`);
		this.name = "IncompleteReviewPanelError";
	}
}
