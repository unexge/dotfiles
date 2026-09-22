import { createHash } from "node:crypto";
import { loadApprovedDesignContent } from "../service/continuation.ts";
import type { AgentGateway } from "../agents/gateway.ts";
import type { RunAuthority } from "./run-authority.ts";
import type { UserOrigin } from "./user-origin.ts";
import type { RepairAgent } from "./repair-agent.ts";
import { assertUserOrigin } from "./user-origin.ts";
import { authorizeCommit, type ReceiptEvidence } from "../authorization/authorize.ts";
import {
	assertRedRegressionEvidence,
	completeRedRegressionProof,
	type RedRegressionEvidence,
} from "../authorization/red-regression.ts";
import { validateCommitMessage } from "../authorization/message.ts";
import type { TrustedCommand, TrustedCommandCatalog } from "../gates/catalog.ts";
import { analyzeClaimCoverage, type ObservationExecution } from "../gates/coverage.ts";
import { decodeGateRecord, decodeObservationReceipt } from "../gates/schemas.ts";
import type { GateExecutor } from "../gates/executor.ts";
import type { Normalizer } from "../gates/normalizer.ts";
import type { BackendTreeService } from "../gates/tree-backend.ts";
import type { GitTransactionService } from "../git/transaction.ts";
import type { JjTransactionService } from "../jj/transaction.ts";
import type { ResolvedPolicy } from "../policy/catalog.ts";
import type { ApprovedDesignRecord } from "../review/design.ts";
import type { CanonicalFinding, PanelDiagnostic, ReviewPanel } from "../review/panel.ts";
import { reviewSubjectDigest } from "../review/subjects.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { canonicalDigest, canonicalJson } from "../policy/canonical-json.ts";
import { evidenceSubjectDigest, observationSubjectDigest } from "../subject/content.ts";
import type { CandidateSubject } from "../subject/types.ts";
import { verifyCandidateBehavior } from "../verification/behavior.ts";

type RepairPhase = "quick gates" | "full gates" | "behavior observations" | "code review";

export type QualificationResult =
	| { status: "Committed"; commitId: string }
	| { status: "Blocked"; reason: string; diagnostics?: readonly PanelDiagnostic[] }
	| { status: "ChangesRequired"; findings: readonly CanonicalFinding[]; phase: RepairPhase; repairRounds: number }
	| { status: "NotVerified" }
	| { status: "Inconclusive" };

export interface QualifyAndCommitInput {
	workflow: "fix" | "build";
	approvedDesign: ApprovedDesignRecord;
	userOrigin: UserOrigin;
	redEvidence?: RedRegressionEvidence;
	checkpointSequence: number;
	authorizedAt: string;
	resolutionFeedback?: string;
}

type RoundResult =
	| QualificationResult
	| { status: "Repair"; candidate: CandidateSubject; findings: readonly CanonicalFinding[]; phase: RepairPhase };

type BackendTransaction =
	| { kind: "git"; service: GitTransactionService }
	| { kind: "jj"; service: JjTransactionService };

export class QualifyAndCommit {
	constructor(
		private readonly policy: ResolvedPolicy,
		private readonly catalog: TrustedCommandCatalog,
		private readonly normalizer: Normalizer,
		private readonly trees: BackendTreeService,
		private readonly gates: GateExecutor,
		private readonly panel: ReviewPanel,
		private readonly gateway: AgentGateway,
		private readonly store: RunStore,
		private readonly ref: RunRef,
		private readonly backend: BackendTransaction,
		private readonly repairAgent: RepairAgent | null,
	) {}

	/** Repeats boundary checks intentionally: each collaborator independently owns effects or durable writes. */
	assertRun(
		policy: ResolvedPolicy,
		catalog: TrustedCommandCatalog,
		authority: RunAuthority,
		gateway: AgentGateway,
		trees: BackendTreeService,
		store: RunStore,
		ref: RunRef,
		backendKind: "git" | "jj",
	): void {
		if (
			this.policy !== policy ||
			this.catalog !== catalog ||
			this.gateway !== gateway ||
			this.trees !== trees ||
			this.store !== store ||
			this.ref.directory !== ref.directory ||
			this.ref.runId !== ref.runId ||
			this.ref.repositoryId !== ref.repositoryId ||
			this.ref.backend !== ref.backend ||
			this.backend.kind !== backendKind
		) {
			throw new Error("QualifyAndCommit is bound to another policy, gateway, tree service, run, or backend");
		}
		catalog.assertPolicy(policy);
		gateway.assertAuthority(authority);
		this.panel.assertGateway(gateway);
		this.panel.assertRun(store, ref);
		this.gates.assertRun(authority, store, ref, backendKind);
		this.normalizer.assertRun(authority, policy, trees);
		if (this.backend.kind === "git") this.backend.service.assertRun(authority, store, ref);
		else this.backend.service.assertRun(authority, store, ref, trees);
		this.repairAgent?.assertRun(authority, gateway, trees, store, ref);
	}

