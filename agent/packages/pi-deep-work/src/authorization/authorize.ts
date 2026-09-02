import { Check } from "typebox/value";
import type { TrustedCommand, TrustedCommandCatalog } from "../gates/catalog.ts";
import { assertTrustedCommand } from "../gates/catalog.ts";
import type { GateExecution } from "../gates/executor.ts";
import { CommandArtifactSchema, GateRecordSchema, ObservationReceiptSchema } from "../gates/schemas.ts";
import { assertSealedCandidate, assertSealedRegression } from "../gates/tree-backend.ts";
import { canonicalDigest } from "../policy/canonical-json.ts";
import type { ResolvedPolicy } from "../policy/catalog.ts";
import { ApprovedDesignRecordSchema, type ApprovedDesignRecord } from "../review/design.ts";
import { assertCompletePanelResult, type PanelResult } from "../review/panel.ts";
import { reviewSubjectDigest, type ReviewSubject } from "../review/subjects.ts";
import { ReviewRecordSchema, VerificationRecordSchema, type VerificationRecord } from "../store/schemas.ts";
import { changedPathsDigest, evidenceSubjectDigest, isCandidateSubject, isRegressionSubject } from "../subject/content.ts";
import { CandidateSubjectSchema, type CandidateSubject, type RegressionSubject } from "../subject/types.ts";
import {
	RedRegressionProofSchema,
	assertCompletedRedRegressionProof,
	type RedRegressionProof,
} from "./red-regression.ts";
export { RedRegressionProofSchema, type RedRegressionProof } from "./red-regression.ts";
import { validateCommitMessage, type ValidatedCommitMessage } from "./message.ts";

export interface ReceiptEvidence {
	command: TrustedCommand;
	execution: GateExecution;
}

export interface CandidateCodeReviewEvidence {
	subject: Extract<ReviewSubject, { kind: "candidate-code" }>;
	panel: Extract<PanelResult, { complete: true }>;
}

export interface AuthorizeCommitInput {
	workflow: "fix" | "build";
	candidate: CandidateSubject;
	candidateChangedPaths: readonly string[];
	approvedDesign: ApprovedDesignRecord;
	quick: readonly ReceiptEvidence[];
	full: readonly ReceiptEvidence[];
	behavior: readonly ReceiptEvidence[];
	codeReview: CandidateCodeReviewEvidence;
	verification: VerificationRecord;
	message: string;
	redProof?: RedRegressionProof;
	authorizedAt: string;
	catalog: TrustedCommandCatalog;
	policy: ResolvedPolicy;
}

export interface AuthorizationReceiptRef {
	receiptId: string;
	artifactDigest: string;
}

const authorizationToken = Symbol("commit-authorization");
const mintedAuthorizations = new WeakMap<object, string>();

export class CommitAuthorization {
	readonly #authorizationBrand = true;

	constructor(
		token: typeof authorizationToken,
		readonly workflow: "fix" | "build",
		readonly candidate: CandidateSubject,
		readonly candidateDigest: string,
		readonly candidateChangedPaths: readonly string[],
		readonly approvedDesignId: string,
		readonly behaviorContractId: string,
		readonly message: ValidatedCommitMessage,
		readonly quickReceipts: readonly AuthorizationReceiptRef[],
		readonly fullReceipts: readonly AuthorizationReceiptRef[],
		readonly behaviorReceipts: readonly AuthorizationReceiptRef[],
		readonly codeReviewDigest: string,
		readonly verificationDigest: string,
		readonly redProofDigest: string | null,
		readonly authorizedAt: string,
	) {
		if (token !== authorizationToken) throw new Error("CommitAuthorization lacks package authority");
		Object.freeze(this);
		mintedAuthorizations.set(this, authorizationDigest(this));
	}
}

export function assertCommitAuthorization(value: CommitAuthorization): void {
	if (mintedAuthorizations.get(value) !== authorizationDigest(value)) {
		throw new Error("CommitAuthorization was not minted by authorizeCommit or was modified");
	}
	assertSealedCandidate(value.candidate);
}

