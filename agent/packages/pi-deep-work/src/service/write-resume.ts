import { createHash } from "node:crypto";
import type { AgentGateway } from "../agents/gateway.ts";
import { DesignApprover } from "../application/approve-design.ts";
import { ImplementationAgent } from "../application/implementation-agent.ts";
import { ObservationSession } from "../application/observation-session.ts";
import { QualifyAndCommit, type QualificationResult } from "../application/qualify-and-commit.ts";
import type { RunAuthority } from "../application/run-authority.ts";
import type { UserOrigin } from "../application/user-origin.ts";
import { mintRedRegressionEvidence } from "../authorization/red-regression.ts";
import type { TrustedCommandCatalog } from "../gates/catalog.ts";
import type { GateExecutor } from "../gates/executor.ts";
import { backendSnapshotDigest, restoreSealedRegression, type BackendTreeService } from "../gates/tree-backend.ts";
import { canonicalDigest, canonicalJson } from "../policy/canonical-json.ts";
import type { CanonicalFinding } from "../review/panel.ts";
import { digestFrozenArtifact } from "../review/subjects.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import type { MutationPhaseCheckpoint, RunProjection } from "../store/schemas.ts";
import { observationSubjectDigest } from "../subject/content.ts";
import { SubjectDriftError } from "../subject/drift.ts";
import { writeBuildContext, writeFixContext, type BuildWriteContext, type FixWriteContext } from "./write-context.ts";

interface CommonResume {
	origin: UserOrigin;
	authority: RunAuthority;
	gateway: AgentGateway;
	trees: BackendTreeService;
	implementation: ImplementationAgent;
	qualifier: QualifyAndCommit;
	store: RunStore;
	ref: RunRef;
	completedAt: () => string;
}

export async function resumeBuildFromContext(
	input: CommonResume & { context: BuildWriteContext; checkpoint?: MutationPhaseCheckpoint },
): Promise<RunProjection> {
	let checkpoint = input.context.stage === "implemented" ? input.context.implementationCheckpoint : input.checkpoint;
	if (!checkpoint) {
		const implemented = await input.implementation.implement({
			approvedDesign: input.context.approvedDesign,
			goal: input.origin.goal,
			checkpointSequence: 1,
			createdAt: input.completedAt(),
		});
		checkpoint = implemented.checkpoint;
	}
	if (input.context.stage !== "implemented") {
		await writeBuildContext(input.store, input.ref, {
			schemaVersion: 1,
			workflow: "build",
			stage: "implemented",
			attemptId: checkpoint.attemptId,
			approvedDesign: input.context.approvedDesign,
			implementationCheckpoint: checkpoint,
		});
	}
	const qualification = await input.qualifier.run({
		workflow: "build",
		approvedDesign: input.context.approvedDesign,
		userOrigin: input.origin,
		checkpointSequence: 2,
		authorizedAt: input.completedAt(),
	});
	return settleQualification(
		"build",
		qualification,
		checkpoint,
		{ approvedDesignId: input.context.approvedDesign.approvedDesignId },
		input,
	);
}

