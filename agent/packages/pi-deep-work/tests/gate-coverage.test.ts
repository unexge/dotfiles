import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TrustedCommandCatalog, type TrustedCommand } from "../src/gates/catalog.ts";
import { analyzeClaimCoverage } from "../src/gates/coverage.ts";
import { decodeGateRecord, decodeObservationReceipt, type GateRecord } from "../src/gates/schemas.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { evidenceSubjectDigest, observationSubjectDigest } from "../src/subject/content.ts";
import type { GitCandidateSubject, GitCleanObservationSubject } from "../src/subject/types.ts";

const observation: GitCleanObservationSubject = {
	schemaVersion: 1,
	kind: "git",
	repositoryId: "a".repeat(64),
	root: "/repo",
	policyDigest: "b".repeat(64),
	workingDigest: "c".repeat(64),
	changedPathsDigest: "d".repeat(64),
	headOid: "1".repeat(40),
	symbolicRef: "refs/heads/main",
	conflicted: false,
	indexTree: "2".repeat(40),
};
const candidate: GitCandidateSubject = {
	schemaVersion: 1,
	kind: "git",
	observation,
	treeOid: "3".repeat(40),
	patchDigest: "e".repeat(64),
	changedPathsDigest: "f".repeat(64),
	approvedDesignId: "4".repeat(64),
	behaviorContractId: "5".repeat(64),
};
const artifact = { path: "commands/x/output", digest: "6".repeat(64), bytes: 0, complete: true };

async function catalog() {
	return TrustedCommandCatalog.build(
		resolvePolicy(
			decodeMachinePolicy({
				schemaVersion: 1,
				models: {
					gpt: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
					opusReviewers: [{ provider: "test", id: "claude-opus-4.8", thinkingLevel: "max" }],
				},
				concurrency: 2,
				maxRepairRounds: 1,
				commandTimeoutMs: 10_000,
				minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
				minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
				observations: [
					{ id: "one", claimKeys: ["key.one"], argv: ["true"], timeoutMs: 1_000 },
					{ id: "two", claimKeys: ["key.two"], argv: ["false"], timeoutMs: 1_000 },
					{ id: "three", claimKeys: ["key.three"], argv: ["true", "x"], timeoutMs: 1_000 },
				],
				verificationContracts: [],
				selectors: [],
			}),
		),
		"/repo",
	);
}

function record(command: TrustedCommand, passed: boolean): GateRecord {
	const subjectDigest = evidenceSubjectDigest(candidate);
	return decodeGateRecord({
		schemaVersion: 1,
		executionId: randomUUID(),
		source: command.source,
		category: "observation",
		commandId: command.id,
		argvDigest: command.argvDigest(),
		backend: "git",
		subject: candidate,
		subjectDigest,
		beforeObservationDigest: observationSubjectDigest(observation),
		afterObservationDigest: observationSubjectDigest(observation),
		startedAt: "2026-08-25T00:00:00.000Z",
		completedAt: "2026-08-25T00:00:01.000Z",
		durationMs: 1000,
		outcome: passed ? "passed" : "failed",
		exitCode: passed ? 0 : 1,
		terminationSignal: null,
		diagnostic: null,
		stdout: artifact,
		stderr: { ...artifact, path: "commands/x/stderr" },
	});
}

function receipt(command: TrustedCommand, value: GateRecord) {
	return decodeObservationReceipt({
		schemaVersion: 1,
		receiptId: randomUUID(),
		executionId: value.executionId,
		source: command.source,
		category: "observation",
		commandId: command.id,
		argvDigest: command.argvDigest(),
		backend: "git",
		subject: candidate,
		subjectDigest: evidenceSubjectDigest(candidate),
		startedAt: value.startedAt,
		completedAt: value.completedAt,
		durationMs: value.durationMs,
		claimKeys: [...command.claimKeys],
		stdout: value.stdout,
		stderr: value.stderr,
		record: { ...artifact, path: "commands/x/record" },
	});
}

describe("claim coverage", () => {
	it("separates missing, failed, unexecuted, and passing observations", async () => {
		const commands = await catalog();
		const one = commands.observation("one");
		const two = commands.observation("two");
		const three = commands.observation("three");
		const passed = record(one, true);
		const failed = record(two, false);
		const analysis = analyzeClaimCoverage(
			candidate,
			["key.one", "key.two", "key.three", "key.missing"],
			[one, two, three],
			[
				{ command: one, record: passed, receipt: receipt(one, passed) },
				{ command: two, record: failed },
			],
		);
		expect(analysis).toMatchObject({
			missingKeys: ["key.missing"],
			failedObservationIds: ["two"],
			unexecutedObservationIds: ["three"],
		});
		expect(analysis.passingReceiptIds).toHaveLength(1);
	});

	it("accepts exact observation evidence and rejects cross-kind smuggling", async () => {
		const commands = await catalog();
		const one = commands.observation("one");
		const candidateRecord = record(one, true);
		const observationDigest = observationSubjectDigest(observation);
		const observedRecord = decodeGateRecord({
			...candidateRecord,
			subject: observation,
			subjectDigest: observationDigest,
		});
		const observedReceipt = decodeObservationReceipt({
			...receipt(one, candidateRecord),
			subject: observation,
			subjectDigest: observationDigest,
			executionId: observedRecord.executionId,
			record: { ...artifact, path: "commands/observed/record" },
		});
		expect(
			analyzeClaimCoverage(observation, ["key.one"], [one], [
				{ command: one, record: observedRecord, receipt: observedReceipt },
			]),
		).toMatchObject({ missingKeys: [], failedObservationIds: [], inconclusiveObservationIds: [] });
		expect(() => analyzeClaimCoverage(observation, ["key.one"], [one], [{ command: one, record: candidateRecord }])).toThrow(
			"foreign to evidence subject",
		);
		expect(() => analyzeClaimCoverage(candidate, ["key.one"], [one], [{ command: one, record: observedRecord }])).toThrow(
			"foreign to evidence subject",
		);
	});

	it("keeps timeout and incomplete evidence distinct from a failing observation", async () => {
		const commands = await catalog();
		const one = commands.observation("one");
		const timedOut = decodeGateRecord({
			...record(one, true),
			outcome: "timed_out",
			exitCode: null,
			terminationSignal: "SIGTERM",
		});
		const analysis = analyzeClaimCoverage(candidate, ["key.one"], [one], [
			{ command: one, record: timedOut },
		]);
		expect(analysis.failedObservationIds).toEqual([]);
		expect(analysis.inconclusiveObservationIds).toEqual(["one"]);
	});

	it("rejects foreign subjects, backends, commands, argv, and receipt claims", async () => {
		const commands = await catalog();
		const one = commands.observation("one");
		const passed = record(one, true);
		const validReceipt = receipt(one, passed);
		for (const execution of [
			{
				command: one,
				record: {
					...passed,
					subject: observation,
					subjectDigest: observationSubjectDigest(observation),
				},
			},
			{ command: one, record: { ...passed, subjectDigest: "9".repeat(64) } },
			{ command: one, record: { ...passed, backend: "jj" } },
			{ command: one, record: { ...passed, argvDigest: "8".repeat(64) } },
			{ command: one, record: passed, receipt: { ...validReceipt, claimKeys: ["invented"] } },
		]) {
			expect(() => analyzeClaimCoverage(candidate, ["key.one"], [one], [execution as never])).toThrow();
		}
	});
});
