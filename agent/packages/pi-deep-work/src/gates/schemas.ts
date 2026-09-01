import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { evidenceBackend, evidenceSubjectDigest } from "../subject/content.ts";
import { EvidenceSubjectSchema } from "../subject/types.ts";
import { digestPatternSource, uuidPatternSource } from "../application/types.ts";

const digest = Type.String({ pattern: digestPatternSource });
const uuid = Type.String({ pattern: uuidPatternSource });
const nonEmpty = Type.String({ minLength: 1 });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const artifactPath = Type.Refine(Type.String({ minLength: 1, maxLength: 1024 }), (value) => {
	if (value.startsWith("/") || value.includes("\\") || /[\0\n\r]/.test(value)) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
});

export const CommandArtifactSchema = Type.Object(
	{
		path: artifactPath,
		digest,
		bytes: Type.Integer({ minimum: 0 }),
		complete: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const commandIdentity = {
	source: StringEnum(["machine", "project", "package"] as const),
	category: StringEnum(["quick", "full", "observation"] as const),
	commandId: nonEmpty,
	argvDigest: digest,
};

const GateRecordObject = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		executionId: uuid,
		...commandIdentity,
		backend: StringEnum(["git", "jj"] as const),
		subject: EvidenceSubjectSchema,
		subjectDigest: digest,
		beforeObservationDigest: digest,
		afterObservationDigest: Type.Union([digest, Type.Null()]),
		startedAt: timestamp,
		completedAt: timestamp,
		durationMs: Type.Integer({ minimum: 0 }),
		outcome: StringEnum([
			"passed",
			"failed",
			"drifted",
			"timed_out",
			"cancelled",
			"output_overflow",
			"incomplete",
		] as const),
		exitCode: Type.Union([Type.Integer(), Type.Null()]),
		terminationSignal: Type.Union([Type.String(), Type.Null()]),
		diagnostic: Type.Union([Type.String(), Type.Null()]),
		stdout: CommandArtifactSchema,
		stderr: CommandArtifactSchema,
	},
	{ additionalProperties: false },
);
export const GateRecordSchema = Type.Refine(GateRecordObject, (record) => {
	if (evidenceBackend(record.subject) !== record.backend) return false;
	if (record.outcome === "passed" && record.exitCode !== 0) return false;
	if (record.outcome === "failed" && (record.exitCode === null || record.exitCode === 0)) return false;
	if (record.outcome === "passed" && record.afterObservationDigest !== record.beforeObservationDigest) return false;
	if (
		record.outcome === "drifted" &&
		(record.afterObservationDigest === null || record.afterObservationDigest === record.beforeObservationDigest)
	) {
		return false;
	}
	if (record.outcome === "passed" && (!record.stdout.complete || !record.stderr.complete)) return false;
	return true;
});

const ObservationReceiptObject = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		receiptId: uuid,
		executionId: uuid,
		...commandIdentity,
		backend: StringEnum(["git", "jj"] as const),
		subject: EvidenceSubjectSchema,
		subjectDigest: digest,
		startedAt: timestamp,
		completedAt: timestamp,
		durationMs: Type.Integer({ minimum: 0 }),
		claimKeys: Type.Array(nonEmpty),
		stdout: CommandArtifactSchema,
		stderr: CommandArtifactSchema,
		record: CommandArtifactSchema,
	},
	{ additionalProperties: false },
);
export const ObservationReceiptSchema = Type.Refine(
	ObservationReceiptObject,
	(receipt) =>
		evidenceBackend(receipt.subject) === receipt.backend &&
		receipt.stdout.complete &&
		receipt.stderr.complete &&
		receipt.record.complete,
);

export type CommandArtifact = Static<typeof CommandArtifactSchema>;
export type GateRecord = Static<typeof GateRecordSchema>;
export type ObservationReceipt = Static<typeof ObservationReceiptSchema>;

export class GateDataDecodeError extends Error {
	constructor(readonly issues: string[]) {
		super(`Invalid gate data: ${issues.join("; ")}`);
		this.name = "GateDataDecodeError";
	}
}

function decode<T extends TSchema>(schema: T, value: unknown): Static<T> {
	if (!Check(schema, value)) {
		const issues = [...Errors(schema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path}: ${error.message}`;
		});
		throw new GateDataDecodeError(issues);
	}
	return value as Static<T>;
}

export function decodeGateRecord(value: unknown): GateRecord {
	const record = decode(GateRecordSchema, value);
	if (evidenceSubjectDigest(record.subject) !== record.subjectDigest) {
		throw new GateDataDecodeError(["/subjectDigest: does not match subject"]);
	}
	return record;
}

export function decodeObservationReceipt(value: unknown): ObservationReceipt {
	const receipt = decode(ObservationReceiptSchema, value);
	if (evidenceSubjectDigest(receipt.subject) !== receipt.subjectDigest) {
		throw new GateDataDecodeError(["/subjectDigest: does not match subject"]);
	}
	return receipt;
}