	static checkpointSpan(maxRepairRounds: number): number {
		return maxRepairRounds * 2 + 1;
	}

	async run(input: QualifyAndCommitInput): Promise<QualificationResult> {
		assertUserOrigin(input.userOrigin);
		if (input.workflow === "fix") {
			if (!input.redEvidence) throw new Error("Fix qualification requires red-regression evidence");
			assertRedRegressionEvidence(input.redEvidence);
		} else if (input.redEvidence) {
			throw new Error("Build qualification forbids red-regression evidence");
		}
		const state = await this.store.load(this.ref);
		if (state.lifecycle !== "Active") throw new Error("Qualification requires an Active run");
		const progressPath = `qualification/${state.attemptId}.json`;
		const progress = await this.readProgress(progressPath, state.attemptId, input.checkpointSequence);
		if (progress?.phase === "completed") {
			return { status: "Blocked", reason: "qualification already completed in this attempt; start a new attempt" };
		}
		let startRound = progress?.phase === "round" ? progress.round : 0;
		if (progress?.phase === "repairing") {
			const nextRound = progress.round + 1;
			const checkpoint = await this.store.readCheckpoint(
				this.ref,
				state.attemptId,
				input.checkpointSequence + progress.round * 2 + 1,
				`repair-${nextRound}`,
			);
			if (!checkpoint || !("mutation" in checkpoint)) {
				return { status: "Blocked", reason: "repair was interrupted before its mutation checkpoint; manual inspection required" };
			}
			startRound = nextRound;
		}
		for (let round = startRound; round <= this.policy.machine.maxRepairRounds; round++) {
			await this.writeProgress(progressPath, {
				schemaVersion: 1,
				attemptId: state.attemptId,
				baseSequence: input.checkpointSequence,
				phase: "round",
				round,
			});
			const result = await this.runRound(input, round, input.checkpointSequence + round * 2);
			if (result.status !== "Repair") {
				// Every returned non-repair outcome ends this attempt; retry requires resume with a fresh AttemptId.
				await this.writeProgress(progressPath, {
					schemaVersion: 1,
					attemptId: state.attemptId,
					baseSequence: input.checkpointSequence,
					phase: "completed",
					round,
				});
				return result;
			}
			if (!this.repairAgent) {
				const exhausted = { status: "ChangesRequired" as const, findings: result.findings, phase: result.phase, repairRounds: round };
				await this.writeProgress(progressPath, {
					schemaVersion: 1,
					attemptId: state.attemptId,
					baseSequence: input.checkpointSequence,
					phase: "completed",
					round,
				});
				return exhausted;
			}
			const findings = result.findings.filter((finding) => finding.severity !== "suggestion");
			if (findings.length === 0) {
				await this.writeProgress(progressPath, {
					schemaVersion: 1,
					attemptId: state.attemptId,
					baseSequence: input.checkpointSequence,
					phase: "completed",
					round,
				});
				return { status: "ChangesRequired", findings: result.findings, phase: result.phase, repairRounds: round };
			}
			await this.writeProgress(progressPath, {
				schemaVersion: 1,
				attemptId: state.attemptId,
				baseSequence: input.checkpointSequence,
				phase: "repairing",
				round,
			});
			await this.repairAgent.repair({
				round: round + 1,
				candidate: result.candidate,
				approvedDesign: input.approvedDesign,
				findings,
				...(input.resolutionFeedback ? { operatorGuidance: input.resolutionFeedback } : {}),
				checkpointSequence: input.checkpointSequence + round * 2 + 1,
				createdAt: input.authorizedAt,
			});
		}
		throw new Error("Repair loop exceeded configured bound");
	}

