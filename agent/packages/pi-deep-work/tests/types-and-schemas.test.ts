import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	attemptId,
	behaviorContractId,
	claimKey,
	designId,
	policyDigest,
	repositoryId,
	runId,
	subjectDigest,
} from "../src/application/types.ts";
import {
	CommitPreparedSchema,
	CommitRecordedSchema,
	CompletedRunSchema,
	ControlRecordSchema,
	GateRecordSchema,
	PhaseCheckpointSchema,
	RecoverableRunSchema,
	ReviewRecordSchema,
	RunProjectionSchema,
	TerminalRunSchema,
	DecodeError,
	VerificationRecordSchema,
	decode,
	decodeObservationSubject,
	decodeRunProjection,
} from "../src/store/schemas.ts";
import { CandidateSubjectSchema, RegressionSubjectSchema } from "../src/subject/types.ts";

const hex = (character: string): string => character.repeat(64);
const now = "2026-08-25T00:00:00.000Z";

const gitObservation = {
	schemaVersion: 1 as const,
	kind: "git" as const,
	repositoryId: hex("a"),
	root: "/repo",
	policyDigest: hex("b"),
	workingDigest: hex("c"),
	changedPathsDigest: hex("d"),
	headOid: "1".repeat(40),
	symbolicRef: "refs/heads/main",
	conflicted: false as const,
	indexTree: "2".repeat(40),
};

const jjObservation = {
	schemaVersion: 1 as const,
	kind: "jj" as const,
	repositoryId: hex("a"),
	root: "/repo",
	policyDigest: hex("b"),
	workingDigest: hex("c"),
	changedPathsDigest: hex("d"),
	operationId: "op",
	workspaceId: "default",
	changeId: "change",
	commitId: "commit",
	parentCommitIds: ["parent"],
	conflicted: false,
};

const gitCandidate = {
	schemaVersion: 1 as const,
	kind: "git" as const,
	observation: gitObservation,
	patchDigest: hex("e"),
	changedPathsDigest: hex("f"),
	approvedDesignId: hex("1"),
	behaviorContractId: hex("2"),
	treeOid: "3".repeat(40),
};

const jjCandidate = {
	schemaVersion: 1 as const,
	kind: "jj" as const,
	observation: jjObservation,
	patchDigest: hex("e"),
	changedPathsDigest: hex("f"),
	approvedDesignId: hex("1"),
	behaviorContractId: hex("2"),
	treeDigest: hex("3"),
	operationId: "op",
	changeId: "change",
	commitId: "commit",
	parentCommitIds: ["parent"],
};

const base = {
	schemaVersion: 1 as const,
	runId: randomUUID(),
	workflow: "build" as const,
	repositoryId: hex("a"),
	policyDigest: hex("b"),
	goal: "build ",
	createdAt: now,
	updatedAt: now,
	lastEventRevision: 0,
};

describe("branded identifiers", () => {
	it("accepts valid identities and rejects malformed values", () => {
		expect(runId(randomUUID())).toBeTruthy();
		expect(attemptId(randomUUID())).toBeTruthy();
		expect(repositoryId(hex("a"))).toHaveLength(64);
		expect(policyDigest(hex("b"))).toHaveLength(64);
		expect(subjectDigest(hex("c"))).toHaveLength(64);
		expect(designId(hex("d"))).toHaveLength(64);
		expect(behaviorContractId(hex("e"))).toHaveLength(64);
		expect(claimKey("cache.no-write-after-shutdown")).toBeTruthy();
		expect(() => runId("not-a-uuid")).toThrow("Invalid RunId");
		expect(() => subjectDigest("abc")).toThrow("Invalid SubjectDigest");
		expect(() => claimKey("contains spaces")).toThrow("Invalid ClaimKey");
	});
});

