import { randomUUID } from "node:crypto";
import type { RunAuthority } from "../application/run-authority.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import {
	evidenceBackend,
	evidenceObservation,
	evidenceSubjectDigest,
	isCandidateSubject,
	isRegressionSubject,
	observationSubjectDigest,
} from "../subject/content.ts";
import {
	CandidateSubjectSchema,
	RegressionSubjectSchema,
	type CandidateSubject,
	type EvidenceSubject,
	type ObservationSubject,
	type RegressionSubject,
} from "../subject/types.ts";
import { Check } from "typebox/value";
import { assertTrustedCommand, type TrustedCommand } from "./catalog.ts";
import {
	decodeGateRecord,
	decodeObservationReceipt,
	type CommandArtifact,
	type GateRecord,
	type ObservationReceipt,
} from "./schemas.ts";
import { runSupervisedCommand } from "./supervised-command.ts";
import { assertSealedCandidate, assertSealedRegression } from "./tree-backend.ts";

export interface GateExecution {
	record: GateRecord;
	recordArtifact: CommandArtifact;
	receipt?: ObservationReceipt;
	receiptArtifact?: CommandArtifact;
}

export class GateExecutor {
	constructor(
		private readonly authority: RunAuthority,
		private readonly store: RunStore,
		private readonly ref: RunRef,
		private readonly backend: "git" | "jj",
		private readonly captureSubject: () => Promise<ObservationSubject>,
	) {}

	assertRun(
		authority: RunAuthority,
		store: RunStore,
		ref: RunRef,
		backend: "git" | "jj",
	): void {
		if (
			this.authority !== authority ||
			this.store !== store ||
			this.ref.directory !== ref.directory ||
			this.ref.runId !== ref.runId ||
			this.ref.repositoryId !== ref.repositoryId ||
			this.ref.backend !== ref.backend ||
			this.backend !== backend
		) {
			throw new Error("GateExecutor is bound to another authority, run, or backend");
		}
	}

	run(command: TrustedCommand, evidenceSubject?: CandidateSubject | RegressionSubject): Promise<GateExecution> {
		assertTrustedCommand(command);
		if (
			evidenceSubject &&
			!Check(CandidateSubjectSchema, evidenceSubject) &&
			!Check(RegressionSubjectSchema, evidenceSubject)
		) {
			throw new Error("Bound evidence must be a strict candidate or regression subject");
		}
		return this.authority.runEffect(`command:${command.category}:${command.id}`, (signal) =>
			this.execute(command, signal, evidenceSubject),
		);
	}