export function authorizeCommit(input: AuthorizeCommitInput): CommitAuthorization {
	assertSealedCandidate(input.candidate);
	if (!Check(CandidateSubjectSchema, input.candidate)) throw new Error("Invalid candidate subject");
	if (input.candidate.kind === "jj" && input.candidate.observation.conflicted) throw new Error("Conflicted candidate cannot be authorized");
	if (!Check(ApprovedDesignRecordSchema, input.approvedDesign)) throw new Error("Invalid approved-design record");
	if (input.approvedDesign.caller !== input.workflow) throw new Error("Approved design belongs to another workflow");
	if (input.approvedDesign.approvedDesignId !== input.candidate.approvedDesignId) {
		throw new Error("Candidate does not name its approved design");
	}
	if (input.approvedDesign.behavior.kind !== "contract") throw new Error("Write authorization requires a behavior contract");
	if (input.approvedDesign.behavior.digest !== input.candidate.behaviorContractId) {
		throw new Error("Candidate does not name its behavior contract");
	}
	if (input.policy.digest !== input.candidate.observation.policyDigest) throw new Error("Candidate policy digest is stale");
	assertBaseline(input.approvedDesign, input.candidate);
	const candidateDigest = evidenceSubjectDigest(input.candidate);
	const paths = sorted(input.candidateChangedPaths);
	if (paths.length === 0) throw new Error("Commit authorization requires at least one candidate path");
	if (changedPathsDigest(paths) !== input.candidate.changedPathsDigest) throw new Error("Candidate changed paths do not match digest");

	const quick = validateReceiptGroup(input.catalog.commandsFor("quick"), input.quick, input.candidate, "quick");
	const full = validateReceiptGroup(input.catalog.commandsFor("full"), input.full, input.candidate, "full");
	const behaviorCommands = input.catalog.observations(input.approvedDesign.behavior.contract.observationIds);
	const behavior = validateReceiptGroup(behaviorCommands, input.behavior, input.candidate, "observation");
	const allReceiptIds = [...quick, ...full, ...behavior].map((receipt) => receipt.receiptId);
	if (new Set(allReceiptIds).size !== allReceiptIds.length) throw new Error("One receipt cannot satisfy multiple authorization groups");

	validateCodeReview(input.codeReview, input.candidate, input.policy);
	validateVerification(input.verification, input.candidate, input.approvedDesign, behavior);
	let redProofDigest: string | null = null;
	if (input.workflow === "fix") {
		if (!input.redProof) throw new Error("Fix authorization requires a red-regression proof");
		assertCompletedRedRegressionProof(input.redProof);
		validateRedProof(input.redProof, input.candidate, paths, input.approvedDesign, input.behavior);
		redProofDigest = canonicalDigest(input.redProof);
	} else if (input.redProof) {
		throw new Error("Build authorization forbids a red-regression proof");
	}
	const message = validateCommitMessage(input.message);
	if (new Date(input.authorizedAt).toISOString() !== input.authorizedAt) throw new Error("Authorization timestamp is not canonical");
	return new CommitAuthorization(
		authorizationToken,
		input.workflow,
		input.candidate,
		candidateDigest,
		Object.freeze(paths),
		input.candidate.approvedDesignId,
		input.candidate.behaviorContractId,
		message,
		Object.freeze(quick),
		Object.freeze(full),
		Object.freeze(behavior),
		canonicalDigest(input.codeReview.panel.record),
		canonicalDigest(input.verification),
		redProofDigest,
		input.authorizedAt,
	);
}

function validateReceiptGroup(
	expected: readonly TrustedCommand[],
	provided: readonly ReceiptEvidence[],
	candidate: CandidateSubject,
	category: "quick" | "full" | "observation",
): AuthorizationReceiptRef[] {
	const expectedById = new Map(expected.map((command) => [command.id, command]));
	if (expectedById.size !== expected.length || provided.length !== expected.length) {
		throw new Error(`Authorization ${category} receipt set is incomplete or duplicated`);
	}
	const candidateDigest = evidenceSubjectDigest(candidate);
	const seen = new Set<string>();
	const refs: AuthorizationReceiptRef[] = [];
	for (const evidence of provided) {
		assertTrustedCommand(evidence.command);
		const command = expectedById.get(evidence.command.id);
		if (!command || command !== evidence.command || seen.has(command.id)) throw new Error(`Foreign or duplicate ${category} command`);
		seen.add(command.id);
		const { record, receipt, receiptArtifact } = evidence.execution;
		if (
			!Check(GateRecordSchema, record) ||
			!receipt ||
			!Check(ObservationReceiptSchema, receipt) ||
			!receiptArtifact ||
			!Check(CommandArtifactSchema, receiptArtifact) ||
			record.outcome !== "passed" ||
			!isCandidateSubject(record.subject) ||
			!isCandidateSubject(receipt.subject) ||
			record.subjectDigest !== candidateDigest ||
			receipt.subjectDigest !== candidateDigest ||
			evidenceSubjectDigest(record.subject) !== candidateDigest ||
			evidenceSubjectDigest(receipt.subject) !== candidateDigest ||
			record.commandId !== command.id ||
			receipt.commandId !== command.id ||
			record.executionId !== receipt.executionId ||
			record.argvDigest !== command.argvDigest() ||
			receipt.argvDigest !== command.argvDigest() ||
			record.source !== command.source ||
			receipt.source !== command.source ||
			sorted(receipt.claimKeys).join("\0") !== sorted(command.claimKeys).join("\0") ||
			record.category !== category ||
			receipt.category !== category ||
			!record.stdout.complete ||
			!record.stderr.complete ||
			!receipt.stdout.complete ||
			!receipt.stderr.complete ||
			!receiptArtifact.complete
		) {
			throw new Error(`Ineligible ${category} receipt for ${command.id}`);
		}
		refs.push({ receiptId: receipt.receiptId, artifactDigest: receiptArtifact.digest });
	}
	return refs.sort(compareReceiptRef);
}