	private async runRound(
		input: QualifyAndCommitInput,
		round: number,
		checkpointSequence: number,
	): Promise<RoundResult> {
		if (input.approvedDesign.caller !== input.workflow) throw new Error("Qualification workflow differs from approved design");
		if (input.approvedDesign.behavior.kind !== "contract") throw new Error("Write qualification requires behavior contract");
		const design = await loadApprovedDesignContent(this.store, this.ref, input.approvedDesign);
		const normalization = await this.normalizer.runExactlyTwoPasses();
		const candidate = await this.trees.sealCandidate({
			normalization,
			approvedDesignId: input.approvedDesign.approvedDesignId,
			behaviorContractId: input.approvedDesign.behavior.digest,
		});
		const rendered = await this.trees.renderCandidatePatch(candidate);
		await this.writeImmutableOrVerify(
			`candidates/${evidenceSubjectDigest(candidate)}/patch.git`,
			Buffer.from(rendered.patch),
		);
		const state = await this.store.load(this.ref);
		if (state.lifecycle !== "Active") throw new Error("Candidate checkpoint requires an Active run");
		const controls = await this.store.controls(this.ref);
		await this.store.writeCheckpoint(this.ref, {
			schemaVersion: 1,
			runId: this.ref.runId,
			attemptId: state.attemptId,
			sequence: checkpointSequence,
			phase: "candidate-sealed",
			policyDigest: candidate.observation.policyDigest,
			subjectDigest: evidenceSubjectDigest(candidate),
			eventRevision: state.lastEventRevision,
			controlRevision: controls.revision,
			createdAt: input.authorizedAt,
		});
		const quick = await this.runGroup(this.catalog.commandsFor("quick"), candidate);
		const quickFailure = await this.gateFailure("quick", quick, candidate, round);
		if (quickFailure) return quickFailure;
		const full = await this.runGroup(this.catalog.commandsFor("full"), candidate);
		const fullFailure = await this.gateFailure("full", full, candidate, round);
		if (fullFailure) return fullFailure;
		const behaviorCommands = this.catalog.observations(input.approvedDesign.behavior.contract.observationIds);
		const behaviorEvidence = await this.runGroup(behaviorCommands, candidate);
		const behaviorExecutions = behaviorEvidence.map(toObservationExecution);
		const behavior = verifyCandidateBehavior(candidate, input.approvedDesign, behaviorCommands, behaviorExecutions);
		if (behavior.verdict === "Blocked") return { status: "Blocked", reason: "behavior observation changed candidate" };
		if (behavior.verdict === "NotVerified") {
			await this.writeImmutableOrVerify(
				`verification/${evidenceSubjectDigest(candidate)}/${canonicalDigest(behavior.record)}.json`,
				Buffer.from(canonicalJson(behavior.record)),
			);
			const coverage = analyzeClaimCoverage(candidate, input.approvedDesign.behavior.contract.claimKeys, behaviorCommands, behaviorExecutions);
			if (coverage.missingKeys.length || coverage.inconclusiveObservationIds.length || coverage.unexecutedObservationIds.length) {
				return { status: "Blocked", reason: "behavior observations lack complete stable coverage" };
			}
			return (await this.gateFailure("behavior", behaviorEvidence, candidate, round)) ?? { status: "NotVerified" };
		}
		if (behavior.verdict === "Inconclusive") return { status: "Inconclusive" };
		const codeSubject = { schemaVersion: 1 as const, kind: "candidate-code" as const, candidate };
		const review = await this.panel.review({
			subject: codeSubject,
			frozenArtifact: rendered.patch,
			task: [
				`Review the exact qualified candidate for the operator goal:\n\n${input.userOrigin.goal}`,
				`Approved structured design: ${design}`,
				`Coordinator-minted trusted behavior obligations: ${canonicalJson(input.approvedDesign.behavior)}`,
				...(input.resolutionFeedback ? [`Operator resolution guidance:\n\n${input.resolutionFeedback}`] : []),
			].join("\n\n"),
			recaptureSubjectDigest: async () => {
				let current: Awaited<ReturnType<BackendTreeService["capture"]>>;
				try {
					current = await this.trees.capture();
				} catch {
					return "0".repeat(64);
				}
				const sameObservation = observationSubjectDigest(current.observation) === observationSubjectDigest(candidate.observation);
				const sameTree =
					current.kind === candidate.kind &&
					(current.kind === "git"
						? current.treeId === (candidate.kind === "git" ? candidate.treeOid : "")
						: current.treeDigest === (candidate.kind === "jj" ? candidate.treeDigest : ""));
				return sameObservation && sameTree ? reviewSubjectDigest(codeSubject) : "0".repeat(64);
			},
		});
		if (!review.complete) return { status: "Blocked", reason: "code review panel incomplete", diagnostics: review.diagnostics };
		if (!review.record.approved) {
			return round < this.policy.machine.maxRepairRounds
				? { status: "Repair", candidate, findings: review.findings, phase: "code review" }
				: { status: "ChangesRequired", findings: review.findings, phase: "code review", repairRounds: round };
		}
		const verificationPath = `verification/${evidenceSubjectDigest(candidate)}.json`;
		await this.writeImmutableOrVerify(verificationPath, Buffer.from(canonicalJson(behavior.record)));
		const message = await this.draftMessage(input, candidate);
		const redProof = input.redEvidence
			? completeRedRegressionProof(
					input.redEvidence,
					candidate,
					behaviorEvidence,
					input.approvedDesign.behavior.digest,
				)
			: undefined;
		const authorization = authorizeCommit({
			workflow: input.workflow,
			candidate,
			candidateChangedPaths: rendered.paths,
			approvedDesign: input.approvedDesign,
			quick,
			full,
			behavior: behaviorEvidence,
			codeReview: { subject: codeSubject, panel: review },
			verification: behavior.record,
			message,
			...(redProof ? { redProof } : {}),
			authorizedAt: input.authorizedAt,
			catalog: this.catalog,
			policy: this.policy,
		});
		if (this.backend.kind === "git") {
			const prepared = await this.backend.service.prepare(authorization);
			const recorded = await this.backend.service.publish(prepared);
			return { status: "Committed", commitId: recorded.commitId };
		}
		const prepared = await this.backend.service.prepare(authorization);
		const recorded = await this.backend.service.publish(prepared);
		return { status: "Committed", commitId: recorded.commitId };
	}