	private async execute(
		command: TrustedCommand,
		signal: AbortSignal,
		boundSubject?: CandidateSubject | RegressionSubject,
	): Promise<GateExecution> {
		const executionId = randomUUID();
		const before = await this.captureSubject();
		if (before.kind !== this.backend) throw new Error(`Gate backend mismatch: ${before.kind} != ${this.backend}`);
		const subject: EvidenceSubject = boundSubject ?? before;
		if (isCandidateSubject(subject)) assertSealedCandidate(subject);
		if (isRegressionSubject(subject)) assertSealedRegression(subject);
		if (
			evidenceBackend(subject) !== this.backend ||
			observationSubjectDigest(evidenceObservation(subject)) !== observationSubjectDigest(before)
		) {
			throw new Error("Bound evidence subject does not match the live gate observation");
		}
		if (
			isRegressionSubject(subject) &&
			(command.category !== "observation" ||
				subject.observationId !== command.id ||
				subject.argvDigest !== command.argvDigest())
		) {
			throw new Error("Regression subject does not match the trusted observation command");
		}
		const subjectDigest = evidenceSubjectDigest(subject);
		const beforeObservationDigest = observationSubjectDigest(before);
		const started = Date.now();
		const processResult = await runSupervisedCommand(command.argv, before.root, command.timeoutMs, signal);
		const base = `commands/${executionId}`;
		const stdout = await this.writeOutput(`${base}/stdout.bin`, processResult.stdout, processResult.stdoutComplete);
		const stderr = await this.writeOutput(`${base}/stderr.bin`, processResult.stderr, processResult.stderrComplete);
		let after: ObservationSubject | undefined;
		let afterObservationDigest: string | null = null;
		let diagnostic =
			processResult.diagnostic ??
			(processResult.exitCode === null && processResult.terminationSignal
				? `Command terminated by ${processResult.terminationSignal}`
				: null);
		try {
			after = await this.captureSubject();
			if (after.kind !== this.backend) throw new Error(`Gate backend changed: ${after.kind}`);
			afterObservationDigest = observationSubjectDigest(after);
		} catch (error) {
			diagnostic = `Subject recapture failed: ${error instanceof Error ? error.message : String(error)}`;
			after = undefined;
		}
		const completed = Date.now();
		let outcome: GateRecord["outcome"];
		if (after && afterObservationDigest !== beforeObservationDigest) outcome = "drifted";
		else if (signal.aborted || processResult.status === "cancelled") outcome = "cancelled";
		else if (processResult.status === "timed_out") outcome = "timed_out";
		else if (processResult.status === "output_overflow") outcome = "output_overflow";
		else if (
			processResult.status === "incomplete" ||
			processResult.exitCode === null ||
			!after ||
			!stdout.complete ||
			!stderr.complete
		) {
			outcome = "incomplete";
		} else if (processResult.exitCode !== 0) outcome = "failed";
		else outcome = "passed";
		const record = decodeGateRecord({
			schemaVersion: 1,
			executionId,
			source: command.source,
			category: command.category,
			commandId: command.id,
			argvDigest: command.argvDigest(),
			backend: this.backend,
			subject,
			subjectDigest,
			beforeObservationDigest,
			afterObservationDigest,
			startedAt: new Date(started).toISOString(),
			completedAt: new Date(completed).toISOString(),
			durationMs: Math.max(0, completed - started),
			outcome,
			exitCode: processResult.exitCode,
			terminationSignal: processResult.terminationSignal,
			diagnostic,
			stdout,
			stderr,
		});
		const recordArtifact = await this.writeJson(`${base}/record.json`, record);
		let receipt: ObservationReceipt | undefined;
		let receiptArtifact: CommandArtifact | undefined;
		if (outcome === "passed" && !signal.aborted) {
			receipt = decodeObservationReceipt({
				schemaVersion: 1,
				receiptId: randomUUID(),
				executionId,
				source: command.source,
				category: command.category,
				commandId: command.id,
				argvDigest: command.argvDigest(),
				backend: this.backend,
				subject,
				subjectDigest,
				startedAt: record.startedAt,
				completedAt: record.completedAt,
				durationMs: record.durationMs,
				claimKeys: [...command.claimKeys],
				stdout,
				stderr,
				record: recordArtifact,
			});
			// Publication proves only this command on this subject. A later control may stop the run; only a complete checkpoint makes the receipt eligible.
			receiptArtifact = await this.writeJson(`receipts/${executionId}.json`, receipt);
		}
		if (signal.aborted) throw signal.reason ?? new Error("Gate command was cancelled");
		return { record, recordArtifact, ...(receipt ? { receipt, receiptArtifact } : {}) };
	}

	private async writeOutput(path: string, content: Buffer, complete: boolean): Promise<CommandArtifact> {
		const written = await this.store.writeImmutableArtifact(this.ref, path, content);
		return { path, digest: written.digest, bytes: content.length, complete };
	}

	private async writeJson(path: string, value: unknown): Promise<CommandArtifact> {
		const content = Buffer.from(canonicalJson(value));
		const written = await this.store.writeImmutableArtifact(this.ref, path, content);
		return { path, digest: written.digest, bytes: content.length, complete: true };
	}
}
