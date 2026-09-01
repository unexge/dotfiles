import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { GateRecordSchema } from "../gates/schemas.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import { ApprovedDesignRecordSchema } from "../review/design.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { MutationPhaseCheckpointSchema } from "../store/schemas.ts";
import { RegressionSubjectSchema } from "../subject/types.ts";

const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
const uuid = Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" });
const nonEmpty = Type.String({ minLength: 1 });
const selector = Type.Object({ selectorId: nonEmpty, value: nonEmpty }, { additionalProperties: false });

// investigation and selectorProposals are non-authoritative replay inputs but still gate consistency; durable evidence and fresh approval grant authority.
const SerializedRedEvidenceSchema = Type.Object(
	{
		regressionSubject: RegressionSubjectSchema,
		regressionSubjectDigest: digest,
		regressionChangedPaths: Type.Array(nonEmpty, { minItems: 1 }),
		mutationCheckpointDigest: digest,
		observationId: nonEmpty,
		argvDigest: digest,
		claimKeys: Type.Array(nonEmpty, { minItems: 1 }),
		failingRecord: GateRecordSchema,
	},
	{ additionalProperties: false },
);

export const BuildWriteContextSchema = Type.Union([
	Type.Object(
		{
			schemaVersion: Type.Literal(1),
			workflow: Type.Literal("build"),
			stage: Type.Literal("approved"),
			attemptId: uuid,
			approvedDesign: ApprovedDesignRecordSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			schemaVersion: Type.Literal(1),
			workflow: Type.Literal("build"),
			stage: Type.Literal("implemented"),
			attemptId: uuid,
			approvedDesign: ApprovedDesignRecordSchema,
			implementationCheckpoint: MutationPhaseCheckpointSchema,
		},
		{ additionalProperties: false },
	),
]);

export const FixWriteContextSchema = Type.Union([
	Type.Object(
		{
			schemaVersion: Type.Literal(1),
			workflow: Type.Literal("fix"),
			stage: Type.Literal("red"),
			attemptId: uuid,
			investigation: Type.Unknown(),
			selectorProposals: Type.Array(selector, { minItems: 1 }),
			redEvidence: SerializedRedEvidenceSchema,
			regressionCheckpoint: MutationPhaseCheckpointSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			schemaVersion: Type.Literal(1),
			workflow: Type.Literal("fix"),
			stage: Type.Literal("approved"),
			attemptId: uuid,
			investigation: Type.Unknown(),
			selectorProposals: Type.Array(selector, { minItems: 1 }),
			redEvidence: SerializedRedEvidenceSchema,
			regressionCheckpoint: MutationPhaseCheckpointSchema,
			approvedDesign: ApprovedDesignRecordSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			schemaVersion: Type.Literal(1),
			workflow: Type.Literal("fix"),
			stage: Type.Literal("implemented"),
			attemptId: uuid,
			investigation: Type.Unknown(),
			selectorProposals: Type.Array(selector, { minItems: 1 }),
			redEvidence: SerializedRedEvidenceSchema,
			regressionCheckpoint: MutationPhaseCheckpointSchema,
			approvedDesign: ApprovedDesignRecordSchema,
			implementationCheckpoint: MutationPhaseCheckpointSchema,
		},
		{ additionalProperties: false },
	),
]);

export type BuildWriteContext = Static<typeof BuildWriteContextSchema>;
export type FixWriteContext = Static<typeof FixWriteContextSchema>;

export async function writeBuildContext(store: RunStore, ref: RunRef, value: BuildWriteContext): Promise<void> {
	decode(BuildWriteContextSchema, value);
	await store.writeArtifact(ref, "workflow/build-context.json", Buffer.from(canonicalJson(value)));
}

export async function writeFixContext(store: RunStore, ref: RunRef, value: FixWriteContext): Promise<void> {
	decode(FixWriteContextSchema, value);
	await store.writeArtifact(ref, "workflow/fix-context.json", Buffer.from(canonicalJson(value)));
}

export async function readBuildContext(store: RunStore, ref: RunRef): Promise<BuildWriteContext | undefined> {
	return readOptional(store, ref, "workflow/build-context.json", BuildWriteContextSchema);
}

export async function readFixContext(store: RunStore, ref: RunRef): Promise<FixWriteContext | undefined> {
	return readOptional(store, ref, "workflow/fix-context.json", FixWriteContextSchema);
}

async function readOptional<T extends TSchema>(
	store: RunStore,
	ref: RunRef,
	path: string,
	schema: T,
): Promise<Static<T> | undefined> {
	const value = await store.readOptionalArtifact(ref, path);
	return value ? decode(schema, JSON.parse(value.toString("utf8"))) : undefined;
}

function decode<T extends TSchema>(schema: T, value: unknown): Static<T> {
	if (!Check(schema, value)) {
		const issues = [...Errors(schema, value)].map((error) => `${"path" in error ? error.path : "/"}: ${error.message}`);
		throw new Error(`Invalid write context: ${issues.join("; ")}`);
	}
	return value as Static<T>;
}