	private async readProgress(
		path: string,
		attemptId: string,
		baseSequence: number,
	): Promise<{ phase: "round" | "repairing" | "completed"; round: number } | undefined> {
		try {
			const value = JSON.parse((await this.store.readArtifact(this.ref, path)).toString("utf8")) as {
				schemaVersion?: number;
				attemptId?: string;
				phase?: string;
				round?: number;
				baseSequence?: number;
			};
			if (
				value.schemaVersion !== 1 ||
				value.attemptId !== attemptId ||
				value.baseSequence !== baseSequence ||
				(value.phase !== "round" && value.phase !== "repairing" && value.phase !== "completed") ||
				!Number.isInteger(value.round) ||
				value.round! < 0 ||
				value.round! > this.policy.machine.maxRepairRounds
			) {
				throw new Error("Qualification progress is malformed or belongs to another attempt");
			}
			return { phase: value.phase, round: value.round! };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async writeProgress(
		path: string,
		value: {
			schemaVersion: 1;
			attemptId: string;
			baseSequence: number;
			phase: "round" | "repairing" | "completed";
			round: number;
		},
	): Promise<void> {
		await this.store.writeArtifact(this.ref, path, Buffer.from(canonicalJson(value)));
	}

	private async writeImmutableOrVerify(path: string, content: Buffer): Promise<void> {
		const digest = createHash("sha256").update(content).digest("hex");
		try {
			const written = await this.store.writeImmutableArtifact(this.ref, path, content);
			if (written.digest !== digest) throw new Error(`Artifact digest mismatch: ${path}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (createHash("sha256").update(await this.store.readArtifact(this.ref, path)).digest("hex") !== digest) {
				throw new Error(`Existing qualification artifact contradicts candidate: ${path}`);
			}
		}
	}

	private async runGroup(commands: readonly TrustedCommand[], candidate: CandidateSubject) {
		const evidence: ReceiptEvidence[] = [];
		for (const command of commands) {
			const execution = await this.gates.run(command, candidate);
			evidence.push({ command, execution });
		}
		return evidence;
	}

	private async gateFailure(
		category: "quick" | "full" | "behavior",
		evidence: readonly ReceiptEvidence[],
		candidate: CandidateSubject,
		round: number,
	): Promise<RoundResult | undefined> {
		if (evidence.some((item) => !stableExecution(item, candidate))) {
			return { status: "Blocked", reason: `${category} gate did not produce stable complete evidence` };
		}
		const failed = evidence.filter((item) => item.execution.record.outcome === "failed");
		if (failed.length === 0) return undefined;
		const phase = category === "behavior" ? "behavior observations" : `${category} gates` as const;
		const findings = await Promise.all(
			failed.map(async ({ command, execution }, index): Promise<CanonicalFinding> => ({
				id: `gate:${category}:${command.id}:${index + 1}`,
				reviewerId: `machine-gate/${command.id}`,
				severity: "blocker",
				title: `${category} gate failed: ${command.id}`,
				evidence: [
					`Candidate: ${evidenceSubjectDigest(candidate)}`,
					`Command: ${command.id}; argv digest: ${command.argvDigest()}`,
					`Execution: ${execution.recordArtifact.path}; digest: ${execution.recordArtifact.digest}`,
				],
				recommendation: `Repair the ${category} failure without weakening the approved contract or trusted checks, then rerun complete qualification.`,
				detail: [
					`Trusted command: ${canonicalJson(command.argv)}`,
					`Exit code: ${execution.record.exitCode}`,
					...(execution.record.diagnostic ? [`Diagnostic: ${execution.record.diagnostic}`] : []),
					`stdout:\n${await this.gateOutput(execution.record.stdout.path)}`,
					`stderr:\n${await this.gateOutput(execution.record.stderr.path)}`,
				].join("\n\n"),
			})),
		);
		return round < this.policy.machine.maxRepairRounds
			? { status: "Repair", candidate, findings, phase }
			: { status: "ChangesRequired", findings, phase, repairRounds: round };
	}

	private async gateOutput(path: string): Promise<string> {
		const content = await this.store.readArtifact(this.ref, path);
		const limit = 8 * 1024;
		if (content.length <= limit) return content.toString("utf8");
		return `[truncated ${content.length - limit} leading bytes]\n${content.subarray(content.length - limit).toString("utf8")}`;
	}

	private async draftMessage(input: QualifyAndCommitInput, candidate: CandidateSubject): Promise<string> {
		const fallback = input.workflow === "fix" ? "Fix approved behavior" : "Build approved behavior";
		const settlement = await this.gateway.runSettled({
			kind: "edit",
			label: "commit message",
			task: [
				"Propose only the final local commit message.",
				`Workflow: ${input.workflow}`,
				`Approved design: ${input.approvedDesign.approvedDesignId}`,
				`Candidate: ${evidenceSubjectDigest(candidate)}`,
			].join("\n"),
		});
		if (settlement.ok) {
			try {
				return validateCommitMessage(settlement.result.report.value.output).text;
			} catch {}
		}
		return validateCommitMessage(fallback).text;
	}
}

function stableExecution({ command, execution }: ReceiptEvidence, candidate: CandidateSubject): boolean {
	try {
		const record = decodeGateRecord(execution.record);
		const subjectDigest = evidenceSubjectDigest(candidate);
		const observationDigest = observationSubjectDigest(candidate.observation);
		if (
			record.subjectDigest !== subjectDigest ||
			record.commandId !== command.id || record.argvDigest !== command.argvDigest() ||
			record.source !== command.source || record.category !== command.category ||
			record.beforeObservationDigest !== observationDigest || record.afterObservationDigest !== observationDigest ||
			record.terminationSignal !== null || !record.stdout.complete || !record.stderr.complete ||
			!execution.recordArtifact?.complete
		) return false;
		if (record.outcome === "failed") return !execution.receipt && !execution.receiptArtifact;
		if (record.outcome !== "passed" || !execution.receipt || !execution.receiptArtifact?.complete) return false;
		const receipt = decodeObservationReceipt(execution.receipt);
		return receipt.subjectDigest === subjectDigest && receipt.executionId === record.executionId &&
			receipt.commandId === command.id && receipt.argvDigest === command.argvDigest() &&
			receipt.source === command.source && receipt.category === command.category &&
			canonicalJson(receipt.record) === canonicalJson(execution.recordArtifact) &&
			canonicalJson(receipt.stdout) === canonicalJson(record.stdout) &&
			canonicalJson(receipt.stderr) === canonicalJson(record.stderr);
	} catch {
		return false;
	}
}

function toObservationExecution(evidence: ReceiptEvidence): ObservationExecution {
	return {
		command: evidence.command,
		record: evidence.execution.record,
		...(evidence.execution.receipt ? { receipt: evidence.execution.receipt } : {}),
		...(evidence.execution.receiptArtifact ? { receiptArtifact: evidence.execution.receiptArtifact } : {}),
	};
}
