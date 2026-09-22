import type { AgentGateway } from "../agents/gateway.ts";
import { DesignApprover } from "../application/approve-design.ts";
import { DesignRevisionAgentStatusError, reviseDesignUntilSettled } from "../application/design-revision.ts";
import type { DesignReport } from "../agents/schemas.ts";
import { ImplementationAgent } from "../application/implementation-agent.ts";
import { ObservationSession } from "../application/observation-session.ts";
import { QualifyAndCommit, type QualificationResult } from "../application/qualify-and-commit.ts";
import type { RunAuthority } from "../application/run-authority.ts";
import type { UserOrigin } from "../application/user-origin.ts";
import type { TrustedCommandCatalog } from "../gates/catalog.ts";
import type { GateExecutor } from "../gates/executor.ts";
import { backendSnapshotDigest, type BackendTreeService } from "../gates/tree-backend.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { CanonicalFinding } from "../review/panel.ts";
import { renderChangesRequiredMarkdown } from "../review/outcome-markdown.ts";
import { digestFrozenArtifact } from "../review/subjects.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import type { MutationPhaseCheckpoint, RunProjection } from "../store/schemas.ts";
import { observationSubjectDigest } from "../subject/content.ts";
import { SubjectDriftError } from "../subject/drift.ts";
import { isImplementationCheckpoint } from "./continuation.ts";
import { assertRedContextArtifacts, restoreRedContextEvidence, writeBuildContext, writeFixContext, type BuildWriteContext, type FixWriteContext } from "./write-context.ts";

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
	resolutionFeedback?: string;
	resolutionDesign?: unknown;
}

