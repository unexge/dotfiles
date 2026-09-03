import type { AgentGateway } from "../agents/gateway.ts";
import type { TrustedCommand, TrustedCommandCatalog, TrustedSelectorResolution } from "../gates/catalog.ts";
import type { GateExecutor } from "../gates/executor.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { BackendTreeService, BackendTreeSnapshot } from "../gates/tree-backend.ts";
import {
	mintRedRegressionEvidence,
	type RedRegressionEvidence,
} from "../authorization/red-regression.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import type { MutationPhaseCheckpoint } from "../store/schemas.ts";
import { observationSubjectDigest } from "../subject/content.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { persistMutationCheckpoint } from "../workspace/checkpoint.ts";
import { MutationPhase } from "../workspace/mutation-phase.ts";
import { createWorkspaceTools } from "../workspace/tools.ts";
import { assertWriteBaseline, type WriteBaseline } from "./begin-write.ts";
import { mutationEffectOptions, settleMutationError } from "./mutation-owner.ts";
import type { RunAuthority } from "./run-authority.ts";

export interface RegressionInput {
	baseline: WriteBaseline;
	goal: string;
	investigation: unknown;
	checkpointSequence: number;
	createdAt: string;
}

export interface RegressionResult {
	checkpoint: MutationPhaseCheckpoint;
	evidence: RedRegressionEvidence;
	command: TrustedCommand;
	selectorProposals: readonly { selectorId: string; value: string }[];
}

export class RegressionAgent {
	constructor(
		private readonly authority: RunAuthority,
		private readonly baseGateway: AgentGateway,
		private readonly boundary: WorkspaceBoundary,
		private readonly catalog: TrustedCommandCatalog,
		private readonly trees: BackendTreeService,
		private readonly gates: GateExecutor,
		private readonly store: RunStore,
		private readonly ref: RunRef,
	) {}

	assertRun(
		authority: RunAuthority,
		gateway: AgentGateway,
		boundary: WorkspaceBoundary,
		catalog: TrustedCommandCatalog,
		trees: BackendTreeService,
		gates: GateExecutor,
		store: RunStore,
		ref: RunRef,
	): void {
		if (
			this.authority !== authority ||
			this.baseGateway !== gateway ||
			this.boundary !== boundary ||
			this.catalog !== catalog ||
			this.trees !== trees ||
			this.gates !== gates ||
			this.store !== store ||
			this.ref.directory !== ref.directory ||
			this.ref.runId !== ref.runId ||
			this.ref.repositoryId !== ref.repositoryId ||
			this.ref.backend !== ref.backend
		) {
			throw new Error("RegressionAgent is bound to another authority, gateway, evidence service, or run");
		}
	}

	async capture(input: RegressionInput): Promise<RegressionResult> {
		assertWriteBaseline(input.baseline);
		this.baseGateway.assertAuthority(this.authority);
		const baseline = baselineSnapshot(input.baseline);
		const phase = new MutationPhase("regression");
		const reason = "Regression mutation lacks a complete checkpoint";
		const options = mutationEffectOptions(phase, reason);
		let checkpoint: MutationPhaseCheckpoint;
		let command: TrustedCommand;
		let mutationPaths: string[];
		let selectorProposals: readonly { selectorId: string; value: string }[];
		try {
			const gateway = this.baseGateway.withWorkspaceTools(createWorkspaceTools(this.boundary, phase));
			const result = await gateway.runMutation(
				{
					kind: "implement",
					label: "write regression only",
					task: [
						`Add only the narrow executable regression for this bug: ${input.goal}`,
						`Investigation: ${JSON.stringify(input.investigation)}`,
						`Trusted selector choices: ${canonicalJson(this.catalog.selectorGuide())}`,
						"Do not change production behavior. Return exactly one selector from these choices and the exact changed paths.",
					].join("\n\n"),
				},
				options,
			);
			if (result.report.value.status !== "ok") throw new RegressionAgentStatusError(result.report.value.status);
			if (result.report.value.testSelectors.length === 0) throw new Error("Regression agent returned no test selector");
			const resolutions = result.report.value.testSelectors.map((proposal) => this.catalog.resolveSelector(proposal));
			command = oneObservationCommand(resolutions);
			const completed = phase.complete();
			if (completed.mutations.length === 0) throw new Error("Regression agent made no workspace mutation");
			const reported = [...new Set(result.report.value.changes.map((change) => change.path))].sort();
			const actual = completed.mutations.map((mutation) => mutation.path).sort();
			mutationPaths = actual;
			if (reported.join("\0") !== actual.join("\0")) {
				throw new Error("Regression report changed paths do not match authoritative mutation records");
			}
			// Project-owned selector patterns define regression-eligible paths; generic filename heuristics are not authoritative.
			const selectorPaths = [...new Set(resolutions.map((resolution) => resolution.value))].sort();
			if (selectorPaths.join("\0") !== actual.join("\0")) {
				throw new Error("Regression mutation paths must exactly match resolved selector paths");
			}
			selectorProposals = Object.freeze(
				resolutions.map((resolution) => ({ selectorId: resolution.selectorId, value: resolution.value })),
			);
			const snapshot = await this.trees.captureMutationObservation(options);
			if (snapshot.observation.conflicted) throw new Error("Regression mutation produced checkout conflicts");
			const subjectDigest = observationSubjectDigest(snapshot.observation);
			const state = await this.store.load(this.ref);
			if (state.lifecycle !== "Active") throw new Error("Regression checkpoint requires an Active run");
			const controls = await this.store.controls(this.ref);
			checkpoint = await persistMutationCheckpoint(
				this.store,
				this.ref,
				{
					schemaVersion: 1,
					runId: this.ref.runId,
					attemptId: state.attemptId,
					sequence: input.checkpointSequence,
					phase: "regression",
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
		const regressionSubject = await this.trees.sealRegression(baseline, command);
		const failingExecution = await this.gates.run(command, regressionSubject);
		if (failingExecution.record.outcome !== "failed") {
			// The checkpointed regression remains uncommitted for inspection; rollback of the live checkout is forbidden.
			throw new RegressionNotRedError(`Regression observation was ${failingExecution.record.outcome}, not a clean failure`);
		}
		const evidence = mintRedRegressionEvidence({
			regressionSubject,
			regressionChangedPaths: mutationPaths,
			checkpoint,
			command,
			failingExecution,
		});
		return { checkpoint, evidence, command, selectorProposals };
	}
}

function baselineSnapshot(baseline: WriteBaseline): BackendTreeSnapshot {
	return baseline.kind === "git"
		? { kind: "git", observation: baseline.observation, treeId: baseline.treeId }
		: { kind: "jj", observation: baseline.observation, treeDigest: baseline.treeDigest };
}

function oneObservationCommand(resolutions: readonly TrustedSelectorResolution[]): TrustedCommand {
	const commands = [...new Set(resolutions.map((resolution) => resolution.command))];
	if (commands.length !== 1) throw new Error("Regression selectors must resolve to exactly one trusted observation");
	return commands[0];
}

export class RegressionAgentStatusError extends Error {
	constructor(readonly status: "blocked" | "failed") {
		super(`Regression agent returned ${status}`);
		this.name = "RegressionAgentStatusError";
	}
}

export class RegressionNotRedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RegressionNotRedError";
	}
}