function validateCodeReview(
	evidence: CandidateCodeReviewEvidence,
	candidate: CandidateSubject,
	policy: ResolvedPolicy,
): void {
	if (!evidence.panel.complete) throw new Error("Code review panel is incomplete");
	assertCompletePanelResult(evidence.panel);
	if (
		evidence.subject.kind !== "candidate-code" ||
		!Check(CandidateSubjectSchema, evidence.subject.candidate) ||
		!Check(ReviewRecordSchema, evidence.panel.record) ||
		evidenceSubjectDigest(evidence.subject.candidate) !== evidenceSubjectDigest(candidate)
	) {
		throw new Error("Code review names another candidate");
	}
	const expectedSubjectDigest = reviewSubjectDigest(evidence.subject);
	const expectedReviewers = policy.machine.models.reviewers.map((reviewer) => `${reviewer.provider}/${reviewer.id}`);
	if (
		evidence.panel.subjectDigest !== expectedSubjectDigest ||
		evidence.panel.record.subjectDigest !== expectedSubjectDigest ||
		!evidence.panel.record.approved ||
		evidence.panel.record.findingSeverities.some((severity) => severity !== "suggestion") ||
		evidence.panel.record.reviewerIds.join("\0") !== expectedReviewers.join("\0") ||
		evidence.panel.record.completedReviewerIds.join("\0") !== expectedReviewers.join("\0") ||
		evidence.panel.record.artifactDigest !== evidence.panel.panelArtifact.digest ||
		evidence.panel.record.artifactPath !== evidence.panel.panelArtifact.path
	) {
		throw new Error("Code review is incomplete, foreign, or unapproved");
	}
}

function validateVerification(
	record: VerificationRecord,
	candidate: CandidateSubject,
	approvedDesign: ApprovedDesignRecord,
	behaviorReceipts: readonly AuthorizationReceiptRef[],
): void {
	if (!Check(VerificationRecordSchema, record)) throw new Error("Invalid verification record");
	const expectedKeys = sorted(approvedDesign.behavior.kind === "contract" ? approvedDesign.behavior.contract.claimKeys : []);
	if (
		record.subjectDigest !== evidenceSubjectDigest(candidate) ||
		record.contractId !== candidate.behaviorContractId ||
		record.verdict !== "Verified" ||
		sorted(record.coveredClaimKeys).join("\0") !== expectedKeys.join("\0") ||
		record.receiptRefs.slice().sort(compareReceiptRef).map(refKey).join("\0") !==
			behaviorReceipts.slice().sort(compareReceiptRef).map(refKey).join("\0")
	) {
		throw new Error("Verification record does not prove the candidate behavior receipts");
	}
}

function validateRedProof(
	proof: RedRegressionProof,
	candidate: CandidateSubject,
	candidatePaths: readonly string[],
	approvedDesign: ApprovedDesignRecord,
	behaviorEvidence: readonly ReceiptEvidence[],
): void {
	if (!Check(RedRegressionProofSchema, proof) || !isRegressionSubject(proof.regressionSubject)) {
		throw new Error("Invalid red-regression proof");
	}
	assertSealedRegression(proof.regressionSubject);
	if (
		proof.regressionSubjectDigest !== evidenceSubjectDigest(proof.regressionSubject) ||
		changedPathsDigest(sorted(proof.regressionChangedPaths)) !== proof.regressionSubject.changedPathsDigest ||
		!proof.regressionChangedPaths.every((path) => candidatePaths.includes(path)) ||
		proof.behaviorContractId !== candidate.behaviorContractId ||
		proof.candidateSubjectDigest !== evidenceSubjectDigest(candidate) ||
		proof.observationId !== proof.regressionSubject.observationId ||
		proof.argvDigest !== proof.regressionSubject.argvDigest ||
		proof.failingRecord.outcome !== "failed" ||
		!isRegressionSubject(proof.failingRecord.subject) ||
		proof.failingRecord.subjectDigest !== proof.regressionSubjectDigest ||
		proof.failingRecord.commandId !== proof.observationId ||
		proof.failingRecord.argvDigest !== proof.argvDigest ||
		proof.failingRecord.beforeObservationDigest !== proof.failingRecord.afterObservationDigest ||
		!proof.failingRecord.stdout.complete ||
		!proof.failingRecord.stderr.complete
	) {
		throw new Error("Red-regression proof is foreign or not a clean failing observation");
	}
	const contract = approvedDesign.behavior.kind === "contract" ? approvedDesign.behavior.contract : undefined;
	if (
		!contract ||
		!contract.observationIds.includes(proof.observationId) ||
		!proof.claimKeys.every((key) => contract.claimKeys.includes(key))
	) {
		throw new Error("Behavior contract does not cover the red observation");
	}
	const passing = behaviorEvidence.find((evidence) => evidence.command.id === proof.observationId);
	if (
		!passing ||
		sorted(proof.claimKeys).join("\0") !== sorted(passing.command.claimKeys).join("\0") ||
		!passing.execution.receipt ||
		passing.execution.receipt.receiptId !== proof.passingReceiptId ||
		passing.execution.receiptArtifact?.digest !== proof.passingReceiptArtifactDigest
	) {
		throw new Error("Red proof does not name the final passing behavior receipt");
	}
	assertBaselineAgainstRegression(proof.regressionSubject, candidate);
}

