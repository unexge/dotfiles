import type { AgentGateway } from "../agents/gateway.ts";
import { DesignApprover } from "../application/approve-design.ts";
import {
	WritePreflight,
	WritePreflightError,
	assertWriteBaseline,
} from "../application/begin-write.ts";
import { ImplementationAgent, ImplementationAgentStatusError } from "../application/implementation-agent.ts";
import { ObservationSession } from "../application/observation-session.ts";
import { QualifyAndCommit } from "../application/qualify-and-commit.ts";
import {
	ControlAcceptedError,
	MutationRecoveryRequiredError,
	RunAuthorityClosedError,
	type RunAuthority,
} from "../application/run-authority.ts";
import type { UserOrigin } from "../application/user-origin.ts";
import { assertUserOrigin } from "../application/user-origin.ts";
import type { TrustedCommandCatalog } from "../gates/catalog.ts";
import { backendSnapshotDigest, type BackendTreeService } from "../gates/tree-backend.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { ResolvedPolicy } from "../policy/catalog.ts";
import type { CanonicalFinding, PanelDiagnostic } from "../review/panel.ts";
import type { DesignHandoff } from "../review/design-handoff.ts";
import { digestFrozenArtifact, reviewSubjectDigest } from "../review/subjects.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { observationSubjectDigest } from "../subject/content.ts";
import { SubjectDriftError } from "../subject/drift.ts";
import { writeBuildContext } from "../service/write-context.ts";

export interface BuildWorkflowResult {
	status:
		| "LocalCommitCreated"
		| "ChangesRequired"
		| "NotVerified"
		| "Inconclusive"
		| "Blocked"
		| "Failed"
		| "NeedsManualInspection";
	commitId?: string;
	artifactPath?: string;
	reason?: string;
	findings?: readonly CanonicalFinding[];
}

interface BuildWorkflowInput {
	origin: UserOrigin;
	policy: ResolvedPolicy;
	catalog: TrustedCommandCatalog;
	authority: RunAuthority;
	gateway: AgentGateway;
	trees: BackendTreeService;
	preflight: WritePreflight;
	approver: DesignApprover;
	implementation: ImplementationAgent;
	qualifier: QualifyAndCommit;
	store: RunStore;
	ref: RunRef;
	repositoryKind: "git" | "jj";
	approvedAt: string;
	checkpointedAt: string;
	authorizedAt: string;
	completedAt: string;
	sourceDesign?: DesignHandoff;
	designFeedback?: string;
}

