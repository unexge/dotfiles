import type { TrustedCommand } from "../gates/catalog.ts";
import { analyzeClaimCoverage, type ObservationExecution } from "../gates/coverage.ts";
import { Check } from "typebox/value";
import { canonicalDigest } from "../policy/canonical-json.ts";
import { VerificationContractSchema, type VerificationContract } from "../policy/schemas.ts";
import { ApprovedDesignRecordSchema, type ApprovedDesignRecord } from "../review/design.ts";
import { VerificationRecordSchema, decode, type VerificationRecord } from "../store/schemas.ts";
import { evidenceSubjectDigest } from "../subject/content.ts";
import type { CandidateSubject, EvidenceSubject, ObservationSubject } from "../subject/types.ts";

export type BehaviorVerdict =
	| { verdict: "Blocked"; reason: "subject-drift" }
	| { verdict: "NotVerified"; record: VerificationRecord }
	| { verdict: "Inconclusive"; record: VerificationRecord }
	| { verdict: "Verified"; record: VerificationRecord };

export function verifyCandidateBehavior(
	candidate: CandidateSubject,
	approvedDesign: ApprovedDesignRecord,
	selectedCommands: readonly TrustedCommand[],
	executions: readonly ObservationExecution[],
): BehaviorVerdict {
	if (!Check(ApprovedDesignRecordSchema, approvedDesign)) throw new Error("Invalid approved design record");
	if (approvedDesign.behavior.kind !== "contract") throw new Error("Behavior verification requires a contract");
	if (
		candidate.approvedDesignId !== approvedDesign.approvedDesignId ||
		candidate.behaviorContractId !== approvedDesign.behavior.digest
	) {
		throw new Error("Candidate was not sealed against this approved design and behavior contract");
	}
	const contract = approvedDesign.behavior.contract;
	assertSelectedObservations(contract.observationIds, selectedCommands, "approved contract");
	return deterministicVerdict(
		candidate,
		approvedDesign.behavior.digest,
		contract.claimKeys,
		selectedCommands,
		executions,
	);
}

// Standalone contract IDs are policy-relative; receipts bind argv and the subject binds the required policyDigest.
export function standaloneVerificationContractId(contract: VerificationContract): string {
	return canonicalDigest({ schemaVersion: 1, kind: "standalone-verification-contract", contract });
}

export function verifyObservedBehavior(
	subject: ObservationSubject,
	contract: VerificationContract,
	selectedCommands: readonly TrustedCommand[],
	executions: readonly ObservationExecution[],
): BehaviorVerdict {
	if (!Check(VerificationContractSchema, contract)) throw new Error("Invalid standalone verification contract");
	assertSelectedObservations(contract.observationIds, selectedCommands, "standalone contract");
	return deterministicVerdict(
		subject,
		standaloneVerificationContractId(contract),
		contract.requiredClaimKeys,
		selectedCommands,
		executions,
	);
}

function assertSelectedObservations(
	expectedObservationIds: readonly string[],
	selectedCommands: readonly TrustedCommand[],
	label: string,
): void {
	const expectedIds = [...expectedObservationIds].sort();
	const selectedIds = selectedCommands.map((command) => command.id).sort();
	if (expectedIds.join("\0") !== selectedIds.join("\0")) {
		throw new Error(`Selected behavior observations do not match the ${label}`);
	}
}

function deterministicVerdict(
	subject: EvidenceSubject,
	contractId: string,
	requiredClaimKeys: readonly string[],
	selectedCommands: readonly TrustedCommand[],
	executions: readonly ObservationExecution[],
): BehaviorVerdict {
	const analysis = analyzeClaimCoverage(subject, requiredClaimKeys, selectedCommands, executions);
	if (executions.some((execution) => execution.record.outcome === "drifted")) {
		return { verdict: "Blocked", reason: "subject-drift" };
	}
	const receiptRefs = executions
		.flatMap((execution) => {
			if (!execution.receipt) return [];
			const receiptArtifact = execution.receiptArtifact;
			if (!receiptArtifact) throw new Error(`Passing behavior receipt lacks immutable artifact: ${execution.command.id}`);
			return [{ receiptId: execution.receipt.receiptId, artifactDigest: receiptArtifact.digest }];
		})
		.sort((left, right) => (left.receiptId < right.receiptId ? -1 : left.receiptId > right.receiptId ? 1 : 0));
	const coveredClaimKeys = [
		...new Set(executions.filter((execution) => execution.receipt).flatMap((execution) => [...execution.command.claimKeys])),
	].sort();
	const verdict =
		analysis.failedObservationIds.length > 0
			? "NotVerified"
			: analysis.missingKeys.length > 0 ||
				  analysis.inconclusiveObservationIds.length > 0 ||
				  analysis.unexecutedObservationIds.length > 0
				? "Inconclusive"
				: "Verified";
	const record = decode(VerificationRecordSchema, {
		schemaVersion: 1,
		subjectDigest: evidenceSubjectDigest(subject),
		contractId,
		coveredClaimKeys,
		verdict,
		receiptRefs,
	});
	return { verdict, record };
}
