import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { uuidPatternSource } from "../application/types.ts";
import { assertTrustedCommand, type TrustedCommand } from "../gates/catalog.ts";
import type { GateExecution } from "../gates/executor.ts";
import { GateRecordSchema } from "../gates/schemas.ts";
import { assertSealedCandidate, assertSealedRegression } from "../gates/tree-backend.ts";
import { canonicalDigest } from "../policy/canonical-json.ts";
import { MutationPhaseCheckpointSchema, type MutationPhaseCheckpoint } from "../store/schemas.ts";
import {
	changedPathsDigest,
	evidenceSubjectDigest,
	isCandidateSubject,
	isRegressionSubject,
	observationSubjectDigest,
} from "../subject/content.ts";
import { RegressionSubjectSchema, type CandidateSubject, type RegressionSubject } from "../subject/types.ts";

const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
const nonEmpty = Type.String({ minLength: 1 });
const relativePath = Type.Refine(Type.String({ minLength: 1, maxLength: 1024 }), (value) => {
	if (value.startsWith("/") || value.includes("\\") || /[\0\n\r]/.test(value)) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
});

export const RedRegressionProofSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		regressionSubject: RegressionSubjectSchema,
		regressionSubjectDigest: digest,
		regressionChangedPaths: Type.Array(relativePath, { minItems: 1 }),
		mutationCheckpointDigest: digest,
		behaviorContractId: digest,
		observationId: nonEmpty,
		argvDigest: digest,
		claimKeys: Type.Array(nonEmpty, { minItems: 1 }),
		failingRecord: GateRecordSchema,
		candidateSubjectDigest: digest,
		passingReceiptId: Type.String({ pattern: uuidPatternSource }),
		passingReceiptArtifactDigest: digest,
	},
	{ additionalProperties: false },
);
export type RedRegressionProof = Static<typeof RedRegressionProofSchema>;

const redEvidenceToken = Symbol("red-regression-evidence");
const evidenceDigests = new WeakMap<object, string>();
const proofDigests = new WeakMap<object, string>();

export class RedRegressionEvidence {
	constructor(
		token: typeof redEvidenceToken,
		readonly regressionSubject: RegressionSubject,
		readonly regressionSubjectDigest: string,
		readonly regressionChangedPaths: readonly string[],
		readonly mutationCheckpointDigest: string,
		readonly observationId: string,
		readonly argvDigest: string,
		readonly claimKeys: readonly string[],
		readonly failingRecord: GateExecution["record"],
	) {
		if (token !== redEvidenceToken) throw new Error("RedRegressionEvidence lacks package authority");
		Object.freeze(this);
		evidenceDigests.set(this, evidenceDigest(this));
	}
}

export function mintRedRegressionEvidence(input: {
	regressionSubject: RegressionSubject;
	regressionChangedPaths: readonly string[];
	checkpoint: MutationPhaseCheckpoint;
	command: TrustedCommand;
	failingExecution: Pick<GateExecution, "record" | "receipt" | "receiptArtifact">;
}): RedRegressionEvidence {
	assertTrustedCommand(input.command);
	assertSealedRegression(input.regressionSubject);
	if (!Check(RegressionSubjectSchema, input.regressionSubject)) throw new Error("Invalid regression subject");
	if (input.command.category !== "observation") throw new Error("Red regression requires a trusted observation command");
	const paths = sorted(input.regressionChangedPaths);
	if (paths.length === 0 || changedPathsDigest(paths) !== input.regressionSubject.changedPathsDigest) {
		throw new Error("Regression mutation paths do not match the sealed regression subject");
	}
	if (!Check(MutationPhaseCheckpointSchema, input.checkpoint) || input.checkpoint.phase !== "regression") {
		throw new Error("Red regression requires a complete regression mutation checkpoint");
	}
	if (
		input.checkpoint.policyDigest !== input.regressionSubject.observation.policyDigest ||
		input.checkpoint.subjectDigest !== observationSubjectDigest(input.regressionSubject.observation) ||
		input.checkpoint.mutation.fileCount !== paths.length
	) {
		throw new Error("Regression mutation checkpoint is foreign to the sealed regression subject");
	}
	if (
		input.regressionSubject.observationId !== input.command.id ||
		input.regressionSubject.argvDigest !== input.command.argvDigest()
	) {
		throw new Error("Regression subject does not name the trusted observation command");
	}
	const { record, receipt, receiptArtifact } = input.failingExecution;
	const observationDigest = observationSubjectDigest(input.regressionSubject.observation);
	const subjectDigest = evidenceSubjectDigest(input.regressionSubject);
	if (
		!Check(GateRecordSchema, record) ||
		receipt ||
		receiptArtifact ||
		record.outcome !== "failed" ||
		record.exitCode === null ||
		record.exitCode === 0 ||
		record.terminationSignal !== null ||
		!record.stdout.complete ||
		!record.stderr.complete ||
		!isRegressionSubject(record.subject) ||
		record.subjectDigest !== subjectDigest ||
		evidenceSubjectDigest(record.subject) !== subjectDigest ||
		record.beforeObservationDigest !== observationDigest ||
		record.afterObservationDigest !== observationDigest ||
		record.commandId !== input.command.id ||
		record.argvDigest !== input.command.argvDigest() ||
		record.category !== "observation" ||
		record.source !== input.command.source
	) {
		throw new Error("Red observation is not one clean, stable failing execution");
	}
	return new RedRegressionEvidence(
		redEvidenceToken,
		input.regressionSubject,
		subjectDigest,
		Object.freeze(paths),
		canonicalDigest(input.checkpoint),
		input.command.id,
		input.command.argvDigest(),
		Object.freeze([...input.command.claimKeys].sort()),
		record,
	);
}

