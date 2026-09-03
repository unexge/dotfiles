import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TrustedCommandCatalog, type TrustedCommand } from "../src/gates/catalog.ts";
import type { ObservationExecution } from "../src/gates/coverage.ts";
import { decodeGateRecord, decodeObservationReceipt } from "../src/gates/schemas.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { canonicalDigest } from "../src/policy/canonical-json.ts";
import { decodeMachinePolicy, type VerificationContract } from "../src/policy/schemas.ts";
import {
	ApprovedDesignRecordSchema,
	BehaviorContractSchema,
	approvedDesignIdFor,
	decodeDesignData,
	type ApprovedDesignRecord,
} from "../src/review/design.ts";
import { reviewSubjectDigest } from "../src/review/subjects.ts";
import { evidenceSubjectDigest, observationSubjectDigest } from "../src/subject/content.ts";
import type { GitCandidateSubject, GitCleanObservationSubject } from "../src/subject/types.ts";
import {
	standaloneVerificationContractId,
	verifyCandidateBehavior,
	verifyObservedBehavior,
} from "../src/verification/behavior.ts";

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
	patchDigest: "4".repeat(64),
	changedPathsDigest: "5".repeat(64),
	approvedDesignId: "6".repeat(64),
	behaviorContractId: "7".repeat(64),
};
const artifact = { path: "receipts/value.json", digest: "8".repeat(64), bytes: 1, complete: true };

async function catalog() {
	return TrustedCommandCatalog.build(
		resolvePolicy(
			decodeMachinePolicy({
				schemaVersion: 2,
				models: {
					orchestrator: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
					reviewers: [{ provider: "test", id: "claude-opus-4-8", thinkingLevel: "max" }],
				},
				concurrency: 1,
				maxRepairRounds: 1,
				commandTimeoutMs: 10_000,
				minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
				minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
				observations: [
					{ id: "one", claimKeys: ["key.one"], argv: ["one"], timeoutMs: 1_000 },
					{ id: "two", claimKeys: ["key.two"], argv: ["two"], timeoutMs: 1_000 },
				],
				verificationContracts: [],
				selectors: [],
			}),
		),
		"/repo",
	);
}

function approved(requiredKeys = ["key.one", "key.two"]): ApprovedDesignRecord {
	const core = {
		schemaVersion: 1 as const,
		selectors: [
			{ selectorId: "selector.one", value: "one.rs", observationId: "one" },
			{ selectorId: "selector.two", value: "two.rs", observationId: "two" },
		],
		observationIds: ["one", "two"],
		claimKeys: requiredKeys,
	};
	const contract = decodeDesignData(BehaviorContractSchema, { ...core, id: canonicalDigest(core) });
	const reviewSubject = {
		schemaVersion: 1 as const,
		kind: "behavior-design" as const,
		observation: { ...observation, workingDigest: "0".repeat(64), changedPathsDigest: "0".repeat(64) },
		designDigest: "9".repeat(64),
		behaviorContractDigest: contract.id,
	};
	const subjectDigest = reviewSubjectDigest(reviewSubject);
	const panelDigest = "a".repeat(64);
	const approvedDesignId = approvedDesignIdFor({
		reviewSubjectDigest: subjectDigest,
		panelArtifactDigest: panelDigest,
		designDigest: reviewSubject.designDigest,
		behaviorDigest: contract.id,
	});
	candidate.approvedDesignId = approvedDesignId;
	candidate.behaviorContractId = contract.id;
	return decodeDesignData(ApprovedDesignRecordSchema, {
		schemaVersion: 1,
		approvedDesignId,
		caller: "build",
		reviewSubject,
		reviewSubjectDigest: subjectDigest,
		design: { artifactPath: "approved/design.json", artifactDigest: reviewSubject.designDigest },
		behavior: {
			kind: "contract",
			digest: contract.id,
			contract,
			artifactPath: "approved/behavior.json",
			artifactDigest: "b".repeat(64),
		},
		panel: {
			recordPath: "reviews/record.json",
			recordDigest: "c".repeat(64),
			artifactPath: "reviews/panel.json",
			artifactDigest: panelDigest,
		},
		approvedAt: "2026-08-25T00:00:00.000Z",
	});
}

function verificationContract(): VerificationContract {
	return {
		id: "standalone",
		claim: "the feature works",
		requiredClaimKeys: ["key.one", "key.two"],
		observationIds: ["one", "two"],
	};
}

function execution(
	command: TrustedCommand,
	outcome: "passed" | "failed" | "timed_out" | "cancelled" | "drifted",
): ObservationExecution {
	const before = observationSubjectDigest(observation);
	const after = outcome === "drifted" ? "f".repeat(64) : before;
	const record = decodeGateRecord({
		schemaVersion: 1,
		executionId: randomUUID(),
		source: command.source,
		category: "observation",
		commandId: command.id,
		argvDigest: command.argvDigest(),
		backend: "git",
		subject: candidate,
		subjectDigest: evidenceSubjectDigest(candidate),
		beforeObservationDigest: before,
		afterObservationDigest: after,
		startedAt: "2026-08-25T00:00:00.000Z",
		completedAt: "2026-08-25T00:00:01.000Z",
		durationMs: 1000,
		outcome,
		exitCode: outcome === "passed" ? 0 : outcome === "failed" || outcome === "drifted" ? 1 : null,
		terminationSignal: outcome === "timed_out" || outcome === "cancelled" ? "SIGTERM" : null,
		diagnostic: null,
		stdout: artifact,
		stderr: { ...artifact, path: "receipts/stderr" },
	});
	if (outcome !== "passed") return { command, record };
	const receipt = decodeObservationReceipt({
		schemaVersion: 1,
		receiptId: randomUUID(),
		executionId: record.executionId,
		source: command.source,
		category: "observation",
		commandId: command.id,
		argvDigest: command.argvDigest(),
		backend: "git",
		subject: candidate,
		subjectDigest: evidenceSubjectDigest(candidate),
		startedAt: record.startedAt,
		completedAt: record.completedAt,
		durationMs: record.durationMs,
		claimKeys: [...command.claimKeys],
		stdout: record.stdout,
		stderr: record.stderr,
		record: { ...artifact, path: "receipts/record" },
	});
	return { command, record, receipt, receiptArtifact: { ...artifact, path: `receipts/${receipt.receiptId}` } };
}

