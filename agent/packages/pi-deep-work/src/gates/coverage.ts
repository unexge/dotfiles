import { assertTrustedCommand, type TrustedCommand } from "./catalog.ts";
import type { CommandArtifact, GateRecord, ObservationReceipt } from "./schemas.ts";
import { Check } from "typebox/value";
import { evidenceBackend, evidenceSubjectDigest } from "../subject/content.ts";
import { EvidenceSubjectSchema, type EvidenceSubject } from "../subject/types.ts";

export interface ObservationExecution {
	command: TrustedCommand;
	record: GateRecord;
	receipt?: ObservationReceipt;
	receiptArtifact?: CommandArtifact;
}

export interface CoverageAnalysis {
	missingKeys: readonly string[];
	failedObservationIds: readonly string[];
	inconclusiveObservationIds: readonly string[];
	unexecutedObservationIds: readonly string[];
	passingReceiptIds: readonly string[];
}

function sorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function analyzeClaimCoverage(
	subject: EvidenceSubject,
	requiredKeys: readonly string[],
	selectedCommands: readonly TrustedCommand[],
	executions: readonly ObservationExecution[],
): CoverageAnalysis {
	const subjectDigest = evidenceSubjectDigest(subject);
	const backend = evidenceBackend(subject);
	const selected = new Map<string, TrustedCommand>();
	const observedKeys = new Set<string>();
	for (const command of selectedCommands) {
		assertTrustedCommand(command);
		if (command.category !== "observation") throw new Error(`Coverage command is not an observation: ${command.id}`);
		if (selected.has(command.id)) throw new Error(`Duplicate selected observation: ${command.id}`);
		selected.set(command.id, command);
		for (const key of command.claimKeys) observedKeys.add(key);
	}
	const byCommand = new Map<string, ObservationExecution>();
	for (const execution of executions) {
		assertTrustedCommand(execution.command);
		const command = selected.get(execution.command.id);
		if (!command || command !== execution.command) throw new Error(`Execution uses an unselected observation: ${execution.command.id}`);
		if (byCommand.has(command.id)) throw new Error(`Duplicate observation execution: ${command.id}`);
		const record = execution.record;
		if (
			!Check(EvidenceSubjectSchema, record.subject) ||
			record.backend !== backend ||
			record.subjectDigest !== subjectDigest ||
			evidenceSubjectDigest(record.subject) !== subjectDigest ||
			record.commandId !== command.id ||
			record.argvDigest !== command.argvDigest() ||
			record.source !== command.source ||
			record.category !== "observation"
		) {
			throw new Error(`Observation execution is foreign to evidence subject or catalog: ${command.id}`);
		}
		if (execution.receipt) {
			const receipt = execution.receipt;
			if (
				!Check(EvidenceSubjectSchema, receipt.subject) ||
				record.outcome !== "passed" ||
				receipt.backend !== backend ||
				receipt.subjectDigest !== subjectDigest ||
				evidenceSubjectDigest(receipt.subject) !== subjectDigest ||
				receipt.executionId !== record.executionId ||
				receipt.commandId !== command.id ||
				receipt.argvDigest !== command.argvDigest() ||
				receipt.source !== command.source ||
				receipt.category !== "observation" ||
				sorted(receipt.claimKeys).join("\0") !== sorted(command.claimKeys).join("\0")
			) {
				throw new Error(`Observation receipt is foreign or contradicts its record: ${command.id}`);
			}
		}
		byCommand.set(command.id, execution);
	}
	const missingKeys = sorted(requiredKeys.filter((key) => !observedKeys.has(key)));
	const failedObservationIds: string[] = [];
	const inconclusiveObservationIds: string[] = [];
	const unexecutedObservationIds: string[] = [];
	const passingReceiptIds: string[] = [];
	for (const command of selected.values()) {
		const execution = byCommand.get(command.id);
		if (!execution) unexecutedObservationIds.push(command.id);
		else if (execution.record.outcome === "failed") failedObservationIds.push(command.id);
		else if (execution.record.outcome !== "passed" || !execution.receipt) inconclusiveObservationIds.push(command.id);
		else passingReceiptIds.push(execution.receipt.receiptId);
	}
	return Object.freeze({
		missingKeys: Object.freeze(missingKeys),
		failedObservationIds: Object.freeze(sorted(failedObservationIds)),
		inconclusiveObservationIds: Object.freeze(sorted(inconclusiveObservationIds)),
		unexecutedObservationIds: Object.freeze(sorted(unexecutedObservationIds)),
		passingReceiptIds: Object.freeze(sorted(passingReceiptIds)),
	});
}
