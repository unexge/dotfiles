import type { AgentGateway } from "../agents/gateway.ts";
import { DesignApprover } from "../application/approve-design.ts";
import { ObservationSession } from "../application/observation-session.ts";
import {
	ControlAcceptedError,
	RunAuthorityClosedError,
	type RunAuthority,
} from "../application/run-authority.ts";
import type { UserOrigin } from "../application/user-origin.ts";
import { assertUserOrigin } from "../application/user-origin.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import {
	renderDesignMarkdown,
	type DesignHandoff,
	type DesignLineage,
} from "../review/design-handoff.ts";
import type { CanonicalFinding, PanelDiagnostic } from "../review/panel.ts";
import { digestFrozenArtifact, reviewSubjectDigest } from "../review/subjects.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { observationSubjectDigest } from "../subject/content.ts";
import { SubjectDriftError } from "../subject/drift.ts";
import type { BackendTreeService } from "../gates/tree-backend.ts";

export interface DesignWorkflowResult {
	outcome: "DesignApproved" | "ChangesRequired" | "Blocked" | "Failed";
	artifactPath: string;
	approvedDesignId?: string;
	findings?: readonly CanonicalFinding[];
	reason?: string;
}

interface DesignWorkflowInput {
	origin: UserOrigin;
	authority: RunAuthority;
	gateway: AgentGateway;
	trees: BackendTreeService;
	approver: DesignApprover;
	store: RunStore;
	ref: RunRef;
	concurrency: number;
	approvedAt: string;
	completedAt: string;
	source?: DesignHandoff;
	feedback?: string;
}

const candidatePerspectives = [
	"Prioritize caller usage, data shapes, interfaces, and module boundaries.",
	"Prioritize ownership, invariants, failure modes, tradeoffs, and executable verification.",
] as const;

