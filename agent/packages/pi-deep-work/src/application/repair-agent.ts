import type { AgentGateway } from "../agents/gateway.ts";
import type { RunAuthority } from "./run-authority.ts";
import { mutationEffectOptions, settleMutationError } from "./mutation-owner.ts";
import type { AgentLanguage } from "../agents/prompt-loader.ts";
import type { BackendTreeService } from "../gates/tree-backend.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { ApprovedDesignRecord } from "../review/design.ts";
import type { CanonicalFinding } from "../review/panel.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { observationSubjectDigest } from "../subject/content.ts";
import type { CandidateSubject } from "../subject/types.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { persistMutationCheckpoint } from "../workspace/checkpoint.ts";
import { MutationPhase } from "../workspace/mutation-phase.ts";
import { createWorkspaceTools } from "../workspace/tools.ts";

export interface RepairInput {
	round: number;
	candidate: CandidateSubject;
	approvedDesign: ApprovedDesignRecord;
	findings: readonly CanonicalFinding[];
	checkpointSequence: number;
	createdAt: string;
	operatorGuidance?: string;
	language?: AgentLanguage;
}

export class RepairAgent {
	constructor(
		private readonly authority: RunAuthority,
		private readonly baseGateway: AgentGateway,
		private readonly boundary: WorkspaceBoundary,
		private readonly trees: BackendTreeService,
		private readonly store: RunStore,
		private readonly ref: RunRef,
	) {}

	assertRun(
		authority: RunAuthority,
		gateway: AgentGateway,
		trees: BackendTreeService,
		store: RunStore,
		ref: RunRef,
	): void {
		if (
			this.authority !== authority ||
			this.baseGateway !== gateway ||
			this.trees !== trees ||
			this.store !== store ||
			this.ref.directory !== ref.directory ||
			this.ref.runId !== ref.runId ||
			this.ref.repositoryId !== ref.repositoryId ||
			this.ref.backend !== ref.backend
		) {
			throw new Error("RepairAgent is bound to another authority, gateway, tree service, or run");
		}
	}

	async repair(input: RepairInput): Promise<void> {
		if (input.findings.length === 0 || input.findings.every((finding) => finding.severity === "suggestion")) {
			throw new Error("Repair requires at least one blocker or important finding");
		}
		this.baseGateway.assertAuthority(this.authority);
		const phase = new MutationPhase(`repair-${input.round}`);
		const reason = `Repair ${input.round} left the checkout without a complete mutation checkpoint`;
		const options = mutationEffectOptions(phase, reason);
		try {
			const gateway = this.baseGateway.withWorkspaceTools(createWorkspaceTools(this.boundary, phase));
			const result = await gateway.runMutation(
				{
					kind: "repair",
					label: `repair round ${input.round}`,
					task: [
						"Repair only the validated blocker/important findings against the exact approved design and candidate.",
						`Approved design: ${input.approvedDesign.approvedDesignId}`,
						`Candidate: ${canonicalJson(input.candidate)}`,
						`Findings: ${canonicalJson(input.findings)}`,
						...(input.operatorGuidance ? ["Operator resolution guidance:", input.operatorGuidance] : []),
						"Return exact changed paths and an empty testSelectors array.",
					].join("\n\n"),
					...(input.language ? { language: input.language } : {}),
				},
				options,
			);
			if (result.report.value.status !== "ok") throw new Error(`Repair agent returned ${result.report.value.status}`);
			const completed = phase.complete();
			if (completed.mutations.length === 0) throw new Error("Repair agent made no workspace mutation");
			const reported = [...new Set(result.report.value.changes.map((change) => change.path))].sort();
			const actual = completed.mutations.map((mutation) => mutation.path).sort();
			if (reported.join("\0") !== actual.join("\0")) {
				throw new Error("Repair report changed paths do not match authoritative mutation records");
			}
			const snapshot = await this.trees.captureMutationObservation(options);
			if (snapshot.observation.conflicted) throw new Error("Repair produced checkout conflicts");
			const subjectDigest = observationSubjectDigest(snapshot.observation);
			const state = await this.store.load(this.ref);
			if (state.lifecycle !== "Active") throw new Error("Repair checkpoint requires an Active run");
			const controls = await this.store.controls(this.ref);
			await persistMutationCheckpoint(
				this.store,
				this.ref,
				{
					schemaVersion: 1,
					runId: this.ref.runId,
					attemptId: state.attemptId,
					sequence: input.checkpointSequence,
					phase: `repair-${input.round}`,
					policyDigest: snapshot.observation.policyDigest,
					subjectDigest,
					eventRevision: state.lastEventRevision,
					controlRevision: controls.revision,
					createdAt: input.createdAt,
				},
				phase,
				async () =>
					observationSubjectDigest((await this.trees.captureMutationObservation(options)).observation),
			);
		} catch (error) {
			return settleMutationError(this.authority, phase, error, reason, input.createdAt);
		}
	}
}
