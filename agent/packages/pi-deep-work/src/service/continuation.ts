import { decodeAgentReport } from "../agents/schemas.ts";
import { canonicalDigest, canonicalJson } from "../policy/canonical-json.ts";
import { ApprovedDesignRecordSchema, decodeDesignData, type ApprovedDesignRecord } from "../review/design.ts";
import { loadDesignHandoff } from "../review/design-handoff.ts";
import { decodeResolutionArtifact } from "../review/resolution.ts";
import { digestFrozenArtifact } from "../review/subjects.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { decode, MutationArtifactSchema, MutationPhaseCheckpointSchema, type MutationPhaseCheckpoint } from "../store/schemas.ts";
import { observationSubjectDigest } from "../subject/content.ts";
import { loadRunRecords } from "./records.ts";
import { assertRedContextArtifacts, readBuildContext, readFixContext, type BuildWriteContext, type FixWriteContext } from "./write-context.ts";

// Newest first. Every edge binds a completed source and its exact summary, not a caller-supplied owner ID.
async function loadContinuationLineage(store: RunStore, ref: RunRef): Promise<RunRef[]> {
	const lineage: RunRef[] = [];
	const initial = await store.load(ref);
	const initialRecords = await loadRunRecords(store, ref);
	let current = ref;
	for (;;) {
		if (lineage.some((entry) => entry.runId === current.runId)) throw new Error("Resolution lineage contains a cycle");
		const state = await store.load(current);
		const records = await loadRunRecords(store, current);
		if (
			current.repositoryId !== ref.repositoryId || current.backend !== ref.backend ||
			state.workflow !== initial.workflow || state.goal !== initial.goal || state.policyDigest !== initial.policyDigest ||
			records.request.workflow !== state.workflow || records.request.goal !== state.goal ||
			records.repository.repositoryId !== current.repositoryId || records.repository.kind !== current.backend ||
			canonicalJson(records.repository) !== canonicalJson(initialRecords.repository)
		) throw new Error("Resolution lineage contradicts repository, backend, workflow, goal, or policy");
		await store.assertNoPublicationMarker(current);
		lineage.push(current);
		const request = records.request;
		const fields = [request.resolutionSourceRunId, request.resolutionArtifactDigest, request.resolutionFeedback];
		if (fields.some(Boolean) && !fields.every(Boolean)) throw new Error("Persisted resolution lineage is incomplete");
		if (!request.resolutionSourceRunId) return lineage;
		const parent = await store.find(request.resolutionSourceRunId);
		const parentState = await store.load(parent);
		if (parentState.lifecycle !== "Completed" || parentState.outcome !== "ChangesRequired") {
			throw new Error("Resolution parent is not completed with ChangesRequired");
		}
		const bytes = await store.readArtifact(parent, parentState.summaryArtifact);
		if (digestFrozenArtifact(bytes) !== request.resolutionArtifactDigest) throw new Error("Resolution source artifact digest changed");
		decodeResolutionArtifact(JSON.parse(bytes.toString("utf8")));
		current = parent;
	}
}

export async function loadContinuationFeedback(store: RunStore, ref: RunRef): Promise<string> {
	const lineage = await loadContinuationLineage(store, ref);
	const feedback: string[] = [];
	for (const owner of lineage.reverse()) {
		const { request } = await loadRunRecords(store, owner);
		if (request.sourceDesignRunId) {
			const source = await loadDesignHandoff(store, request.sourceDesignRunId, ref.repositoryId);
			feedback.push(`Accepted source design decisions:\n\n${canonicalJson(source.design)}`);
			if (source.feedback) feedback.push(source.feedback);
		}
		if (request.designFeedback) feedback.push(request.designFeedback);
		if (request.resolutionFeedback) feedback.push(request.resolutionFeedback);
	}
	return feedback.join("\n\n");
}

export async function loadApprovedDesignContent(store: RunStore, ref: RunRef, record: ApprovedDesignRecord): Promise<string> {
	decodeDesignData(ApprovedDesignRecordSchema, record);
	const path = `approved-designs/${record.approvedDesignId}/record.json`;
	const local = await store.readOptionalArtifact(ref, path);
	// Fresh workflow callers can load their local immutable record before request lineage is needed.
	const request = await store.readOptionalArtifact(ref, "run/request.json");
	const lineage = local && !request ? [ref] : await loadContinuationLineage(store, ref);
	for (const owner of lineage) {
		const durable = owner === ref && local ? local : await store.readOptionalArtifact(owner, path);
		if (!durable) continue;
		if (durable.toString("utf8") !== canonicalJson(record)) {
			throw new Error("Write context approved design contradicts immutable approved-design record");
		}
		const state = await store.load(owner);
		if (record.caller !== state.workflow || record.reviewSubject.observation.repositoryId !== owner.repositoryId || record.reviewSubject.observation.policyDigest !== state.policyDigest) {
			throw new Error("Approved design belongs to another workflow, repository, or policy");
		}
		const bytes = await store.readArtifact(owner, record.design.artifactPath);
		if (digestFrozenArtifact(bytes) !== record.design.artifactDigest) throw new Error("Approved design artifact digest mismatch");
		const content = bytes.toString("utf8");
		const design = decodeAgentReport("design", JSON.parse(content));
		if (design.status !== "ok") throw new Error("Approved design is not an ok structured design");
		return content;
	}
	throw new Error("Approved design immutable record is missing from validated lineage");
}

