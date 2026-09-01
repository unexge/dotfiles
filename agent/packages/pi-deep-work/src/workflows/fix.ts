import type { AgentGateway } from "../agents/gateway.ts";
import { DesignApprover } from "../application/approve-design.ts";
import { WritePreflight, WritePreflightError, assertWriteBaseline } from "../application/begin-write.ts";
import { ImplementationAgent, ImplementationAgentStatusError } from "../application/implementation-agent.ts";
import { ObservationSession } from "../application/observation-session.ts";
import { QualifyAndCommit } from "../application/qualify-and-commit.ts";
import {
	RegressionAgent,
	RegressionAgentStatusError,
	RegressionNotRedError,
} from "../application/regression-agent.ts";
import {
	ControlAcceptedError,
	MutationRecoveryRequiredError,
	RunAuthorityClosedError,
	type RunAuthority,
} from "../application/run-authority.ts";
import type { UserOrigin } from "../application/user-origin.ts";
import { assertUserOrigin } from "../application/user-origin.ts";
import type { TrustedCommandCatalog } from "../gates/catalog.ts";
import type { GateExecutor } from "../gates/executor.ts";
import { backendSnapshotDigest, type BackendTreeService } from "../gates/tree-backend.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { ResolvedPolicy } from "../policy/catalog.ts";
import type { CanonicalFinding, PanelDiagnostic } from "../review/panel.ts";
import { digestFrozenArtifact, reviewSubjectDigest } from "../review/subjects.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { evidenceSubjectDigest, observationSubjectDigest } from "../subject/content.ts";
import { SubjectDriftError } from "../subject/drift.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";
import { writeFixContext } from "../service/write-context.ts";