export function assertRedRegressionEvidence(evidence: RedRegressionEvidence): void {
	if (evidenceDigests.get(evidence) !== evidenceDigest(evidence)) {
		throw new Error("Red regression evidence was not coordinator-minted or was modified");
	}
	assertSealedRegression(evidence.regressionSubject);
}

export function completeRedRegressionProof(
	evidence: RedRegressionEvidence,
	candidate: CandidateSubject,
	behaviorEvidence: readonly { command: TrustedCommand; execution: GateExecution }[],
	behaviorContractId: string,
): RedRegressionProof {
	assertRedRegressionEvidence(evidence);
	assertSealedCandidate(candidate);
	const passing = behaviorEvidence.find((item) => item.command.id === evidence.observationId);
	const candidateDigest = evidenceSubjectDigest(candidate);
	if (
		!passing ||
		passing.command.argvDigest() !== evidence.argvDigest ||
		sorted(passing.command.claimKeys).join("\0") !== evidence.claimKeys.join("\0") ||
		passing.execution.record.outcome !== "passed" ||
		passing.execution.record.commandId !== passing.command.id ||
		passing.execution.record.argvDigest !== passing.command.argvDigest() ||
		passing.execution.record.source !== passing.command.source ||
		passing.execution.record.category !== "observation" ||
		passing.execution.record.beforeObservationDigest !== passing.execution.record.afterObservationDigest ||
		passing.execution.record.terminationSignal !== null ||
		!passing.execution.record.stdout.complete ||
		!passing.execution.record.stderr.complete ||
		!isCandidateSubject(passing.execution.record.subject) ||
		passing.execution.record.subjectDigest !== candidateDigest ||
		evidenceSubjectDigest(passing.execution.record.subject) !== candidateDigest ||
		!passing.execution.receipt ||
		!passing.execution.receiptArtifact ||
		passing.execution.receipt.executionId !== passing.execution.record.executionId ||
		passing.execution.receipt.commandId !== passing.command.id ||
		passing.execution.receipt.argvDigest !== passing.command.argvDigest() ||
		passing.execution.receipt.source !== passing.command.source ||
		passing.execution.receipt.category !== "observation" ||
		!passing.execution.receipt.stdout.complete ||
		!passing.execution.receipt.stderr.complete ||
		!passing.execution.receiptArtifact.complete ||
		!isCandidateSubject(passing.execution.receipt.subject) ||
		passing.execution.receipt.subjectDigest !== candidateDigest ||
		evidenceSubjectDigest(passing.execution.receipt.subject) !== candidateDigest
	) {
		throw new Error("Final behavior evidence does not complete the red-to-green proof");
	}
	const proof: RedRegressionProof = {
		schemaVersion: 1,
		regressionSubject: evidence.regressionSubject,
		regressionSubjectDigest: evidence.regressionSubjectDigest,
		regressionChangedPaths: [...evidence.regressionChangedPaths],
		mutationCheckpointDigest: evidence.mutationCheckpointDigest,
		behaviorContractId,
		observationId: evidence.observationId,
		argvDigest: evidence.argvDigest,
		claimKeys: [...evidence.claimKeys],
		failingRecord: evidence.failingRecord,
		candidateSubjectDigest: candidateDigest,
		passingReceiptId: passing.execution.receipt.receiptId,
		passingReceiptArtifactDigest: passing.execution.receiptArtifact.digest,
	};
	if (!Check(RedRegressionProofSchema, proof)) throw new Error("Completed red-regression proof is invalid");
	Object.freeze(proof);
	proofDigests.set(proof, canonicalDigest(proof));
	return proof;
}

export function assertCompletedRedRegressionProof(proof: RedRegressionProof): void {
	if (proofDigests.get(proof) !== canonicalDigest(proof)) {
		throw new Error("Red-regression proof was not completed from coordinator-minted evidence or was modified");
	}
}

function evidenceDigest(evidence: RedRegressionEvidence): string {
	return canonicalDigest({
		regressionSubject: evidence.regressionSubject,
		regressionSubjectDigest: evidence.regressionSubjectDigest,
		regressionChangedPaths: evidence.regressionChangedPaths,
		mutationCheckpointDigest: evidence.mutationCheckpointDigest,
		observationId: evidence.observationId,
		argvDigest: evidence.argvDigest,
		claimKeys: evidence.claimKeys,
		failingRecord: evidence.failingRecord,
	});
}

function sorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
