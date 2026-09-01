import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeGateRecord, decodeObservationReceipt, GateDataDecodeError } from "../src/gates/schemas.ts";
import { observationSubjectDigest } from "../src/subject/content.ts";
import type { GitCleanObservationSubject } from "../src/subject/types.ts";

const subject: GitCleanObservationSubject = {
	schemaVersion: 1,
	kind: "git",
	repositoryId: "a".repeat(64),
	root: "/repo",
	policyDigest: "b".repeat(64),
	workingDigest: "c".repeat(64),
	changedPathsDigest: "d".repeat(64),
	headOid: "e".repeat(40),
	symbolicRef: "refs/heads/main",
	conflicted: false,
	indexTree: "f".repeat(40),
};
const digest = observationSubjectDigest(subject);
const artifact = { path: "commands/x/stdout.bin", digest: "1".repeat(64), bytes: 0, complete: true };
const record = {
	schemaVersion: 1,
	executionId: randomUUID(),
	source: "machine",
	category: "quick",
	commandId: "check",
	argvDigest: "2".repeat(64),
	backend: "git",
	subject,
	subjectDigest: digest,
	beforeObservationDigest: digest,
	afterObservationDigest: digest,
	startedAt: "2026-08-25T00:00:00.000Z",
	completedAt: "2026-08-25T00:00:01.000Z",
	durationMs: 1000,
	outcome: "passed",
	exitCode: 0,
	terminationSignal: null,
	diagnostic: null,
	stdout: artifact,
	stderr: { ...artifact, path: "commands/x/stderr.bin" },
};

describe("gate schemas", () => {
	it("accepts one internally consistent record and receipt", () => {
		const decoded = decodeGateRecord(record);
		expect(decoded.outcome).toBe("passed");
		expect(
			decodeObservationReceipt({
				schemaVersion: 1,
				receiptId: randomUUID(),
				executionId: record.executionId,
				source: record.source,
				category: record.category,
				commandId: record.commandId,
				argvDigest: record.argvDigest,
				backend: record.backend,
				subject,
				subjectDigest: digest,
				startedAt: record.startedAt,
				completedAt: record.completedAt,
				durationMs: record.durationMs,
				claimKeys: ["behavior.ok"],
				stdout: artifact,
				stderr: record.stderr,
				record: { ...artifact, path: "commands/x/record.json" },
			}),
		).toMatchObject({ backend: "git" });
	});

	it("rejects contradictory outcomes, subjects, and incomplete receipt artifacts", () => {
		for (const value of [
			{ ...record, exitCode: 1 },
			{ ...record, outcome: "drifted" },
			{ ...record, subjectDigest: "9".repeat(64) },
			{ ...record, backend: "jj" },
		]) {
			expect(() => decodeGateRecord(value)).toThrow(GateDataDecodeError);
		}
		const baseReceipt = {
			schemaVersion: 1,
			receiptId: randomUUID(),
			executionId: record.executionId,
			source: record.source,
			category: record.category,
			commandId: record.commandId,
			argvDigest: record.argvDigest,
			backend: record.backend,
			subject,
			subjectDigest: digest,
			startedAt: record.startedAt,
			completedAt: record.completedAt,
			durationMs: record.durationMs,
			claimKeys: [],
			stdout: { ...artifact, complete: false },
			stderr: record.stderr,
			record: { ...artifact, path: "commands/x/record.json" },
		};
		expect(() => decodeObservationReceipt(baseReceipt)).toThrow(GateDataDecodeError);
	});
});