export interface FixWorkflowResult {
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

interface FixWorkflowInput {
	origin: UserOrigin;
	policy: ResolvedPolicy;
	catalog: TrustedCommandCatalog;
	authority: RunAuthority;
	gateway: AgentGateway;
	trees: BackendTreeService;
	gates: GateExecutor;
	boundary: WorkspaceBoundary;
	preflight: WritePreflight;
	regression: RegressionAgent;
	approver: DesignApprover;
	implementation: ImplementationAgent;
	qualifier: QualifyAndCommit;
	store: RunStore;
	ref: RunRef;
	repositoryKind: "git" | "jj";
	regressionCheckpointedAt: string;
	approvedAt: string;
	implementationCheckpointedAt: string;
	authorizedAt: string;
	completedAt: string;
}

export async function runFixWorkflow(input: FixWorkflowInput): Promise<FixWorkflowResult> {
	const artifactPath = "outputs/fix.json";
	try {
		assertUserOrigin(input.origin);
		input.catalog.assertPolicy(input.policy);
		input.regression.assertRun(
			input.authority,
			input.gateway,
			input.boundary,
			input.catalog,
			input.trees,
			input.gates,
			input.store,
			input.ref,
		);
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
		const initialObserved = await ObservationSession.begin(input.gateway, input.trees, input.authority);
		const baselineDigest = observationSubjectDigest(baseline.observation);
		if (observationSubjectDigest(initialObserved.subject.observation) !== baselineDigest) {
			throw new SubjectDriftError(baselineDigest, observationSubjectDigest(initialObserved.subject.observation));
		}
		const investigation = await initialObserved.run({
			kind: "explore",
			label: "investigate fix",
			task: [
				`Investigate the reported bug and trace it to the owning invariant: ${input.origin.goal}`,
				"Read source and tests. Do not modify files. Describe the causal flow and narrow regression target.",
			].join("\n\n"),
		});
		if (investigation.report.value.status !== "ok") {
			throw new FixAgentStatusError("investigation", investigation.report.value.status as "blocked" | "failed");
		}
		await initialObserved.assertCurrent();
		assertWriteBaseline(baseline);
		const regression = await input.regression.capture({
			baseline,
			goal: input.origin.goal,
			investigation: investigation.report.value,
			checkpointSequence: 1,
			createdAt: input.regressionCheckpointedAt,
		});
		const contextState = await input.store.load(input.ref);
		if (contextState.lifecycle !== "Active") throw new Error("Fix context requires an Active run");
		const redContext = {
			schemaVersion: 1 as const,
			workflow: "fix" as const,
			stage: "red" as const,
			attemptId: contextState.attemptId,
			investigation: investigation.report.value,
			selectorProposals: [...regression.selectorProposals],
			redEvidence: serializedRedEvidence(regression.evidence),
			regressionCheckpoint: regression.checkpoint,
		};
		try {
			await writeFixContext(input.store, input.ref, redContext);
		} catch (error) {
			throw new FixContextCheckpointError("Regression checkpoint was written but fix context publication failed", error);
		}
		const redObserved = await ObservationSession.begin(input.gateway, input.trees, input.authority);
		const designResult = await redObserved.run({
			kind: "design",
			label: "design fix",
			task: [
				`Design the smallest root-cause fix for: ${input.origin.goal}`,
				`Investigation: ${canonicalJson(investigation.report.value)}`,
				`Clean failing red evidence: ${canonicalJson({
					regressionSubjectDigest: regression.evidence.regressionSubjectDigest,
					observationId: regression.evidence.observationId,
					claimKeys: regression.evidence.claimKeys,
					failingRecord: regression.evidence.failingRecord,
				})}`,
				"Preserve the regression and return exactly its data-only test selectors.",
			].join("\n\n"),
		});
		if (designResult.report.value.status !== "ok") {
			throw new FixAgentStatusError("design", designResult.report.value.status);
		}
		if (selectorKey(designResult.report.value.testSelectors) !== selectorKey(regression.selectorProposals)) {
			throw new FixPreconditionError("Fix design selectors differ from the clean red regression selectors");
		}
		const design = canonicalJson(designResult.report.value);
		const designDigest = digestFrozenArtifact(design);
		const redObservationDigest = observationSubjectDigest(redObserved.subject.observation);
		await redObserved.assertCurrent();
		const approval = await input.approver.approve({
			caller: "fix",
			design,
			userOrigin: input.origin,
			expectedObservationDigest: redObservationDigest,
			selectorProposals: regression.selectorProposals,
			approvedAt: input.approvedAt,
		});
		if (approval.status === "Blocked") {
			await redObserved.assertCurrent();
			throw new FixApprovalBlockedError(approval.diagnostics);
		}
		if (approval.status === "ChangesRequired") {
			assertDesignSubject(approval.reviewSubject.observation, redObservationDigest);
			if (reviewSubjectDigest(approval.reviewSubject) !== approval.subjectDigest) {
				throw new Error("Fix design review returned a foreign subject digest");
			}
			await redObserved.assertCurrent();
			const artifact = {
				schemaVersion: 1,
				proposedOutcome: "ChangesRequired",
				authoritative: false,
				lifecycleAuthority: "state.json",
				goal: input.origin.goal,
				designDigest,
				design: designResult.report.value,
				redRegressionSubjectDigest: regression.evidence.regressionSubjectDigest,
				findings: approval.findings,
			};
			await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact)));
			await redObserved.assertCurrent();
			await input.authority.complete("ChangesRequired", artifactPath, input.completedAt);
			return { status: "ChangesRequired", artifactPath, findings: approval.findings };
		}
		assertDesignSubject(approval.record.reviewSubject.observation, redObservationDigest);
		if (
			approval.record.caller !== "fix" ||
			approval.record.behavior.kind !== "contract" ||
			approval.record.design.artifactDigest !== designDigest
		) {
			throw new Error("Approved fix design contradicts the synthesized fix design");
		}
		const behaviorContract = approval.record.behavior.contract;
		if (
			!behaviorContract.observationIds.includes(regression.evidence.observationId) ||
			!regression.evidence.claimKeys.every((key) => behaviorContract.claimKeys.includes(key))
		) {
			throw new Error("Approved fix design does not cover the exact clean red regression obligation");
		}
		await redObserved.assertCurrent();
		try {
			await writeFixContext(input.store, input.ref, {
				...redContext,
				stage: "approved",
				approvedDesign: approval.record,
			});
		} catch (error) {
			throw new FixContextCheckpointError("Approved fix design could not be added to durable context", error);
		}
		const implemented = await input.implementation.implement({
			approvedDesign: approval.record,
			goal: input.origin.goal,
			checkpointSequence: 2,
			createdAt: input.implementationCheckpointedAt,
		});
		try {
			await writeFixContext(input.store, input.ref, {
				...redContext,
				stage: "implemented",
				approvedDesign: approval.record,
				implementationCheckpoint: implemented.checkpoint,
			});
		} catch (error) {
			throw new FixContextCheckpointError("Implementation checkpoint was written but fix context publication failed", error);
		}
		const qualification = await input.qualifier.run({
			workflow: "fix",
			approvedDesign: approval.record,
			userOrigin: input.origin,
			redEvidence: regression.evidence,
			checkpointSequence: 3,
			authorizedAt: input.authorizedAt,
		});
		if (qualification.status === "Committed") {
			return { status: "LocalCommitCreated", commitId: qualification.commitId };
		}
		if (qualification.status === "Blocked") {
			await input.authority.block(qualification.reason, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Blocked", qualification.reason, {
				redRegressionSubjectDigest: regression.evidence.regressionSubjectDigest,
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
			approvedDesignId: approval.record.approvedDesignId,
			redRegressionSubjectDigest: evidenceSubjectDigest(regression.evidence.regressionSubject),
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
			error instanceof FixContextCheckpointError ||
			error instanceof RegressionNotRedError ||
			error instanceof FixPreconditionError ||
			error instanceof FixApprovalBlockedError ||
			(error instanceof FixAgentStatusError && error.status === "blocked") ||
			(error instanceof RegressionAgentStatusError && error.status === "blocked") ||
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
		if (
			error instanceof FixAgentStatusError ||
			error instanceof RegressionAgentStatusError ||
			error instanceof ImplementationAgentStatusError
		) {
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

function serializedRedEvidence(evidence: import("../authorization/red-regression.ts").RedRegressionEvidence) {
	return {
		regressionSubject: evidence.regressionSubject,
		regressionSubjectDigest: evidence.regressionSubjectDigest,
		regressionChangedPaths: [...evidence.regressionChangedPaths],
		mutationCheckpointDigest: evidence.mutationCheckpointDigest,
		observationId: evidence.observationId,
		argvDigest: evidence.argvDigest,
		claimKeys: [...evidence.claimKeys],
		failingRecord: evidence.failingRecord,
	};
}

function assertDesignSubject(
	observation: Parameters<typeof observationSubjectDigest>[0],
	expectedDigest: string,
): void {
	const actual = observationSubjectDigest(observation);
	if (actual !== expectedDigest) throw new SubjectDriftError(expectedDigest, actual);
}

function selectorKey(values: readonly { selectorId: string; value: string }[]): string {
	return [...values]
		.map((value) => `${value.selectorId}\0${value.value}`)
		.sort()
		.join("\0");
}

function approvalDiagnostics(error: Error): Record<string, unknown> {
	return error instanceof FixApprovalBlockedError ? { diagnostics: error.diagnostics } : {};
}

async function writeDiagnostic(
	input: FixWorkflowInput,
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

class FixContextCheckpointError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "FixContextCheckpointError";
	}
}

class FixAgentStatusError extends Error {
	constructor(
		readonly phase: "investigation" | "design",
		readonly status: "blocked" | "failed",
	) {
		super(`${phase} agent returned ${status}`);
		this.name = "FixAgentStatusError";
	}
}

class FixApprovalBlockedError extends Error {
	constructor(readonly diagnostics: readonly PanelDiagnostic[]) {
		super(`Fix design approval blocked: ${diagnostics.map((diagnostic) => diagnostic.cause).join(", ")}`);
		this.name = "FixApprovalBlockedError";
	}
}

class FixPreconditionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FixPreconditionError";
	}
}