export async function runDesignWorkflow(input: DesignWorkflowInput): Promise<DesignWorkflowResult> {
	const artifactPath = "outputs/design.json";
	try {
		assertUserOrigin(input.origin);
		if (Boolean(input.source) !== Boolean(input.feedback?.trim())) {
			throw new Error("Design revision requires both a source design and operator feedback");
		}
		input.approver.assertRun(input.gateway, input.store, input.ref);
		const observed = await ObservationSession.begin(input.gateway, input.trees, input.authority);
		// BackendTreeService deterministically derives tree identity from bytes and metadata cryptographically bound by this observation.
		// The workflow's snapshot recaptures remain the final enforcement around the observation-only approver boundary.
		const initialObservationDigest = observationSubjectDigest(observed.subject.observation);
		const sourceContext = input.source
			? [
					"Revise this prior design:",
					canonicalJson(input.source.design),
					"Prior review findings:",
					canonicalJson(input.source.findings),
					"Operator feedback:",
					input.feedback!,
				].join("\n\n")
			: undefined;
		const candidates = await observed.runMany(
			candidatePerspectives.map((perspective, index) => ({
				kind: "design" as const,
				label: `design candidate ${index + 1}`,
				task: [
					`Design a solution for the original operator goal: ${input.origin.goal}`,
					...(sourceContext ? [sourceContext] : []),
					perspective,
					"Read relevant repository code. Do not modify files.",
				].join("\n\n"),
			})),
			Math.min(input.concurrency, candidatePerspectives.length),
		);
		const incompleteCandidate = candidates.find((candidate) => candidate.report.value.status !== "ok");
		if (incompleteCandidate) {
			throw new DesignAgentStatusError("candidate", incompleteCandidate.report.value.status as "blocked" | "failed");
		}
		const synthesis = await observed.run({
			kind: "design",
			label: "synthesize design",
			task: [
				`Synthesize one coherent design for the original operator goal: ${input.origin.goal}`,
				...(sourceContext ? [sourceContext] : []),
				"Use the strongest compatible ideas from these two validated candidates. Do not average incompatible choices.",
				canonicalJson(candidates.map((candidate) => candidate.report.value)),
			].join("\n\n"),
		});
		if (synthesis.report.value.status !== "ok") {
			throw new DesignAgentStatusError("synthesis", synthesis.report.value.status);
		}
		const design = canonicalJson(synthesis.report.value);
		const designDigest = digestFrozenArtifact(design);
		await observed.assertCurrent();
		// Approved-design records are idempotent intermediate evidence and intentionally never GC'd; only a matching state.json outcome is authoritative.
		const approval = await input.approver.approve({
			caller: "design",
			design,
			userOrigin: input.origin,
			expectedObservationDigest: initialObservationDigest,
			approvedAt: input.approvedAt,
		});
		if (approval.status === "Blocked") {
			await observed.assertCurrent();
			throw new DesignApprovalBlockedError(approval.diagnostics);
		}
		let outcome: "DesignApproved" | "ChangesRequired";
		let approvedDesignId: string | undefined;
		let findings: readonly CanonicalFinding[];
		let approvalArtifact: Record<string, unknown>;
		if (approval.status === "ChangesRequired") {
			assertReviewSubject(approval.reviewSubject.observation, initialObservationDigest);
			if (reviewSubjectDigest(approval.reviewSubject) !== approval.subjectDigest) {
				throw new Error("ChangesRequired approval returned a foreign review-subject digest");
			}
			outcome = "ChangesRequired";
			findings = approval.findings;
			approvalArtifact = {
				reviewSubjectDigest: approval.subjectDigest,
				findings: approval.findings,
			};
		} else {
			assertReviewSubject(approval.record.reviewSubject.observation, initialObservationDigest);
			if (approval.record.design.artifactDigest !== designDigest || approval.record.caller !== "design") {
				throw new Error("Approved design record contradicts the synthesized standalone design");
			}
			outcome = "DesignApproved";
			approvedDesignId = approval.record.approvedDesignId;
			findings = approval.findings;
			approvalArtifact = {
				approvedDesignId,
				recordPath: `approved-designs/${approvedDesignId}/record.json`,
				reviewSubjectDigest: approval.record.reviewSubjectDigest,
				designArtifactPath: approval.record.design.artifactPath,
				designArtifactDigest: approval.record.design.artifactDigest,
				panel: approval.record.panel,
			};
		}
		await observed.assertCurrent();
		const source: DesignLineage | undefined = input.source
			? {
					runId: input.source.runId,
					...(input.source.approvedDesign
						? { approvedDesignId: input.source.approvedDesign.approvedDesignId }
						: {}),
					artifactDigest: input.source.designDigest,
					feedback: input.feedback!,
				}
			: undefined;
		const markdown = renderDesignMarkdown({
			runId: input.ref.runId,
			goal: input.origin.goal,
			design: synthesis.report.value,
			designDigest,
			outcome,
			findings,
			...(approvedDesignId ? { approvedDesignId } : {}),
			...(source ? { source } : {}),
		});
		const markdownArtifact = await input.store.writeArtifact(input.ref, "outputs/design.md", markdown);
		await observed.assertCurrent();
		const artifact = {
			schemaVersion: 1,
			proposedOutcome: outcome,
			authoritative: false,
			lifecycleAuthority: "state.json",
			goal: input.origin.goal,
			output: [
				markdown,
				`Design run: ${input.ref.runId}`,
				`Markdown: ${markdownArtifact.path}`,
				outcome === "DesignApproved"
					? `Build: /deep build --design ${input.ref.runId.slice(0, 8)}`
					: `Revise: /deep design --from ${input.ref.runId.slice(0, 8)} <feedback>`,
			].join("\n"),
			...(source ? { source } : {}),
			observationSubjectDigest: initialObservationDigest,
			designDigest,
			design: synthesis.report.value,
			candidates: candidates.map((candidate) => candidate.report.value),
			findings,
			approval: approvalArtifact,
		};
		await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact)));
		await observed.assertCurrent();
		await input.authority.complete(outcome, artifactPath, input.completedAt);
		return { outcome, artifactPath, ...(approvedDesignId ? { approvedDesignId } : {}), findings };
	} catch (error) {
		if (error instanceof ControlAcceptedError || error instanceof RunAuthorityClosedError) throw error;
		if (
			error instanceof DesignApprovalBlockedError ||
			(error instanceof DesignAgentStatusError && error.status === "blocked")
		) {
			await input.authority.block(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Blocked", error.message, approvalDiagnostics(error));
			return { outcome: "Blocked", artifactPath, reason: error.message };
		}
		if (error instanceof DesignAgentStatusError) {
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

function assertReviewSubject(
	observation: Parameters<typeof observationSubjectDigest>[0],
	expectedDigest: string,
): void {
	const actualDigest = observationSubjectDigest(observation);
	if (actualDigest !== expectedDigest) throw new SubjectDriftError(expectedDigest, actualDigest);
}

function approvalDiagnostics(error: Error): Record<string, unknown> {
	return error instanceof DesignApprovalBlockedError ? { diagnostics: error.diagnostics } : {};
}

async function writeDiagnostic(
	input: DesignWorkflowInput,
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
				goal: input.origin.goal,
				reason,
				...extra,
			}),
		),
	);
}

class DesignAgentStatusError extends Error {
	constructor(
		readonly phase: "candidate" | "synthesis",
		readonly status: "blocked" | "failed",
	) {
		super(`${phase} designer returned ${status}`);
		this.name = "DesignAgentStatusError";
	}
}

class DesignApprovalBlockedError extends Error {
	constructor(readonly diagnostics: readonly PanelDiagnostic[]) {
		super(
			`Design approval blocked: ${diagnostics.map((diagnostic) => `${diagnostic.cause}: ${diagnostic.detail}`).join(", ")}`,
		);
		this.name = "DesignApprovalBlockedError";
	}
}
