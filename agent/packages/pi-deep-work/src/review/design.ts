import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { digestPatternSource, uuidPatternSource } from "../application/types.ts";
import { canonicalDigest } from "../policy/canonical-json.ts";
import {
	BehaviorDesignReviewSubjectSchema,
	StandaloneDesignReviewSubjectSchema,
	noBehaviorContractDigest,
} from "./subjects.ts";

const digest = Type.String({ pattern: digestPatternSource });
const uuid = Type.String({ pattern: uuidPatternSource });
const nonEmpty = Type.String({ minLength: 1 });
const identifier = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" });
const artifactPath = Type.Refine(Type.String({ minLength: 1, maxLength: 1024 }), (value) => {
	if (value.startsWith("/") || value.includes("\\") || /[\0\n\r]/.test(value)) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
});
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

export const ResolvedBehaviorSelectorSchema = Type.Object(
	{
		selectorId: identifier,
		value: nonEmpty,
		observationId: identifier,
	},
	{ additionalProperties: false },
);

const BehaviorContractCoreSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		selectors: Type.Array(ResolvedBehaviorSelectorSchema),
		observationIds: Type.Array(identifier, { minItems: 1 }),
		claimKeys: Type.Array(identifier, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const BehaviorContractObject = Type.Object(
	{
		...BehaviorContractCoreSchema.properties,
		id: digest,
	},
	{ additionalProperties: false },
);
export const BehaviorContractSchema = Type.Refine(BehaviorContractObject, (value) => {
	const { id: _id, ...core } = value;
	return canonicalDigest(core) === value.id;
});
export type BehaviorContract = Static<typeof BehaviorContractSchema>;

const NoBehaviorSchema = Type.Object(
	{
		kind: Type.Literal("none"),
		digest: Type.Literal(noBehaviorContractDigest),
	},
	{ additionalProperties: false },
);
const ContractBehaviorSchema = Type.Object(
	{
		kind: Type.Literal("contract"),
		digest,
		contract: BehaviorContractSchema,
		artifactPath,
		artifactDigest: digest,
	},
	{ additionalProperties: false },
);

const DesignSourceSchema = Type.Object(
	{
		runId: uuid,
		approvedDesignId: digest,
		artifactDigest: digest,
	},
	{ additionalProperties: false },
);
export type DesignSource = Static<typeof DesignSourceSchema>;

const ApprovedDesignRecordObject = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		approvedDesignId: digest,
		caller: StringEnum(["design", "fix", "build"] as const),
		reviewSubject: Type.Union([StandaloneDesignReviewSubjectSchema, BehaviorDesignReviewSubjectSchema]),
		reviewSubjectDigest: digest,
		design: Type.Object(
			{ artifactPath, artifactDigest: digest },
			{ additionalProperties: false },
		),
		behavior: Type.Union([NoBehaviorSchema, ContractBehaviorSchema]),
		panel: Type.Object(
			{
				recordPath: artifactPath,
				recordDigest: digest,
				artifactPath,
				artifactDigest: digest,
			},
			{ additionalProperties: false },
		),
		approvedAt: timestamp,
		sourceDesign: Type.Optional(DesignSourceSchema),
	},
	{ additionalProperties: false },
);

export function approvedDesignIdFor(value: {
	reviewSubjectDigest: string;
	panelArtifactDigest: string;
	designDigest: string;
	behaviorDigest: string;
	sourceDesignDigest?: string;
}): string {
	return canonicalDigest({ schemaVersion: 1, ...value });
}

export const ApprovedDesignRecordSchema = Type.Refine(ApprovedDesignRecordObject, (value) => {
	const designDigest = value.reviewSubject.designDigest;
	const behaviorDigest = value.reviewSubject.behaviorContractDigest;
	if (value.reviewSubjectDigest !== canonicalDigest(value.reviewSubject)) return false;
	if (value.design.artifactDigest !== designDigest || value.behavior.digest !== behaviorDigest) return false;
	if (value.caller === "design" && (value.reviewSubject.kind !== "standalone-design" || value.behavior.kind !== "none")) {
		return false;
	}
	if (value.caller !== "design" && (value.reviewSubject.kind !== "behavior-design" || value.behavior.kind !== "contract")) {
		return false;
	}
	if (value.caller !== "build" && value.sourceDesign) return false;
	if (value.behavior.kind === "contract" && value.behavior.contract.id !== value.behavior.digest) return false;
	return (
		value.approvedDesignId ===
		approvedDesignIdFor({
			reviewSubjectDigest: value.reviewSubjectDigest,
			panelArtifactDigest: value.panel.artifactDigest,
			designDigest,
			behaviorDigest,
			...(value.sourceDesign ? { sourceDesignDigest: canonicalDigest(value.sourceDesign) } : {}),
		})
	);
});
export type ApprovedDesignRecord = Static<typeof ApprovedDesignRecordSchema>;

export function decodeDesignData<T extends TSchema>(schema: T, value: unknown): Static<T> {
	if (!Check(schema, value)) {
		const issues = [...Errors(schema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path}: ${error.message}`;
		});
		throw new Error(`Invalid design data: ${issues.join("; ")}`);
	}
	return value as Static<T>;
}