export async function resumeFixFromContext(
	input: CommonResume & {
		context: FixWriteContext;
		checkpoint?: MutationPhaseCheckpoint;
		approver: DesignApprover;
		catalog: TrustedCommandCatalog;
		gates: GateExecutor;
	},
): Promise<RunProjection> {
	// Keep immutable record/checkpoint/artifact verification before the package-internal regression reseal.
	await assertRedContextArtifacts(input.store, input.ref, input.context);
	const subject = restoreSealedRegression(
		input.context.redEvidence.regressionSubject,
		input.context.regressionCheckpoint,
	);
	const command = input.catalog.observation(input.context.redEvidence.observationId);
	const evidence = mintRedRegressionEvidence({
		regressionSubject: subject,
		regressionChangedPaths: input.context.redEvidence.regressionChangedPaths,
		checkpoint: input.context.regressionCheckpoint,
		command,
		failingExecution: { record: input.context.redEvidence.failingRecord },
	});
	if (
		evidence.regressionSubjectDigest !== input.context.redEvidence.regressionSubjectDigest ||
		evidence.mutationCheckpointDigest !== input.context.redEvidence.mutationCheckpointDigest ||
		evidence.argvDigest !== input.context.redEvidence.argvDigest ||
		evidence.claimKeys.join("\0") !== input.context.redEvidence.claimKeys.join("\0") ||
		evidence.regressionChangedPaths.join("\0") !== input.context.redEvidence.regressionChangedPaths.join("\0")
	) {
		throw new Error("Re-minted red evidence contradicts durable fix context");
	}
	let approvedDesign = input.context.stage === "red" ? undefined : input.context.approvedDesign;
	let context = input.context;
	if (!approvedDesign) {
		const observed = await ObservationSession.begin(input.gateway, input.trees, input.authority);
		if (observationSubjectDigest(observed.subject.observation) !== input.context.regressionCheckpoint.subjectDigest) {
			throw new Error("Resumed fix design subject differs from the regression checkpoint");
		}
		const designResult = await observed.run({
			kind: "design",
			label: "resume fix design",
			task: [
				`Design the smallest root-cause fix for: ${input.origin.goal}`,
				`Investigation: ${canonicalJson(input.context.investigation)}`,
				`Red evidence: ${canonicalJson(input.context.redEvidence)}`,
				"Preserve the regression and return exactly its data-only test selectors.",
			].join("\n\n"),
		});
		if (designResult.report.value.status !== "ok") {
			if (designResult.report.value.status === "blocked") {
				await input.authority.block("Resumed fix design agent blocked", input.completedAt());
			} else {
				await input.authority.fail("Resumed fix design agent failed", input.completedAt());
			}
			return input.store.load(input.ref);
		}
		if (selectorKey(designResult.report.value.testSelectors) !== selectorKey(input.context.selectorProposals)) {
			await input.authority.block("Resumed fix design selectors differ from red evidence", input.completedAt());
			return input.store.load(input.ref);
		}
		await observed.assertCurrent();
		const expectedObservationDigest = observationSubjectDigest(observed.subject.observation);
		const design = canonicalJson(designResult.report.value);
		const approval = await input.approver.approve({
			caller: "fix",
			design,
			userOrigin: input.origin,
			expectedObservationDigest,
			selectorProposals: input.context.selectorProposals,
			approvedAt: input.completedAt(),
		});
		await observed.assertCurrent();
		if (approval.status === "Blocked") {
			await input.authority.block("Resumed fix design approval blocked", input.completedAt());
			return input.store.load(input.ref);
		}
		if (approval.status === "ChangesRequired") {
			await writeOutcome(
				"fix",
				"ChangesRequired",
				{ redRegressionSubjectDigest: evidence.regressionSubjectDigest, findings: approval.findings },
				input,
			);
			await input.authority.complete("ChangesRequired", "outputs/fix.json", input.completedAt());
			return input.store.load(input.ref);
		}
		if (approval.record.design.artifactDigest !== digestFrozenArtifact(design)) {
			throw new Error("Resumed approved fix design digest mismatch");
		}
		approvedDesign = approval.record;
		const state = await input.store.load(input.ref);
		if (state.lifecycle !== "Active") throw new Error("Resumed fix context requires an Active run");
		context = {
			...input.context,
			stage: "approved",
			attemptId: state.attemptId,
			approvedDesign,
		};
		await writeFixContext(input.store, input.ref, context);
	}
	let checkpoint = context.stage === "implemented" ? context.implementationCheckpoint : input.checkpoint;
	if (!checkpoint) {
		const implemented = await input.implementation.implement({
			approvedDesign,
			goal: input.origin.goal,
			checkpointSequence: 2,
			createdAt: input.completedAt(),
		});
		checkpoint = implemented.checkpoint;
	}
	if (context.stage !== "implemented") {
		context = {
			...context,
			stage: "implemented",
			attemptId: checkpoint.attemptId,
			approvedDesign,
			implementationCheckpoint: checkpoint,
		};
		await writeFixContext(input.store, input.ref, context);
	}
	const qualification = await input.qualifier.run({
		workflow: "fix",
		approvedDesign,
		userOrigin: input.origin,
		redEvidence: evidence,
		checkpointSequence: 3,
		authorizedAt: input.completedAt(),
	});
	return settleQualification(
		"fix",
		qualification,
		checkpoint,
		{
			approvedDesignId: approvedDesign.approvedDesignId,
			redRegressionSubjectDigest: evidence.regressionSubjectDigest,
		},
		input,
	);
}

