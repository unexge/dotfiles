import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { digestPatternSource, gitOidPatternSource } from "../application/types.ts";

const digest = Type.String({ pattern: digestPatternSource });
const oid = Type.String({ pattern: gitOidPatternSource });
const nonEmpty = Type.String({ minLength: 1 });

const commonObservation = {
	repositoryId: digest,
	root: nonEmpty,
	policyDigest: digest,
	workingDigest: digest,
	changedPathsDigest: digest,
};

const gitObservationCommon = {
	schemaVersion: Type.Literal(1),
	kind: StringEnum(["git"] as const),
	...commonObservation,
	headOid: oid,
	symbolicRef: nonEmpty,
};

const GitCleanObservationObject = Type.Object(
	{
		...gitObservationCommon,
		conflicted: Type.Literal(false),
		indexTree: oid,
	},
	{ additionalProperties: false },
);
export const GitCleanObservationSubjectSchema = Type.Refine(
	GitCleanObservationObject,
	(value) => value.headOid.length === value.indexTree.length,
);

export const GitConflictedObservationSubjectSchema = Type.Object(
	{
		...gitObservationCommon,
		conflicted: Type.Literal(true),
		indexEntriesDigest: digest,
	},
	{ additionalProperties: false },
);

export const GitObservationSubjectSchema = Type.Union([
	GitCleanObservationSubjectSchema,
	GitConflictedObservationSubjectSchema,
]);

export const JjObservationSubjectSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: StringEnum(["jj"] as const),
		...commonObservation,
		operationId: nonEmpty,
		workspaceId: nonEmpty,
		changeId: nonEmpty,
		commitId: nonEmpty,
		parentCommitIds: Type.Array(nonEmpty, { minItems: 1 }),
		conflicted: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const ObservationSubjectSchema = Type.Union([GitObservationSubjectSchema, JjObservationSubjectSchema]);
export type ObservationSubject = Static<typeof ObservationSubjectSchema>;
export type GitObservationSubject = Static<typeof GitObservationSubjectSchema>;
export type GitCleanObservationSubject = Static<typeof GitCleanObservationSubjectSchema>;
export type GitConflictedObservationSubject = Static<typeof GitConflictedObservationSubjectSchema>;
export type JjObservationSubject = Static<typeof JjObservationSubjectSchema>;

const candidateCommon = {
	patchDigest: digest,
	changedPathsDigest: digest,
	approvedDesignId: digest,
	behaviorContractId: digest,
};

const GitCandidateSubjectObject = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: StringEnum(["git"] as const),
		observation: GitCleanObservationSubjectSchema,
		...candidateCommon,
		treeOid: oid,
	},
	{ additionalProperties: false },
);
export const GitCandidateSubjectSchema = Type.Refine(
	GitCandidateSubjectObject,
	(value) => value.treeOid.length === value.observation.headOid.length,
);

const JjCandidateSubjectObject = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: StringEnum(["jj"] as const),
		observation: JjObservationSubjectSchema,
		...candidateCommon,
		treeDigest: digest,
		operationId: nonEmpty,
		changeId: nonEmpty,
		commitId: nonEmpty,
		parentCommitIds: Type.Array(nonEmpty, { minItems: 1 }),
	},
	{ additionalProperties: false },
);
export const JjCandidateSubjectSchema = Type.Refine(
	JjCandidateSubjectObject,
	(value) =>
		value.operationId === value.observation.operationId &&
		value.changeId === value.observation.changeId &&
		value.commitId === value.observation.commitId &&
		value.parentCommitIds.length === value.observation.parentCommitIds.length &&
		value.parentCommitIds.every((parent, index) => parent === value.observation.parentCommitIds[index]),
);

export const CandidateSubjectSchema = Type.Union([GitCandidateSubjectSchema, JjCandidateSubjectSchema]);
export type CandidateSubject = Static<typeof CandidateSubjectSchema>;
export type GitCandidateSubject = Static<typeof GitCandidateSubjectSchema>;
export type JjCandidateSubject = Static<typeof JjCandidateSubjectSchema>;

const regressionCommon = {
	patchDigest: digest,
	changedPathsDigest: digest,
	observationId: nonEmpty,
	argvDigest: digest,
};

const GitRegressionSubjectObject = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: Type.Literal("git-regression"),
		observation: GitCleanObservationSubjectSchema,
		...regressionCommon,
		treeOid: oid,
		baseline: Type.Object(
			{
				headOid: oid,
				symbolicRef: nonEmpty,
				indexTree: oid,
				treeOid: oid,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export const GitRegressionSubjectSchema = Type.Refine(
	GitRegressionSubjectObject,
	(value) =>
		value.baseline.headOid === value.observation.headOid &&
		value.baseline.symbolicRef === value.observation.symbolicRef &&
		value.baseline.indexTree === value.observation.indexTree &&
		value.baseline.treeOid !== value.treeOid,
);

const JjRegressionSubjectObject = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: Type.Literal("jj-regression"),
		observation: JjObservationSubjectSchema,
		...regressionCommon,
		treeDigest: digest,
		baseline: Type.Object(
			{
				workspaceId: nonEmpty,
				changeId: nonEmpty,
				parentCommitIds: Type.Array(nonEmpty, { minItems: 1 }),
				commitId: nonEmpty,
				treeDigest: digest,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export const JjRegressionSubjectSchema = Type.Refine(
	JjRegressionSubjectObject,
	(value) =>
		value.baseline.workspaceId === value.observation.workspaceId &&
		value.baseline.changeId === value.observation.changeId &&
		value.baseline.parentCommitIds.length === value.observation.parentCommitIds.length &&
		value.baseline.parentCommitIds.every((parent, index) => parent === value.observation.parentCommitIds[index]) &&
		value.baseline.commitId !== value.observation.commitId &&
		value.baseline.treeDigest !== value.treeDigest,
);

export const RegressionSubjectSchema = Type.Union([GitRegressionSubjectSchema, JjRegressionSubjectSchema]);
export const EvidenceSubjectSchema = Type.Union([ObservationSubjectSchema, CandidateSubjectSchema, RegressionSubjectSchema]);
export type RegressionSubject = Static<typeof RegressionSubjectSchema>;
export type GitRegressionSubject = Static<typeof GitRegressionSubjectSchema>;
export type JjRegressionSubject = Static<typeof JjRegressionSubjectSchema>;
export type EvidenceSubject = Static<typeof EvidenceSubjectSchema>;