export async function resumeBuildFromContext(
	input: CommonResume & { context: BuildWriteContext; checkpoint?: MutationPhaseCheckpoint },
): Promise<RunProjection> {
	await writeBuildContext(input.store, input.ref, input.context);
	let checkpoint = input.checkpoint ?? (input.context.stage === "implemented" ? input.context.implementationCheckpoint : undefined);
	if (checkpoint && !isImplementationCheckpoint(checkpoint)) throw new Error("Only implement/repair checkpoints may skip implementation");
	if (!checkpoint) {
		const implemented = await input.implementation.implement({
			approvedDesign: input.context.approvedDesign,
			goal: input.origin.goal,
			...(input.resolutionFeedback ? { operatorGuidance: input.resolutionFeedback } : {}),
			checkpointSequence: 1,
			createdAt: input.completedAt(),
		});
		checkpoint = implemented.checkpoint;
	}
	await writeBuildContext(input.store, input.ref, {
		...input.context,
		stage: "implemented",
		implementationCheckpoint: checkpoint,
	});
	const qualification = await input.qualifier.run({
		workflow: "build",
		approvedDesign: input.context.approvedDesign,
		userOrigin: input.origin,
		checkpointSequence: 2,
		authorizedAt: input.completedAt(),
		...(input.resolutionFeedback ? { resolutionFeedback: input.resolutionFeedback } : {}),
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
		evidenceRef?: RunRef;
		approver: DesignApprover;
		catalog: TrustedCommandCatalog;
		gates: GateExecutor;
		maxRevisionRounds: number;
	},
): Promise<RunProjection> {
	// Keep immutable record/checkpoint/artifact verification before the package-internal regression reseal.
	await assertRedContextArtifacts(input.store, input.evidenceRef ?? input.ref, input.context);
	await writeFixContext(input.store, input.ref, input.context);
	const evidence = restoreRedContextEvidence(input.context, input.catalog);
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
				`Required regression selectors: ${canonicalJson(input.context.selectorProposals)}`,
				...(input.resolutionDesign ? ["Prior rejected design:", canonicalJson(input.resolutionDesign)] : []),
				...(input.resolutionFeedback ? ["Operator resolution guidance:", input.resolutionFeedback] : []),
				"Preserve the regression and return exactly these data-only test selectors.",
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
		let revised;
		try {
			revised = await reviseDesignUntilSettled({
				initialDesign: designResult.report.value,
				maxRevisionRounds: input.maxRevisionRounds,
				observed,
				context: [
					`Original operator goal: ${input.origin.goal}`,
					`Red evidence: ${canonicalJson(input.context.redEvidence)}`,
					`Required regression selectors: ${canonicalJson(input.context.selectorProposals)}`,
					...(input.resolutionFeedback ? ["Operator resolution guidance:", input.resolutionFeedback] : []),
				],
				validate: (candidate) => {
					if (selectorKey(candidate.testSelectors) !== selectorKey(input.context.selectorProposals)) {
						throw new Error("Resumed fix design selectors differ from red evidence");
					}
				},
				approve: (candidate, priorFindings, priorDesign) => input.approver.approve({
					caller: "fix",
					design: canonicalJson(candidate),
					userOrigin: input.origin,
					expectedObservationDigest,
					selectorProposals: input.context.selectorProposals,
					approvedAt: input.completedAt(),
					...(priorFindings.length > 0 ? { priorFindings } : {}),
					...(priorDesign ? { priorDesign: canonicalJson(priorDesign) } : {}),
					reviewGuidance: [
						...(input.resolutionDesign ? ["Prior rejected design:", canonicalJson(input.resolutionDesign)] : []),
						...(input.resolutionFeedback ? ["Operator resolution guidance:", input.resolutionFeedback] : []),
					].join("\n\n"),
				}),
			});
		} catch (error) {
			if (!(error instanceof DesignRevisionAgentStatusError)) throw error;
			if (error.status === "blocked") await input.authority.block(error.message, input.completedAt());
			else await input.authority.fail(error.message, input.completedAt());
			return input.store.load(input.ref);
		}
		const design = canonicalJson(revised.design);
		const approval = revised.approval;
		await observed.assertCurrent();
		if (approval.status === "Blocked") {
			await input.authority.block("Resumed fix design approval blocked", input.completedAt());
			return input.store.load(input.ref);
		}
		if (approval.status === "ChangesRequired") {
			await writeOutcome(
				"fix",
				"ChangesRequired",
				{ redRegressionSubjectDigest: evidence.regressionSubjectDigest, findings: approval.findings, design: revised.design, designDigest: digestFrozenArtifact(design), designRevisionRounds: revised.revisionRounds },
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
	let checkpoint = input.checkpoint ?? (context.stage === "implemented" ? context.implementationCheckpoint : undefined);
	if (checkpoint && !isImplementationCheckpoint(checkpoint)) throw new Error("Only implement/repair checkpoints may skip implementation");
	if (!checkpoint) {
		const implemented = await input.implementation.implement({
			approvedDesign,
			goal: input.origin.goal,
			...(input.resolutionFeedback ? { operatorGuidance: input.resolutionFeedback } : {}),
			checkpointSequence: 2,
			createdAt: input.completedAt(),
		});
		checkpoint = implemented.checkpoint;
	}
	context = {
		...context,
		stage: "implemented",
		approvedDesign,
		implementationCheckpoint: checkpoint,
	};
	await writeFixContext(input.store, input.ref, context);
	const qualification = await input.qualifier.run({
		workflow: "fix",
		approvedDesign,
		userOrigin: input.origin,
		redEvidence: evidence,
		checkpointSequence: 3,
		authorizedAt: input.completedAt(),
		...(input.resolutionFeedback ? { resolutionFeedback: input.resolutionFeedback } : {}),
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
			...(qualification.status === "ChangesRequired" ? { findings: qualification.findings, phase: qualification.phase, repairRounds: qualification.repairRounds } : {}),
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
		design?: DesignReport;
		designDigest?: string;
		designRevisionRounds?: number;
		phase?: Extract<QualificationResult, { status: "ChangesRequired" }>["phase"];
		repairRounds?: number;
	},
	input: Pick<CommonResume, "store" | "ref" | "trees" | "origin">,
): Promise<void> {
	const before = await input.trees.captureObservation();
	const digest = backendSnapshotDigest(before);
	const markdown = outcome === "ChangesRequired"
		? renderChangesRequiredMarkdown({
				runId: input.ref.runId,
				workflow,
				goal: input.origin.goal,
				phase: extra.phase ?? "design review",
				findings: extra.findings ?? [],
				iterationCount: extra.repairRounds ?? extra.designRevisionRounds,
			})
		: undefined;
	const markdownArtifact = markdown
		? await input.store.writeArtifact(input.ref, `outputs/${workflow}.md`, markdown)
		: undefined;
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
				...(markdown && markdownArtifact
					? { output: [markdown, `Markdown: ${markdownArtifact.path}`, `Resolve: /deep resolve ${input.ref.runId.slice(0, 8)}`].join("\n") }
					: {}),
				observationSubjectDigest: observationSubjectDigest(before.observation),
				...extra,
			}),
		),
	);
	const after = await input.trees.captureObservation();
	const afterDigest = backendSnapshotDigest(after);
	if (afterDigest !== digest) throw new SubjectDriftError(digest, afterDigest);
}

function selectorKey(values: readonly { selectorId: string; value: string }[]): string {
	return [...values]
		.map((value) => `${value.selectorId}\0${value.value}`)
		.sort()
		.join("\0");
}

