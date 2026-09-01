import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import {
	GitCandidateSubjectSchema,
	JjCandidateSubjectSchema,
	ObservationSubjectSchema,
} from "../subject/types.ts";
import {
	digestPatternSource,
	gitOidPatternSource,
	uuidPatternSource,
	workflowKinds,
	workflowOutcomes,
} from "../application/types.ts";

const uuid = Type.String({ pattern: uuidPatternSource });
const digest = Type.String({ pattern: digestPatternSource });
const oid = Type.String({ pattern: gitOidPatternSource });
const timestampText = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
});
const timestamp = Type.Refine(timestampText, (value) => {
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) return false;
	const canonical = new Date(milliseconds).toISOString();
	return value === canonical || (canonical.endsWith(".000Z") && value === canonical.replace(".000Z", "Z"));
});
const nonEmpty = Type.String({ minLength: 1 });
const phaseName = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$" });
const artifactPath = Type.Refine(Type.String({ minLength: 1, maxLength: 1024 }), (value) => {
	if (value.startsWith("/") || value.includes("\\") || /[\0\n\r]/.test(value)) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
});
const repositoryPath = Type.Refine(Type.String({ minLength: 1, maxLength: 1024 }), (value) => {
	// Delegated workspace paths reject backslash and dot segments on both supported platforms.
	if (value.startsWith("/") || value.includes("\\") || /[\0\n\r]/.test(value)) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
});
const workflow = StringEnum(workflowKinds);
const nonTerminalLifecycle = StringEnum(["Active", "Pausing"] as const);
const recoverableLifecycle = StringEnum(["Paused", "NeedsManualInspection", "Blocked"] as const);
const terminalLifecycle = StringEnum(["Cancelled", "Failed"] as const);
const outcome = StringEnum(workflowOutcomes);

const runBase = {
	schemaVersion: Type.Literal(1),
	runId: uuid,
	workflow,
	repositoryId: digest,
	policyDigest: digest,
	goal: nonEmpty,
	createdAt: timestamp,
	updatedAt: timestamp,
	lastEventRevision: Type.Integer({ minimum: 0 }),
};

export const QueuedRunSchema = Type.Object(
	{
		...runBase,
		lifecycle: Type.Literal("Queued"),
	},
	{ additionalProperties: false },
);

// Active projections intentionally omit observedControlRevision; only recoverable settlement persists the durable watermark.
export const ActiveRunSchema = Type.Object(
	{
		...runBase,
		lifecycle: nonTerminalLifecycle,
		attemptId: uuid,
		phase: phaseName,
	},
	{ additionalProperties: false },
);

export const RecoverableRunSchema = Type.Object(
	{
		...runBase,
		lifecycle: recoverableLifecycle,
		lastAttemptId: uuid,
		observedControlRevision: Type.Integer({ minimum: 0 }),
		reason: nonEmpty,
	},
	{ additionalProperties: false },
);

export const TerminalRunSchema = Type.Object(
	{
		...runBase,
		lifecycle: terminalLifecycle,
		lastAttemptId: uuid,
		reason: nonEmpty,
	},
	{ additionalProperties: false },
);

export const CompletedRunSchema = Type.Object(
	{
		...runBase,
		lifecycle: Type.Literal("Completed"),
		lastAttemptId: uuid,
		outcome,
		summaryArtifact: nonEmpty,
	},
	{ additionalProperties: false },
);

export const RunProjectionSchema = Type.Union([
	QueuedRunSchema,
	ActiveRunSchema,
	RecoverableRunSchema,
	TerminalRunSchema,
	CompletedRunSchema,
]);
export type QueuedRun = Static<typeof QueuedRunSchema>;
export type ActiveRun = Static<typeof ActiveRunSchema>;
export type RecoverableRun = Static<typeof RecoverableRunSchema>;
export type TerminalRun = Static<typeof TerminalRunSchema>;
export type CompletedRun = Static<typeof CompletedRunSchema>;
export type RunProjection = Static<typeof RunProjectionSchema>;