async function settleQualification(
	workflow: "fix" | "build",
	qualification: QualificationResult,
	checkpoint: MutationPhaseCheckpoint,
	identity: { approvedDesignId: string; redRegressionSubjectDigest?: string },
	input: CommonResume,
): Promise<RunProjection> {
	if (qualification.status === "Committed") return input.store.load(input.ref);
	if (qualification.status === "Blocked") {
		await input.authority.block(qualification.reason, input.completedAt());
		return input.store.load(input.ref);
	}
	const outcome = qualification.status;
	await writeOutcome(
		workflow,
		outcome,
		{
			...identity,
			implementationCheckpoint: checkpoint,
			...(qualification.status === "ChangesRequired" ? { findings: qualification.findings } : {}),
		},
		input,
	);
	await input.authority.complete(outcome, `outputs/${workflow}.json`, input.completedAt());
	return input.store.load(input.ref);
}

async function writeOutcome(
	workflow: "fix" | "build",
	outcome: "ChangesRequired" | "NotVerified" | "Inconclusive",
	extra: {
		approvedDesignId?: string;
		redRegressionSubjectDigest?: string;
		implementationCheckpoint?: MutationPhaseCheckpoint;
		findings?: readonly CanonicalFinding[];
	},
	input: Pick<CommonResume, "store" | "ref" | "trees" | "origin">,
): Promise<void> {
	const before = await input.trees.captureObservation();
	const digest = backendSnapshotDigest(before);
	await input.store.writeArtifact(
		input.ref,
		`outputs/${workflow}.json`,
		Buffer.from(
			canonicalJson({
				schemaVersion: 1,
				proposedOutcome: outcome,
				authoritative: false,
				lifecycleAuthority: "state.json",
				goal: input.origin.goal,
				observationSubjectDigest: observationSubjectDigest(before.observation),
				...extra,
			}),
		),
	);
	const after = await input.trees.captureObservation();
	const afterDigest = backendSnapshotDigest(after);
	if (afterDigest !== digest) throw new SubjectDriftError(digest, afterDigest);
}

async function assertRedContextArtifacts(
	store: RunStore,
	ref: RunRef,
	context: FixWriteContext,
): Promise<void> {
	const record = await store.readArtifact(
		ref,
		`commands/${context.redEvidence.failingRecord.executionId}/record.json`,
	);
	if (record.toString("utf8") !== canonicalJson(context.redEvidence.failingRecord)) {
		throw new Error("Fix context failing record contradicts immutable command record");
	}
	const mutation = await store.readArtifact(ref, context.regressionCheckpoint.mutation.artifact);
	if (createHash("sha256").update(mutation).digest("hex") !== context.regressionCheckpoint.mutation.artifactDigest) {
		throw new Error("Fix context regression mutation artifact digest mismatch");
	}
	const value = JSON.parse(mutation.toString("utf8")) as {
		schemaVersion?: unknown;
		phase?: unknown;
		mutations?: Array<{ path?: unknown; preimageDigest?: unknown; resultDigest?: unknown }>;
		mutationDigest?: unknown;
	};
	if (
		value.schemaVersion !== 1 ||
		value.phase !== "regression" ||
		!Array.isArray(value.mutations) ||
		value.mutations.some(
			(entry) =>
				typeof entry.path !== "string" ||
				(entry.preimageDigest !== null && typeof entry.preimageDigest !== "string") ||
				typeof entry.resultDigest !== "string",
		) ||
		typeof value.mutationDigest !== "string" ||
		value.mutationDigest !== context.regressionCheckpoint.mutation.mutationDigest ||
		canonicalDigest(value.mutations) !== value.mutationDigest
	) {
		throw new Error("Fix context regression mutation artifact is malformed or contradictory");
	}
	const paths = value.mutations.map((entry) => entry.path as string).sort();
	const expected = [...context.redEvidence.regressionChangedPaths].sort();
	if (paths.join("\0") !== expected.join("\0")) {
		throw new Error("Fix context regression paths contradict immutable mutation artifact");
	}
}

function selectorKey(values: readonly { selectorId: string; value: string }[]): string {
	return [...values]
		.map((value) => `${value.selectorId}\0${value.value}`)
		.sort()
		.join("\0");
}

export function checkpointMatchesObservation(
	checkpoint: MutationPhaseCheckpoint,
	observationDigest: string,
	policyDigest: string,
): boolean {
	return checkpoint.subjectDigest === observationDigest && checkpoint.policyDigest === policyDigest;
}

