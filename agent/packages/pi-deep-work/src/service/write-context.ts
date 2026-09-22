import { createHash } from "node:crypto";
import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { mintRedRegressionEvidence } from "../authorization/red-regression.ts";
import type { TrustedCommandCatalog } from "../gates/catalog.ts";
import { restoreSealedRegression } from "../gates/tree-backend.ts";
import { GateRecordSchema } from "../gates/schemas.ts";
import { canonicalDigest, canonicalJson } from "../policy/canonical-json.ts";
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

export function restoreRedContextEvidence(context: FixWriteContext, catalog: TrustedCommandCatalog) {
	const subject = restoreSealedRegression(context.redEvidence.regressionSubject, context.regressionCheckpoint);
	const evidence = mintRedRegressionEvidence({
		regressionSubject: subject,
		regressionChangedPaths: context.redEvidence.regressionChangedPaths,
		checkpoint: context.regressionCheckpoint,
		command: catalog.observation(context.redEvidence.observationId),
		failingExecution: { record: context.redEvidence.failingRecord },
	});
	if (
		evidence.regressionSubjectDigest !== context.redEvidence.regressionSubjectDigest ||
		evidence.mutationCheckpointDigest !== context.redEvidence.mutationCheckpointDigest ||
		evidence.argvDigest !== context.redEvidence.argvDigest ||
		evidence.claimKeys.join("\0") !== context.redEvidence.claimKeys.join("\0") ||
		evidence.regressionChangedPaths.join("\0") !== context.redEvidence.regressionChangedPaths.join("\0")
	) {
		throw new Error("Re-minted red evidence contradicts durable fix context");
	}
	return evidence;
}

export async function assertRedContextArtifacts(
	store: RunStore,
	ref: RunRef,
	context: FixWriteContext,
): Promise<void> {
	const record = await store.readArtifact(
		ref,
		`commands/${context.redEvidence.failingRecord.executionId}/record.json`,
	);
	if (record.toString("utf8") !== canonicalJson(context.redEvidence.failingRecord)) {
		throw new Error("Fix context failing record contradicts immutable command record");
	}
	const mutation = await store.readArtifact(ref, context.regressionCheckpoint.mutation.artifact);
	if (createHash("sha256").update(mutation).digest("hex") !== context.regressionCheckpoint.mutation.artifactDigest) {
		throw new Error("Fix context regression mutation artifact digest mismatch");
	}
	const value = JSON.parse(mutation.toString("utf8")) as {
		schemaVersion?: unknown;
		phase?: unknown;
		mutations?: Array<{ path?: unknown; preimageDigest?: unknown; resultDigest?: unknown }>;
		mutationDigest?: unknown;
	};
	if (
		value.schemaVersion !== 1 ||
		value.phase !== "regression" ||
		!Array.isArray(value.mutations) ||
		value.mutations.some(
			(entry) =>
				typeof entry.path !== "string" ||
				(entry.preimageDigest !== null && typeof entry.preimageDigest !== "string") ||
				typeof entry.resultDigest !== "string",
		) ||
		typeof value.mutationDigest !== "string" ||
		value.mutationDigest !== context.regressionCheckpoint.mutation.mutationDigest ||
		canonicalDigest(value.mutations) !== value.mutationDigest
	) {
		throw new Error("Fix context regression mutation artifact is malformed or contradictory");
	}
	const paths = value.mutations.map((entry) => entry.path as string).sort();
	const expected = [...context.redEvidence.regressionChangedPaths].sort();
	if (paths.join("\0") !== expected.join("\0")) {
		throw new Error("Fix context regression paths contradict immutable mutation artifact");
	}
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