function assertBaseline(approvedDesign: ApprovedDesignRecord, candidate: CandidateSubject): void {
	const designObservation = approvedDesign.reviewSubject.observation;
	const candidateObservation = candidate.observation;
	if (
		designObservation.kind !== candidate.kind ||
		designObservation.repositoryId !== candidateObservation.repositoryId ||
		designObservation.root !== candidateObservation.root ||
		designObservation.policyDigest !== candidateObservation.policyDigest
	) {
		throw new Error("Approved design and candidate have different repository baselines");
	}
	if (candidate.kind === "git" && candidateObservation.kind === "git" && designObservation.kind === "git") {
		if (
			designObservation.conflicted ||
			designObservation.headOid !== candidateObservation.headOid ||
			designObservation.symbolicRef !== candidateObservation.symbolicRef ||
			designObservation.indexTree !== candidateObservation.indexTree
		) {
			throw new Error("Git candidate baseline differs from approved design");
		}
	} else if (candidate.kind === "jj" && candidateObservation.kind === "jj" && designObservation.kind === "jj") {
		if (
			designObservation.workspaceId !== candidateObservation.workspaceId ||
			designObservation.changeId !== candidateObservation.changeId ||
			designObservation.parentCommitIds.join("\0") !== candidateObservation.parentCommitIds.join("\0")
		) {
			throw new Error("Jujutsu candidate baseline differs from approved design");
		}
	}
}

function assertBaselineAgainstRegression(regression: RegressionSubject, candidate: CandidateSubject): void {
	if (regression.kind === "git-regression" && candidate.kind === "git") {
		if (
			regression.baseline.headOid !== candidate.observation.headOid ||
			regression.baseline.symbolicRef !== candidate.observation.symbolicRef ||
			regression.baseline.indexTree !== candidate.observation.indexTree
		) {
			throw new Error("Git red proof baseline differs from candidate");
		}
	} else if (regression.kind === "jj-regression" && candidate.kind === "jj") {
		if (
			regression.baseline.workspaceId !== candidate.observation.workspaceId ||
			regression.baseline.changeId !== candidate.observation.changeId ||
			regression.baseline.parentCommitIds.join("\0") !== candidate.observation.parentCommitIds.join("\0")
		) {
			throw new Error("Jujutsu red proof baseline differs from candidate");
		}
	} else {
		throw new Error("Red proof backend differs from candidate");
	}
}

function sorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function compareReceiptRef(left: AuthorizationReceiptRef, right: AuthorizationReceiptRef): number {
	return left.receiptId < right.receiptId ? -1 : left.receiptId > right.receiptId ? 1 : 0;
}

function refKey(value: AuthorizationReceiptRef): string {
	return `${value.receiptId}:${value.artifactDigest}`;
}

export function commitAuthorizationDigest(value: CommitAuthorization): string {
	assertCommitAuthorization(value);
	return authorizationDigest(value);
}

function authorizationDigest(value: CommitAuthorization): string {
	return canonicalDigest({
		workflow: value.workflow,
		candidate: value.candidate,
		candidateDigest: value.candidateDigest,
		candidateChangedPaths: value.candidateChangedPaths,
		approvedDesignId: value.approvedDesignId,
		behaviorContractId: value.behaviorContractId,
		message: value.message,
		quickReceipts: value.quickReceipts,
		fullReceipts: value.fullReceipts,
		behaviorReceipts: value.behaviorReceipts,
		codeReviewDigest: value.codeReviewDigest,
		verificationDigest: value.verificationDigest,
		redProofDigest: value.redProofDigest,
		authorizedAt: value.authorizedAt,
	});
}