const phaseCheckpointCommon = {
	schemaVersion: Type.Literal(1),
	runId: uuid,
	attemptId: uuid,
	sequence: Type.Integer({ minimum: 1 }),
	phase: phaseName,
	policyDigest: digest,
	subjectDigest: digest,
	eventRevision: Type.Integer({ minimum: 1 }),
	controlRevision: Type.Integer({ minimum: 0 }),
	createdAt: timestamp,
};

export const MutationArtifactSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		phase: phaseName,
		mutations: Type.Array(
			Type.Object(
				{
					path: artifactPath,
					preimageDigest: Type.Union([digest, Type.Null()]),
					resultDigest: digest,
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		mutationDigest: digest,
	},
	{ additionalProperties: false },
);
export type MutationArtifact = Static<typeof MutationArtifactSchema>;

export const ReadOnlyPhaseCheckpointSchema = Type.Object(phaseCheckpointCommon, { additionalProperties: false });
export const MutationPhaseCheckpointSchema = Type.Object(
	{
		...phaseCheckpointCommon,
		mutation: Type.Object(
			{
				artifact: artifactPath,
				artifactDigest: digest,
				mutationDigest: digest,
				fileCount: Type.Integer({ minimum: 1 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export const PhaseCheckpointSchema = Type.Union([ReadOnlyPhaseCheckpointSchema, MutationPhaseCheckpointSchema]);
export type ReadOnlyPhaseCheckpoint = Static<typeof ReadOnlyPhaseCheckpointSchema>;
export type MutationPhaseCheckpoint = Static<typeof MutationPhaseCheckpointSchema>;
export type PhaseCheckpoint = Static<typeof PhaseCheckpointSchema>;

export const ReviewRecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		subjectDigest: digest,
		reviewerIds: Type.Array(nonEmpty, { minItems: 1 }),
		complete: Type.Literal(true),
		completedReviewerIds: Type.Array(nonEmpty, { minItems: 1 }),
		findingSeverities: Type.Array(StringEnum(["blocker", "important", "suggestion"] as const)),
		approved: Type.Boolean(),
		artifactPath,
		artifactDigest: digest,
	},
	{ additionalProperties: false },
);

export type ReviewRecord = Static<typeof ReviewRecordSchema>;

export const GateRecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		subjectDigest: digest,
		observationId: nonEmpty,
		argvDigest: digest,
		exitCode: Type.Integer(),
		completed: Type.Boolean(),
		stdoutArtifactDigest: digest,
		stderrArtifactDigest: digest,
	},
	{ additionalProperties: false },
);

const VerificationRecordObject = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		subjectDigest: digest,
		contractId: digest,
		coveredClaimKeys: Type.Array(nonEmpty),
		verdict: StringEnum(["Verified", "NotVerified", "Inconclusive"] as const),
		receiptRefs: Type.Array(
			Type.Object(
				{ receiptId: uuid, artifactDigest: digest },
				{ additionalProperties: false },
			),
			{ minItems: 0 },
		),
	},
	{ additionalProperties: false },
);
export const VerificationRecordSchema = Type.Refine(
	VerificationRecordObject,
	(value) => value.verdict !== "Verified" || value.receiptRefs.length > 0,
);

export type VerificationRecord = Static<typeof VerificationRecordSchema>;

export const ControlRecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		runId: uuid,
		revision: Type.Integer({ minimum: 1 }),
		kind: StringEnum(["Pause", "Cancel"] as const),
		requestedAt: timestamp,
	},
	{ additionalProperties: false },
);
export type ControlRecord = Static<typeof ControlRecordSchema>;

export const ControlsFileSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		runId: uuid,
		revision: Type.Integer({ minimum: 0 }),
		requests: Type.Array(ControlRecordSchema),
	},
	{ additionalProperties: false },
);
export type ControlsFile = Static<typeof ControlsFileSchema>;

export const GitCommitPreparedSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: Type.Literal("git"),
		transactionId: uuid,
		authorizationDigest: digest,
		subject: GitCandidateSubjectSchema,
		subjectDigest: digest,
		root: nonEmpty,
		commonDir: nonEmpty,
		expectedHead: oid,
		expectedRef: nonEmpty,
		expectedIndexTree: oid,
		treeOid: oid,
		candidatePaths: Type.Array(repositoryPath, { minItems: 1 }),
		workingPaths: Type.Array(repositoryPath, { minItems: 1 }),
		workingDigest: digest,
		otherRefsDigest: digest,
		worktreesDigest: digest,
		proposedCommitId: oid,
		messageDigest: digest,
		authorName: nonEmpty,
		authorEmail: nonEmpty,
		authorDate: timestamp,
		committerName: nonEmpty,
		committerEmail: nonEmpty,
		committerDate: timestamp,
		preparedAt: timestamp,
	},
	{ additionalProperties: false },
);