export async function runBuildWorkflow(input: BuildWorkflowInput): Promise<BuildWorkflowResult> {
	const artifactPath = "outputs/build.json";
	try {
		assertUserOrigin(input.origin);
		input.catalog.assertPolicy(input.policy);
		input.approver.assertRun(input.gateway, input.store, input.ref);
		input.implementation.assertRun(input.authority, input.gateway, input.trees, input.store, input.ref);
		input.qualifier.assertRun(
			input.policy,
			input.catalog,
			input.authority,
			input.gateway,
			input.trees,
			input.store,
			input.ref,
			input.repositoryKind,
		);
		const baseline = await input.preflight.begin();
		assertWriteBaseline(baseline);
		const sourceApprovedDesign = input.sourceDesign?.approvedDesign;
		if (input.sourceDesign && !sourceApprovedDesign) {
			throw new Error("Build source is not an approved standalone design");
		}
		const sourceIdentity = input.sourceDesign && sourceApprovedDesign
			? {
					runId: input.sourceDesign.runId,
					approvedDesignId: sourceApprovedDesign.approvedDesignId,
					artifactDigest: input.sourceDesign.designDigest,
				}
			: undefined;
		const observed = await ObservationSession.begin(input.gateway, input.trees, input.authority);
		const initialObservationDigest = observationSubjectDigest(observed.subject.observation);
		if (initialObservationDigest !== observationSubjectDigest(baseline.observation)) {
			throw new SubjectDriftError(observationSubjectDigest(baseline.observation), initialObservationDigest);
		}
		if (sourceApprovedDesign) {
			const sourceDigest = observationSubjectDigest(sourceApprovedDesign.reviewSubject.observation);
			if (sourceDigest !== initialObservationDigest) throw new SubjectDriftError(sourceDigest, initialObservationDigest);
		}
		const sourceContext = input.sourceDesign
			? [
					`Use approved standalone design ${sourceIdentity!.approvedDesignId} as the design basis:`,
					canonicalJson(input.sourceDesign.design),
					...(input.designFeedback ? ["Additional operator constraints:", input.designFeedback] : []),
					"Preserve its accepted decisions. Add only build-specific detail and trusted behavior selectors.",
				].join("\n\n")
			: undefined;
		const frame = await observed.run({
			kind: "plan",
			label: "frame build",
			task: [
				`Frame the approved-build problem, success criteria, and smallest implementation steps for:\n\n${input.origin.goal}`,
				...(sourceContext ? [sourceContext] : []),
			].join("\n\n"),
		});
		if (frame.report.value.status !== "ok") throw new BuildAgentStatusError("frame", frame.report.value.status);
		const designResult = await observed.run({
			kind: "design",
			label: "design build",
			task: [
				`Design the implementation for the operator goal: ${input.origin.goal}`,
				...(sourceContext ? [sourceContext] : []),
				"Use this validated frame:",
				canonicalJson(frame.report.value),
				"All configured behavior observations are coordinator-selected. Return an empty testSelectors array.",
			].join("\n\n"),
		});
		if (designResult.report.value.status !== "ok") {
			throw new BuildAgentStatusError("design", designResult.report.value.status);
		}
		const design = canonicalJson(designResult.report.value);
		const designDigest = digestFrozenArtifact(design);
		await observed.assertCurrent();
		const approval = await input.approver.approve({
			caller: "build",
			design,
			userOrigin: input.origin,
			expectedObservationDigest: initialObservationDigest,
			approvedAt: input.approvedAt,
			...(sourceIdentity ? { sourceDesign: sourceIdentity } : {}),
		});
		if (approval.status === "Blocked") {
			await observed.assertCurrent();
			throw new BuildApprovalBlockedError(approval.diagnostics);
		}
		if (approval.status === "ChangesRequired") {
			assertDesignSubject(approval.reviewSubject.observation, initialObservationDigest);
			if (reviewSubjectDigest(approval.reviewSubject) !== approval.subjectDigest) {
				throw new Error("Build design review returned a foreign subject digest");
			}
			await observed.assertCurrent();
			const artifact = {
				schemaVersion: 1,
				proposedOutcome: "ChangesRequired",
				authoritative: false,
				lifecycleAuthority: "state.json",
				goal: input.origin.goal,
				...(sourceIdentity
					? { sourceDesignRunId: sourceIdentity.runId, sourceApprovedDesignId: sourceIdentity.approvedDesignId }
					: {}),
				designDigest,
				design: designResult.report.value,
				reviewSubjectDigest: approval.subjectDigest,
				findings: approval.findings,
			};
			await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact)));
			await observed.assertCurrent();
			await input.authority.complete("ChangesRequired", artifactPath, input.completedAt);
			return { status: "ChangesRequired", artifactPath, findings: approval.findings };
		}
		assertDesignSubject(approval.record.reviewSubject.observation, initialObservationDigest);
		if (
			approval.record.caller !== "build" ||
			approval.record.behavior.kind !== "contract" ||
			approval.record.design.artifactDigest !== designDigest ||
			canonicalJson(approval.record.sourceDesign ?? null) !== canonicalJson(sourceIdentity ?? null)
		) {
			throw new Error("Approved build design contradicts the synthesized design or behavior contract");
		}
		await observed.assertCurrent();
		assertWriteBaseline(baseline);
		const contextState = await input.store.load(input.ref);
		if (contextState.lifecycle !== "Active") throw new Error("Build context requires an Active run");
		await writeBuildContext(input.store, input.ref, {
			schemaVersion: 1,
			workflow: "build",
			stage: "approved",
			attemptId: contextState.attemptId,
			approvedDesign: approval.record,
		});
		const implemented = await input.implementation.implement({
			approvedDesign: approval.record,
			goal: input.origin.goal,
			checkpointSequence: 1,
			createdAt: input.checkpointedAt,
		});
		try {
			await writeBuildContext(input.store, input.ref, {
				schemaVersion: 1,
				workflow: "build",
				stage: "implemented",
				attemptId: contextState.attemptId,
				approvedDesign: approval.record,
				implementationCheckpoint: implemented.checkpoint,
			});
		} catch (error) {
			throw new BuildContextCheckpointError("Implementation checkpoint was written but build context publication failed", error);
		}
		const qualification = await input.qualifier.run({
			workflow: "build",
			approvedDesign: approval.record,
			userOrigin: input.origin,
			checkpointSequence: 2,
			authorizedAt: input.authorizedAt,
		});
		if (qualification.status === "Committed") {
			return { status: "LocalCommitCreated", commitId: qualification.commitId };
		}
		if (qualification.status === "Blocked") {
			await input.authority.block(qualification.reason, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Blocked", qualification.reason, {
				approvedDesignId: approval.record.approvedDesignId,
				implementationCheckpoint: implemented.checkpoint,
				...(qualification.diagnostics ? { diagnostics: qualification.diagnostics } : {}),
			});
			return { status: "Blocked", artifactPath, reason: qualification.reason };
		}
		const current = await input.trees.captureObservation();
		const currentDigest = backendSnapshotDigest(current);
		const outcome = qualification.status;
		const artifact = {
			schemaVersion: 1,
			proposedOutcome: outcome,
			authoritative: false,
			lifecycleAuthority: "state.json",
			goal: input.origin.goal,
			...(sourceIdentity
				? { sourceDesignRunId: sourceIdentity.runId, sourceApprovedDesignId: sourceIdentity.approvedDesignId }
				: {}),
			approvedDesignId: approval.record.approvedDesignId,
			implementationCheckpoint: implemented.checkpoint,
			observationSubjectDigest: observationSubjectDigest(current.observation),
			...(qualification.status === "ChangesRequired" ? { findings: qualification.findings } : {}),
		};
		await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact)));
		const after = await input.trees.captureObservation();
		const afterDigest = backendSnapshotDigest(after);
		if (afterDigest !== currentDigest) throw new SubjectDriftError(currentDigest, afterDigest);
		await input.authority.complete(outcome, artifactPath, input.completedAt);
		return {
			status: outcome,
			artifactPath,
			...(qualification.status === "ChangesRequired" ? { findings: qualification.findings } : {}),
		};
	} catch (error) {
		if (error instanceof ControlAcceptedError || error instanceof RunAuthorityClosedError) throw error;
		if (error instanceof MutationRecoveryRequiredError) {
			await writeDiagnostic(input, artifactPath, "NeedsManualInspection", error.message);
			return { status: "NeedsManualInspection", artifactPath, reason: error.message };
		}
		if (
			error instanceof WritePreflightError ||
			error instanceof BuildContextCheckpointError ||
			error instanceof BuildApprovalBlockedError ||
			(error instanceof BuildAgentStatusError && error.status === "blocked") ||
			(error instanceof ImplementationAgentStatusError && error.status === "blocked")
		) {
			await input.authority.block(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Blocked", error.message, approvalDiagnostics(error));
			return { status: "Blocked", artifactPath, reason: error.message };
		}
		if (error instanceof SubjectDriftError) {
			await input.authority.block(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Blocked", error.message, {
				beforeSubjectDigest: error.beforeDigest,
				afterSubjectDigest: error.afterDigest,
			});
			return { status: "Blocked", artifactPath, reason: error.message };
		}
		if (error instanceof BuildAgentStatusError || error instanceof ImplementationAgentStatusError) {
			await input.authority.fail(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Failed", error.message);
			return { status: "Failed", artifactPath, reason: error.message };
		}
		const reason = error instanceof Error ? error.message : String(error);
		let state = await input.store.load(input.ref);
		if (state.lifecycle === "Active") {
			await input.authority.fail(reason, input.completedAt);
			state = await input.store.load(input.ref);
		}
		if (state.lifecycle === "NeedsManualInspection") {
			await writeDiagnostic(input, artifactPath, "NeedsManualInspection", reason, { lifecycle: state.lifecycle });
			return { status: "NeedsManualInspection", artifactPath, reason };
		}
		if (state.lifecycle !== "Failed") throw error;
		await writeDiagnostic(input, artifactPath, "Failed", reason, { lifecycle: state.lifecycle });
		return { status: "Failed", artifactPath, reason };
	}
}

function assertDesignSubject(
	observation: Parameters<typeof observationSubjectDigest>[0],
	expectedDigest: string,
): void {
	const actual = observationSubjectDigest(observation);
	if (actual !== expectedDigest) throw new SubjectDriftError(expectedDigest, actual);
}

function approvalDiagnostics(error: Error): Record<string, unknown> {
	return error instanceof BuildApprovalBlockedError ? { diagnostics: error.diagnostics } : {};
}

async function writeDiagnostic(
	input: BuildWorkflowInput,
	artifactPath: string,
	outcome: "Blocked" | "Failed" | "NeedsManualInspection",
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

class BuildContextCheckpointError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "BuildContextCheckpointError";
	}
}

class BuildAgentStatusError extends Error {
	constructor(
		readonly phase: "frame" | "design",
		readonly status: "blocked" | "failed",
	) {
		super(`${phase} agent returned ${status}`);
		this.name = "BuildAgentStatusError";
	}
}

class BuildApprovalBlockedError extends Error {
	constructor(readonly diagnostics: readonly PanelDiagnostic[]) {
		super(`Build design approval blocked: ${diagnostics.map((diagnostic) => diagnostic.cause).join(", ")}`);
		this.name = "BuildApprovalBlockedError";
	}
}
