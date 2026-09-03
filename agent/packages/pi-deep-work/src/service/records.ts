import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import type { RunRef, RunStore } from "../store/run-store.ts";

const nonEmpty = Type.String({ minLength: 1 });
const uuid = Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" });
const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const RequestRecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		workflow: Type.Union([
			Type.Literal("how"),
			Type.Literal("design"),
			Type.Literal("review"),
			Type.Literal("fix"),
			Type.Literal("build"),
			Type.Literal("verify"),
			Type.Literal("unslop"),
		]),
		goal: nonEmpty,
		base: Type.Optional(nonEmpty),
		sourceDesignRunId: Type.Optional(uuid),
		designFeedback: Type.Optional(nonEmpty),
		unslopSource: Type.Optional(
			Type.Union([
				Type.Object({ kind: Type.Literal("text"), text: nonEmpty }, { additionalProperties: false }),
				Type.Object({ kind: Type.Literal("diff"), base: Type.Optional(nonEmpty) }, { additionalProperties: false }),
			]),
		),
	},
	{ additionalProperties: false },
);

const RepositoryBase = {
	schemaVersion: Type.Literal(1),
	root: nonEmpty,
	sharedRoot: nonEmpty,
	repositoryId: digest,
};

export const RepositoryRecordSchema = Type.Union([
	Type.Object({ ...RepositoryBase, kind: Type.Literal("git"), commonDir: nonEmpty }, { additionalProperties: false }),
	Type.Object(
		{
			...RepositoryBase,
			kind: Type.Literal("jj"),
			gitStore: nonEmpty,
			workspaceId: nonEmpty,
		},
		{ additionalProperties: false },
	),
]);

export type RequestRecord = Static<typeof RequestRecordSchema>;
export type RepositoryRecord = Static<typeof RepositoryRecordSchema>;

export async function loadRunRecords(
	store: RunStore,
	ref: RunRef,
): Promise<{ request: RequestRecord; repository: RepositoryRecord }> {
	return {
		request: decodeRecord(RequestRecordSchema, JSON.parse((await store.readArtifact(ref, "run/request.json")).toString("utf8"))),
		repository: decodeRecord(
			RepositoryRecordSchema,
			JSON.parse((await store.readArtifact(ref, "run/repository.json")).toString("utf8")),
		),
	};
}

function decodeRecord<TSchemaDef extends TSchema>(schema: TSchemaDef, value: unknown): Static<TSchemaDef> {
	if (!Check(schema, value)) {
		const issues = [...Errors(schema, value)].map((error) => `${"path" in error ? error.path : "/"}: ${error.message}`);
		throw new Error(`Invalid run metadata: ${issues.join("; ")}`);
	}
	return value as Static<TSchemaDef>;
}