describe("observation subjects", () => {
	it("decodes backend-discriminated Git and Jujutsu subjects", () => {
		const common = {
			schemaVersion: 1,
			repositoryId: hex("a"),
			root: "/repo",
			policyDigest: hex("b"),
			workingDigest: hex("c"),
			changedPathsDigest: hex("d"),
		};
		expect(
			decodeObservationSubject({
				kind: "git",
				...common,
				headOid: "1".repeat(40),
				symbolicRef: "refs/heads/main",
				conflicted: false,
				indexTree: "2".repeat(40),
			}),
		).toMatchObject({ kind: "git" });
		expect(
			decodeObservationSubject({
				kind: "git",
				...common,
				headOid: "1".repeat(40),
				symbolicRef: "refs/heads/main",
				conflicted: true,
				indexEntriesDigest: hex("e"),
			}),
		).toMatchObject({ kind: "git", conflicted: true });
		expect(
			decodeObservationSubject({
				kind: "jj",
				...common,
				operationId: "op",
				workspaceId: "default",
				changeId: "change",
				commitId: "commit",
				parentCommitIds: ["parent"],
				conflicted: false,
			}),
		).toMatchObject({ kind: "jj" });
	});

	it("rejects unknown backend variants and extra keys", () => {
		expect(() => decodeObservationSubject({ kind: "svn" })).toThrow(DecodeError);
		expect(() =>
			decodeObservationSubject({
				kind: "git",
				repositoryId: hex("a"),
				root: "/repo",
				policyDigest: hex("b"),
				workingDigest: hex("c"),
				changedPathsDigest: hex("d"),
				headOid: "1".repeat(40),
				symbolicRef: "refs/heads/main",
				conflicted: false,
				indexTree: "2".repeat(40),
				extra: true,
			}),
		).toThrow(DecodeError);
	});
});

describe("persistent run schemas", () => {
	it("requires an explicit outcome only for Completed", () => {
		const completed = decodeRunProjection({
			...base,
			lifecycle: "Completed",
			lastAttemptId: randomUUID(),
			outcome: "LocalCommitCreated",
			summaryArtifact: "final.md",
		});
		expect(completed.lifecycle).toBe("Completed");
		for (const lifecycle of ["Active", "Pausing"] as const) {
			expect(
				decodeRunProjection({
					...base,
					lifecycle,
					attemptId: randomUUID(),
					phase: "implement",
				}),
			).toMatchObject({ lifecycle });
		}
		expect(() =>
			decode(RunProjectionSchema, {
				...base,
				lifecycle: "Completed",
				lastAttemptId: randomUUID(),
				summaryArtifact: "final.md",
			}),
		).toThrow(DecodeError);
		expect(() =>
			decode(RunProjectionSchema, {
				...base,
				lifecycle: "Active",
				attemptId: randomUUID(),
				phase: "implement",
				outcome: "Verified",
			}),
		).toThrow(DecodeError);
		expect(() =>
			decode(RunProjectionSchema, {
				...base,
				lifecycle: "Active",
				attemptId: randomUUID(),
				phase: "implement",
				observedControlRevision: 1,
			}),
		).toThrow(DecodeError);
	});

	it("requires policy and subject identity in every phase checkpoint", () => {
		expect(
			decode(PhaseCheckpointSchema, {
				schemaVersion: 1,
				runId: randomUUID(),
				attemptId: randomUUID(),
				sequence: 1,
				phase: "frame",
				policyDigest: hex("a"),
				subjectDigest: hex("b"),
				eventRevision: 1,
				controlRevision: 0,
				createdAt: now,
			}),
		).toMatchObject({ phase: "frame" });
		expect(() =>
			decode(PhaseCheckpointSchema, {
				schemaVersion: 1,
				runId: randomUUID(),
				attemptId: randomUUID(),
				sequence: 1,
				phase: "frame",
				eventRevision: 1,
				controlRevision: 0,
				createdAt: now,
			}),
		).toThrow(DecodeError);
	});

	it("rejects unknown fields, malformed UUIDs, and malformed timestamps", () => {
		expect(() =>
			decode(CompletedRunSchema, {
				...base,
				lifecycle: "Completed",
				lastAttemptId: randomUUID(),
				outcome: "Verified",
				summaryArtifact: "final.md",
				legacyStatus: "passed",
			}),
		).toThrow(DecodeError);
		expect(() => decodeRunProjection({ ...base, runId: "-".repeat(36), lifecycle: "Queued" })).toThrow(DecodeError);
		expect(() => decodeRunProjection({ ...base, createdAt: "not-a-date-but-long-enough", lifecycle: "Queued" })).toThrow(
			DecodeError,
		);
		expect(() => decodeRunProjection({ ...base, createdAt: "2026-13-45T99:99:99Z", lifecycle: "Queued" })).toThrow(
			DecodeError,
		);
		expect(() => decodeRunProjection({ ...base, schemaVersion: 2, lifecycle: "Queued" })).toThrow(DecodeError);
	});

	it("validates recoverable and terminal state requirements", () => {
		for (const lifecycle of ["Paused", "NeedsManualInspection", "Blocked"] as const) {
			expect(
				decode(RecoverableRunSchema, {
					...base,
					lifecycle,
					lastAttemptId: randomUUID(),
					observedControlRevision: 2,
					reason: "requires user action",
				}),
			).toMatchObject({ lifecycle });
		}
		expect(() =>
			decode(RecoverableRunSchema, {
				...base,
				lifecycle: "Paused",
				lastAttemptId: randomUUID(),
				observedControlRevision: 0,
			}),
		).toThrow(DecodeError);
		expect(() =>
			decode(RecoverableRunSchema, {
				...base,
				lifecycle: "Paused",
				lastAttemptId: randomUUID(),
				reason: "requires user action",
			}),
		).toThrow(DecodeError);
		for (const lifecycle of ["Cancelled", "Failed"] as const) {
			expect(
				decode(TerminalRunSchema, {
					...base,
					lifecycle,
					lastAttemptId: randomUUID(),
					reason: "terminal attempt",
				}),
			).toMatchObject({ lifecycle });
		}
		expect(() =>
			decode(TerminalRunSchema, {
				...base,
				lifecycle: "Failed",
				lastAttemptId: randomUUID(),
				reason: "failed",
				outcome: "Verified",
			}),
		).toThrow(DecodeError);
	});
});