export const JjCommitPreparedSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: Type.Literal("jj"),
		transactionId: uuid,
		authorizationDigest: digest,
		subject: JjCandidateSubjectSchema,
		subjectDigest: digest,
		root: nonEmpty,
		sharedRoot: nonEmpty,
		expectedOperationId: nonEmpty,
		expectedWorkspaceId: nonEmpty,
		expectedChangeId: nonEmpty,
		expectedCommitId: nonEmpty,
		expectedParentCommitIds: Type.Array(nonEmpty, { minItems: 1 }),
		treeDigest: digest,
		candidatePaths: Type.Array(repositoryPath, { minItems: 1 }),
		workingPaths: Type.Array(repositoryPath, { minItems: 1 }),
		workingDigest: digest,
		bookmarksDigest: digest,
		workspacesDigest: digest,
		messageDigest: digest,
		userName: nonEmpty,
		userEmail: nonEmpty,
		jjVersion: nonEmpty,
		preparedAt: timestamp,
	},
	{ additionalProperties: false },
);

export const CommitPreparedSchema = Type.Union([GitCommitPreparedSchema, JjCommitPreparedSchema]);
export type CommitPrepared = Static<typeof CommitPreparedSchema>;

const commitRecordedCommon = {
	schemaVersion: Type.Literal(1),
	subjectDigest: digest,
	commitId: nonEmpty,
	recordedAt: timestamp,
};

export const GitCommitRecordedSchema = Type.Object(
	{
		...commitRecordedCommon,
		backend: Type.Literal("git"),
		transactionId: uuid,
		authorizationDigest: digest,
		ref: nonEmpty,
		treeOid: oid,
		messageDigest: digest,
	},
	{ additionalProperties: false },
);

export const JjCommitRecordedSchema = Type.Object(
	{
		...commitRecordedCommon,
		backend: Type.Literal("jj"),
		transactionId: uuid,
		authorizationDigest: digest,
		operationId: nonEmpty,
		finalizedChangeId: nonEmpty,
		childCommitId: nonEmpty,
		childChangeId: nonEmpty,
		treeDigest: digest,
		messageDigest: digest,
	},
	{ additionalProperties: false },
);

export const CommitRecordedSchema = Type.Union([GitCommitRecordedSchema, JjCommitRecordedSchema]);
export type CommitRecorded = Static<typeof CommitRecordedSchema>;

export const TransitionEventSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		runId: uuid,
		revision: Type.Integer({ minimum: 1 }),
		previousRevision: Type.Integer({ minimum: 0 }),
		kind: StringEnum([
			"RunCreated",
			"RunFailed",
			"AttemptStarted",
			"PhaseCompleted",
			"ControlObserved",
			"OutcomeRecorded",
			"AttemptStopped",
		] as const),
		at: timestamp,
		projection: RunProjectionSchema,
	},
	{ additionalProperties: false },
);
export type TransitionEvent = Static<typeof TransitionEventSchema>;

export class DecodeError extends Error {
	constructor(readonly issues: string[]) {
		super(`Invalid data: ${issues.join("; ")}`);
		this.name = "DecodeError";
	}
}

export function decode<TSchemaDef extends TSchema>(schema: TSchemaDef, value: unknown): Static<TSchemaDef> {
	if (!Check(schema, value)) {
		const issues = [...Errors(schema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path}: ${error.message}`;
		});
		throw new DecodeError(issues);
	}
	return value as Static<TSchemaDef>;
}

export function decodeRunProjection(value: unknown): RunProjection {
	return decode(RunProjectionSchema, value);
}

export function decodeObservationSubject(value: unknown): Static<typeof ObservationSubjectSchema> {
	return decode(ObservationSubjectSchema, value);
}
