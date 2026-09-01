import type { AgentGateway } from "../agents/gateway.ts";
import type { AgentLanguage } from "../agents/prompt-loader.ts";
import type { ImplementationReport } from "../agents/schemas.ts";
import type { TrustedCommandCatalog } from "../gates/catalog.ts";
import type { BackendTreeService } from "../gates/tree-backend.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { ApprovedDesignRecord } from "../review/design.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import type { MutationPhaseCheckpoint } from "../store/schemas.ts";
import { observationSubjectDigest } from "../subject/content.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { persistMutationCheckpoint } from "../workspace/checkpoint.ts";
import { MutationPhase } from "../workspace/mutation-phase.ts";
import { createWorkspaceTools } from "../workspace/tools.ts";
import { mutationEffectOptions, settleMutationError } from "./mutation-owner.ts";
import type { RunAuthority } from "./run-authority.ts";

export interface ImplementationInput {
	approvedDesign: ApprovedDesignRecord;
	goal: string;
	checkpointSequence: number;
	createdAt: string;
	language?: AgentLanguage;
}

export interface ImplementationResult {
	report: ImplementationReport;
	checkpoint: MutationPhaseCheckpoint;
}

export class ImplementationAgent {
	constructor(
		private readonly authority: RunAuthority,
		private readonly baseGateway: AgentGateway,
		private readonly boundary: WorkspaceBoundary,
		private readonly catalog: TrustedCommandCatalog,
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
			throw new Error("ImplementationAgent is bound to another authority, gateway, tree service, or run");
		}
	}

	async implement(input: ImplementationInput): Promise<ImplementationResult> {
		this.baseGateway.assertAuthority(this.authority);
		const phase = new MutationPhase("implement");
		const reason = "Implementation left the checkout without a complete mutation checkpoint";
		const options = mutationEffectOptions(phase, reason);
		try {
			const gateway = this.baseGateway.withWorkspaceTools(createWorkspaceTools(this.boundary, phase));
			const result = await gateway.runMutation(
				{
					kind: "implement",
					label: "implement approved design",
					task: [
						`Implement the approved design for the operator goal: ${input.goal}`,
						`Approved design: ${canonicalJson(input.approvedDesign)}`,
						"Modify only files required by the design. Return data-only test selectors and exact changed paths.",
					].join("\n\n"),
					...(input.language ? { language: input.language } : {}),
				},
				options,
			);
			if (result.report.value.status !== "ok") {
				throw new ImplementationAgentStatusError(result.report.value.status);
			}
			for (const proposal of result.report.value.testSelectors) this.catalog.resolveSelector(proposal);
			const completed = phase.complete();
			if (completed.mutations.length === 0) throw new Error("Implementation agent made no workspace mutation");
			const reported = [...new Set(result.report.value.changes.map((change) => change.path))].sort();
			const actual = completed.mutations.map((mutation) => mutation.path).sort();
			if (reported.join("\0") !== actual.join("\0")) {
				throw new Error("Implementation report changed paths do not match authoritative mutation records");
			}
			const snapshot = await this.trees.captureMutationObservation(options);
			if (snapshot.observation.conflicted) throw new Error("Implementation produced checkout conflicts");
			const subjectDigest = observationSubjectDigest(snapshot.observation);
			const state = await this.store.load(this.ref);
			if (state.lifecycle !== "Active") throw new Error("Implementation checkpoint requires an Active run");
			const controls = await this.store.controls(this.ref);
			const checkpoint = await persistMutationCheckpoint(
				this.store,
				this.ref,
				{
					schemaVersion: 1,
					runId: this.ref.runId,
					attemptId: state.attemptId,
					sequence: input.checkpointSequence,
					phase: "implement",
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
			return { report: result.report.value, checkpoint };
		} catch (error) {
			return settleMutationError(this.authority, phase, error, reason, input.createdAt);
		}
	}
}

export class ImplementationAgentStatusError extends Error {
	constructor(readonly status: "blocked" | "failed") {
		super(`Implementation agent returned ${status}`);
		this.name = "ImplementationAgentStatusError";
	}
}