describe("evidence and commit schemas", () => {
	it("rejects cross-backend candidates in prepared commits", () => {
		expect(
			decode(CommitPreparedSchema, {
				schemaVersion: 1,
				kind: "git",
				transactionId: randomUUID(),
				authorizationDigest: hex("9"),
				subject: gitCandidate,
				subjectDigest: hex("8"),
				root: "/repo",
				commonDir: "/repo/.git",
				expectedHead: "1".repeat(40),
				expectedRef: "refs/heads/main",
				expectedIndexTree: "2".repeat(40),
				treeOid: "3".repeat(40),
				candidatePaths: ["src/main.rs"],
				workingPaths: ["README.md", "src/main.rs"],
				workingDigest: hex("5"),
				otherRefsDigest: hex("6"),
				worktreesDigest: hex("7"),
				proposedCommitId: "4".repeat(40),
				messageDigest: hex("4"),
				authorName: "Deep Test",
				authorEmail: "deep@example.test",
				authorDate: now,
				committerName: "Deep Test",
				committerEmail: "deep@example.test",
				committerDate: now,
				preparedAt: now,
			}),
		).toMatchObject({ kind: "git" });
		expect(() =>
			decode(CommitPreparedSchema, {
				schemaVersion: 1,
				kind: "git",
				transactionId: randomUUID(),
				authorizationDigest: hex("9"),
				subject: jjCandidate,
				subjectDigest: hex("8"),
				root: "/repo",
				commonDir: "/repo/.git",
				expectedHead: "1".repeat(40),
				expectedRef: "refs/heads/main",
				expectedIndexTree: "2".repeat(40),
				treeOid: "3".repeat(40),
				candidatePaths: ["src/main.rs"],
				workingPaths: ["README.md", "src/main.rs"],
				workingDigest: hex("5"),
				otherRefsDigest: hex("6"),
				worktreesDigest: hex("7"),
				proposedCommitId: "4".repeat(40),
				messageDigest: hex("4"),
				authorName: "Deep Test",
				authorEmail: "deep@example.test",
				authorDate: now,
				committerName: "Deep Test",
				committerEmail: "deep@example.test",
				committerDate: now,
				preparedAt: now,
			}),
		).toThrow(DecodeError);
		expect(
			decode(CommitPreparedSchema, {
				schemaVersion: 1,
				kind: "jj",
				transactionId: randomUUID(),
				authorizationDigest: hex("9"),
				subject: jjCandidate,
				subjectDigest: hex("8"),
				root: "/repo",
				sharedRoot: "/repo/.jj/repo/store/git",
				expectedOperationId: "op",
				expectedWorkspaceId: "default",
				expectedChangeId: "change",
				expectedCommitId: "commit",
				expectedParentCommitIds: ["parent"],
				treeDigest: hex("3"),
				candidatePaths: ["src/main.rs"],
				workingPaths: ["README.md", "src/main.rs"],
				workingDigest: hex("5"),
				bookmarksDigest: hex("6"),
				workspacesDigest: hex("7"),
				messageDigest: hex("4"),
				userName: "Deep Test",
				userEmail: "deep@example.test",
				jjVersion: "jj 0.41.0",
				preparedAt: now,
			}),
		).toMatchObject({ kind: "jj" });
		expect(() =>
			decode(CommitPreparedSchema, {
				schemaVersion: 1,
				kind: "jj",
				subject: gitCandidate,
				expectedOperationId: "op",
				expectedChangeId: "change",
				expectedCommitId: "commit",
				messageDigest: hex("4"),
			}),
		).toThrow(DecodeError);
		expect(() =>
			decode(CommitPreparedSchema, {
				kind: "jj",
				subject: jjCandidate,
				expectedOperationId: "op",
				expectedChangeId: "change",
				expectedCommitId: "commit",
				messageDigest: hex("4"),
			}),
		).toThrow(DecodeError);
	});

	it("validates candidate OIDs and backend variants", () => {
		expect(decode(CandidateSubjectSchema, gitCandidate)).toMatchObject({ kind: "git" });
		expect(decode(CandidateSubjectSchema, jjCandidate)).toMatchObject({ kind: "jj" });
		expect(() => decode(CandidateSubjectSchema, { ...jjCandidate, operationId: "foreign-op" })).toThrow(DecodeError);
		expect(() => decode(CandidateSubjectSchema, { ...gitCandidate, treeOid: "123456" })).toThrow(DecodeError);
		expect(() => decode(CandidateSubjectSchema, { ...gitCandidate, treeOid: "3".repeat(64) })).toThrow(DecodeError);
		const { indexTree: _indexTree, ...gitObservationWithoutTree } = gitObservation;
		expect(() =>
			decode(CandidateSubjectSchema, {
				...gitCandidate,
				observation: {
					...gitObservationWithoutTree,
					conflicted: true,
					indexEntriesDigest: hex("e"),
				},
			}),
		).toThrow(DecodeError);
		expect(() => decodeObservationSubject({ ...gitObservation, headOid: "not-hex" })).toThrow(DecodeError);
		expect(() => decodeObservationSubject({ ...gitObservation, indexTree: "2".repeat(64) })).toThrow(DecodeError);
	});

	it("requires regression subjects to differ from their pristine baseline tree", () => {
		const regression = {
			schemaVersion: 1,
			kind: "git-regression",
			observation: gitObservation,
			patchDigest: hex("4"),
			changedPathsDigest: hex("5"),
			observationId: "red-test",
			argvDigest: hex("6"),
			treeOid: "7".repeat(40),
			baseline: {
				headOid: gitObservation.headOid,
				symbolicRef: gitObservation.symbolicRef,
				indexTree: gitObservation.indexTree,
				treeOid: gitObservation.indexTree,
			},
		};
		expect(decode(RegressionSubjectSchema, regression)).toMatchObject({ kind: "git-regression" });
		expect(() => decode(RegressionSubjectSchema, { ...regression, treeOid: regression.baseline.treeOid })).toThrow(
			DecodeError,
		);
	});

	it("decodes strict review, gate, verification, control, and commit records", () => {
		expect(
			decode(ReviewRecordSchema, {
				schemaVersion: 1,
				subjectDigest: hex("a"),
				reviewerIds: ["opus"],
				complete: true,
				completedReviewerIds: ["opus"],
				findingSeverities: [],
				approved: true,
				artifactPath: "reviews/subject/panel.json",
				artifactDigest: hex("b"),
			}),
		).toMatchObject({ approved: true });
		expect(
			decode(GateRecordSchema, {
				schemaVersion: 1,
				subjectDigest: hex("a"),
				observationId: "cargo-test",
				argvDigest: hex("b"),
				exitCode: 0,
				completed: true,
				stdoutArtifactDigest: hex("c"),
				stderrArtifactDigest: hex("d"),
			}),
		).toMatchObject({ completed: true });
		expect(
			decode(VerificationRecordSchema, {
				schemaVersion: 1,
				subjectDigest: hex("a"),
				contractId: hex("e"),
				coveredClaimKeys: ["cache.safe"],
				verdict: "Verified",
				receiptRefs: [{ receiptId: randomUUID(), artifactDigest: hex("b") }],
			}),
		).toMatchObject({ verdict: "Verified" });
		expect(() =>
			decode(VerificationRecordSchema, {
				schemaVersion: 1,
				subjectDigest: hex("a"),
				contractId: hex("e"),
				coveredClaimKeys: [],
				verdict: "Verified",
				receiptRefs: [],
			}),
		).toThrow(DecodeError);
		expect(
			decode(ControlRecordSchema, {
				schemaVersion: 1,
				runId: randomUUID(),
				revision: 1,
				kind: "Cancel",
				requestedAt: now,
			}),
		).toMatchObject({ kind: "Cancel" });
		expect(
			decode(CommitRecordedSchema, {
				schemaVersion: 1,
				backend: "jj",
				transactionId: randomUUID(),
				authorizationDigest: hex("b"),
				subjectDigest: hex("a"),
				commitId: "commit",
				operationId: "operation",
				finalizedChangeId: "change",
				childCommitId: "child-commit",
				childChangeId: "child-change",
				treeDigest: hex("c"),
				messageDigest: hex("d"),
				recordedAt: now,
			}),
		).toMatchObject({ backend: "jj" });
		expect(
			decode(CommitRecordedSchema, {
				schemaVersion: 1,
				backend: "git",
				transactionId: randomUUID(),
				authorizationDigest: hex("b"),
				subjectDigest: hex("a"),
				commitId: "commit",
				ref: "refs/heads/main",
				treeOid: "1".repeat(40),
				messageDigest: hex("c"),
				recordedAt: now,
			}),
		).toMatchObject({ backend: "git" });
		expect(() =>
			decode(CommitRecordedSchema, {
				schemaVersion: 1,
				backend: "git",
				transactionId: randomUUID(),
				authorizationDigest: hex("b"),
				subjectDigest: hex("a"),
				commitId: "commit",
				ref: "refs/heads/main",
				treeOid: "1".repeat(40),
				messageDigest: hex("c"),
				operationId: "not-allowed",
				recordedAt: now,
			}),
		).toThrow(DecodeError);
		expect(() =>
			decode(CommitRecordedSchema, {
				schemaVersion: 1,
				backend: "jj",
				subjectDigest: hex("a"),
				commitId: "commit",
				recordedAt: now,
			}),
		).toThrow(DecodeError);
		expect(() =>
			decode(ReviewRecordSchema, {
				schemaVersion: 1,
				subjectDigest: hex("a"),
				reviewerIds: ["opus"],
				complete: false,
				completedReviewerIds: [],
				findingSeverities: [],
				approved: false,
				artifactPath: "reviews/subject/panel.json",
				artifactDigest: hex("b"),
			}),
		).toThrow(DecodeError);
	});
});