async function assertDurableCheckpoint(store: RunStore, owner: RunRef, checkpoint: MutationPhaseCheckpoint): Promise<void> {
	const state = await store.load(owner);
	if (checkpoint.runId !== owner.runId || checkpoint.policyDigest !== state.policyDigest) throw new Error("Write checkpoint belongs to another run or policy");
	const durable = await store.readCheckpoint(owner, checkpoint.attemptId, checkpoint.sequence, checkpoint.phase);
	if (!durable || !("mutation" in durable) || canonicalJson(durable) !== canonicalJson(checkpoint)) {
		throw new Error(`Write context checkpoint is missing or contradicts durable store: ${checkpoint.phase}`);
	}
	const bytes = await store.readArtifact(owner, checkpoint.mutation.artifact);
	if (digestFrozenArtifact(bytes) !== checkpoint.mutation.artifactDigest) throw new Error("Write checkpoint mutation artifact digest mismatch");
	const mutation = decode(MutationArtifactSchema, JSON.parse(bytes.toString("utf8")));
	if (mutation.phase !== checkpoint.phase || mutation.mutationDigest !== checkpoint.mutation.mutationDigest || mutation.mutations.length !== checkpoint.mutation.fileCount || canonicalDigest(mutation.mutations) !== mutation.mutationDigest) {
		throw new Error("Write checkpoint mutation artifact contradicts checkpoint");
	}
}

export interface WriteContinuation {
	context: BuildWriteContext | FixWriteContext;
	checkpoint?: MutationPhaseCheckpoint;
	evidenceRef?: RunRef;
	observationDigest: string;
}

export async function loadWriteContinuation(store: RunStore, ref: RunRef): Promise<WriteContinuation | undefined> {
	const lineage = await loadContinuationLineage(store, ref);
	const state = await store.load(ref);
	if (state.lifecycle === "NeedsManualInspection") throw new Error("Interrupted write mutations require manual inspection, not continuation");
	let context: BuildWriteContext | FixWriteContext | undefined;
	let contextIndex = 0;
	for (const [index, owner] of lineage.entries()) {
		context = state.workflow === "build" ? await readBuildContext(store, owner) : await readFixContext(store, owner);
		if (context) { contextIndex = index; break; }
	}
	if (!context) return undefined;
	if (context.workflow !== state.workflow) throw new Error("Write context workflow mismatch");
	const ownerOf = (checkpoint: MutationPhaseCheckpoint): RunRef => {
		const owner = lineage.find((entry) => entry.runId === checkpoint.runId);
		if (!owner) throw new Error("Write checkpoint owner is outside validated resolution lineage");
		return owner;
	};
	let evidenceRef: RunRef | undefined;
	if (context.workflow === "fix") {
		if (context.regressionCheckpoint.phase !== "regression") throw new Error("Fix regression checkpoint has a non-regression phase");
		evidenceRef = ownerOf(context.regressionCheckpoint);
		await assertDurableCheckpoint(store, evidenceRef, context.regressionCheckpoint);
		await assertRedContextArtifacts(store, evidenceRef, context);
	}
	if (context.stage !== "red") await loadApprovedDesignContent(store, ref, context.approvedDesign);
	let checkpoint = context.stage === "implemented" ? context.implementationCheckpoint : undefined;
	if (checkpoint) {
		if (!isImplementationCheckpoint(checkpoint)) throw new Error("Only implement/repair checkpoints may skip implementation");
		await assertDurableCheckpoint(store, ownerOf(checkpoint), checkpoint);
	}
	// An implementation may finish just before context publication or a control boundary.
	if (!checkpoint && context.stage === "approved") {
		const owner = lineage[contextIndex];
		const persisted = await store.readCheckpoint(owner, context.attemptId, state.workflow === "build" ? 1 : 2, "implement");
		if (persisted) {
			checkpoint = decode(MutationPhaseCheckpointSchema, persisted);
			await assertDurableCheckpoint(store, owner, checkpoint);
		}
	}
	// A newer run's checkpoint supersedes every ancestor. A mismatch must not select older matching bytes.
	const checkpointRunId = checkpoint?.runId;
	const checkpointOwnerIndex = checkpointRunId ? lineage.findIndex((owner) => owner.runId === checkpointRunId) : contextIndex;
	for (const owner of lineage.slice(0, Math.max(contextIndex, checkpointOwnerIndex) + 1)) {
		const bytes = await store.readOptionalArtifact(owner, "workflow/latest-repair-checkpoint.json");
		if (!bytes) continue;
		const latest = decode(MutationPhaseCheckpointSchema, JSON.parse(bytes.toString("utf8")));
		if (!latest.phase.startsWith("repair-") || context.stage === "red" || !checkpoint) throw new Error("Latest repair checkpoint has no implemented context or a non-repair phase");
		await assertDurableCheckpoint(store, owner, latest);
		checkpoint = latest;
		break;
	}
	return {
		context,
		...(checkpoint ? { checkpoint } : {}),
		...(evidenceRef ? { evidenceRef } : {}),
		observationDigest: checkpoint?.subjectDigest ?? (context.workflow === "fix" ? context.regressionCheckpoint.subjectDigest : observationSubjectDigest(context.approvedDesign.reviewSubject.observation)),
	};
}

export function isImplementationCheckpoint(checkpoint: MutationPhaseCheckpoint): boolean {
	return checkpoint.phase === "implement" || checkpoint.phase.startsWith("repair-");
}