function observedExecution(
	command: TrustedCommand,
	outcome: "passed" | "failed" | "timed_out" | "cancelled" | "drifted",
): ObservationExecution {
	const value = execution(command, outcome);
	const subjectDigest = observationSubjectDigest(observation);
	const record = decodeGateRecord({ ...value.record, subject: observation, subjectDigest });
	if (!value.receipt) return { command, record };
	const receipt = decodeObservationReceipt({
		...value.receipt,
		subject: observation,
		subjectDigest,
		executionId: record.executionId,
	});
	return { command, record, receipt, receiptArtifact: value.receiptArtifact };
}

describe("deterministic behavior verdict", () => {
	it("applies drift, nonzero, incomplete, and coverage precedence", async () => {
		const commands = await catalog();
		const one = commands.observation("one");
		const two = commands.observation("two");
		const design = approved();
		const verified = verifyCandidateBehavior(candidate, design, [one, two], [
			execution(one, "passed"),
			execution(two, "passed"),
		]);
		expect(verified).toMatchObject({
			verdict: "Verified",
			record: {
				subjectDigest: evidenceSubjectDigest(candidate),
				contractId: design.behavior.kind === "contract" ? design.behavior.digest : "",
				coveredClaimKeys: ["key.one", "key.two"],
			},
		});
		if (verified.verdict !== "Verified") throw new Error("expected verified result");
		expect(verified.record.receiptRefs).toHaveLength(2);
		const failed = verifyCandidateBehavior(candidate, design, [one, two], [execution(one, "failed")]);
		expect(failed).toMatchObject({ verdict: "NotVerified", record: { coveredClaimKeys: [], receiptRefs: [] } });
		const timedOut = verifyCandidateBehavior(candidate, design, [one, two], [execution(one, "timed_out")]);
		expect(timedOut).toMatchObject({ verdict: "Inconclusive", record: { coveredClaimKeys: [], receiptRefs: [] } });
		expect(verifyCandidateBehavior(candidate, design, [one, two], [execution(one, "drifted")])).toEqual({ verdict: "Blocked", reason: "subject-drift" });
	});

	it("applies standalone drift, failure, and inconclusive precedence on observation subjects", async () => {
		const commands = await catalog();
		const one = commands.observation("one");
		const two = commands.observation("two");
		const contract = verificationContract();
		expect(
			verifyObservedBehavior(observation, contract, [one, two], [
				observedExecution(one, "passed"),
				observedExecution(two, "passed"),
			]),
		).toMatchObject({ verdict: "Verified", record: { contractId: standaloneVerificationContractId(contract) } });
		expect(
			verifyObservedBehavior(observation, contract, [one, two], [
				observedExecution(one, "failed"),
				observedExecution(two, "drifted"),
			]),
		).toEqual({ verdict: "Blocked", reason: "subject-drift" });
		expect(
			verifyObservedBehavior(observation, contract, [one, two], [
				observedExecution(one, "failed"),
				observedExecution(two, "timed_out"),
			]),
		).toMatchObject({ verdict: "NotVerified" });
		expect(
			verifyObservedBehavior(observation, contract, [one, two], [
				observedExecution(one, "timed_out"),
				observedExecution(two, "cancelled"),
			]),
		).toMatchObject({ verdict: "Inconclusive" });
	});

	it("keeps standalone and approved-candidate digest domains distinct", async () => {
		const contract = verificationContract();
		const design = approved();
		if (design.behavior.kind !== "contract") throw new Error("expected behavior contract");
		expect(standaloneVerificationContractId(contract)).not.toBe(design.behavior.digest);
		expect(observationSubjectDigest(observation)).not.toBe(evidenceSubjectDigest(candidate));
	});

	it("rejects foreign design binding and a passing receipt without its immutable artifact", async () => {
		const commands = await catalog();
		const one = commands.observation("one");
		const two = commands.observation("two");
		const design = approved();
		expect(() =>
			verifyCandidateBehavior(
				{ ...candidate, behaviorContractId: "f".repeat(64) },
				design,
				[one, two],
				[execution(one, "passed"), execution(two, "passed")],
			),
		).toThrow("not sealed");
		const passing = execution(one, "passed");
		delete passing.receiptArtifact;
		expect(() => verifyCandidateBehavior(candidate, design, [one, two], [passing, execution(two, "passed")])).toThrow(
			"lacks immutable artifact",
		);
	});

	it("returns Inconclusive when passing observations leave a required key uncovered", async () => {
		const commands = await catalog();
		const one = commands.observation("one");
		const two = commands.observation("two");
		const design = approved(["key.one", "key.two", "key.missing"]);
		expect(
			verifyCandidateBehavior(candidate, design, [one, two], [execution(one, "passed"), execution(two, "passed")]),
		).toMatchObject({ verdict: "Inconclusive" });
	});
});
