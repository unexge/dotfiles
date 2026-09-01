import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
const identifier = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" });
const nonEmpty = Type.String({ minLength: 1 });
const relativePath = Type.Refine(Type.String({ minLength: 1, maxLength: 1024 }), (value) => {
	if (value.startsWith("/") || value.includes("\\") || /[\0\n\r]/.test(value)) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
});
const mainline = Type.Refine(Type.String({ minLength: 1, maxLength: 255 }), (value) => {
	return !/[\0\s~^:?*\[]/.test(value) && !value.includes("..") && !value.includes("@{") && !value.startsWith("/") && !value.endsWith("/");
});
const argv = Type.Array(nonEmpty, { minItems: 1 });
const timeout = Type.Integer({ minimum: 1_000, maximum: 3_600_000 });
const language = StringEnum(["rust", "zig", "python", "typescript"] as const);

const ModelSelectionSchema = Type.Object(
	{
		provider: nonEmpty,
		id: nonEmpty,
		thinkingLevel: Type.Literal("max"),
	},
	{ additionalProperties: false },
);

export const GateSpecSchema = Type.Object(
	{
		id: identifier,
		languages: Type.Array(language, { minItems: 1 }),
		argv,
		timeoutMs: timeout,
	},
	{ additionalProperties: false },
);

export const ObservationSpecSchema = Type.Object(
	{
		id: identifier,
		claimKeys: Type.Array(identifier, { minItems: 1 }),
		argv,
		timeoutMs: timeout,
	},
	{ additionalProperties: false },
);

export const VerificationContractSchema = Type.Object(
	{
		id: identifier,
		claim: nonEmpty,
		requiredClaimKeys: Type.Array(identifier, { minItems: 1 }),
		observationIds: Type.Array(identifier, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const SelectorSpecSchema = Type.Object(
	{
		id: identifier,
		language,
		observationId: identifier,
		valuePattern: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false },
);

export const NormalizerSpecSchema = Type.Object(
	{
		id: identifier,
		argv,
		timeoutMs: timeout,
		allowedChangedPaths: Type.Array(relativePath, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const LanguageScopeSchema = Type.Object(
	{
		language,
		paths: Type.Array(relativePath, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const MachinePolicySchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		models: Type.Object(
			{
				gpt: ModelSelectionSchema,
				opusReviewers: Type.Array(ModelSelectionSchema, { minItems: 1 }),
			},
			{ additionalProperties: false },
		),
		concurrency: Type.Integer({ minimum: 1, maximum: 8 }),
		maxRepairRounds: Type.Integer({ minimum: 0, maximum: 5 }),
		commandTimeoutMs: timeout,
		minimumQuickGates: Type.Array(GateSpecSchema, { minItems: 1 }),
		minimumFullGates: Type.Array(GateSpecSchema, { minItems: 1 }),
		observations: Type.Array(ObservationSpecSchema),
		verificationContracts: Type.Array(VerificationContractSchema),
		selectors: Type.Array(SelectorSpecSchema),
	},
	{ additionalProperties: false },
);

export const ProjectPolicySchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		mainline,
		quickGates: Type.Array(GateSpecSchema),
		fullGates: Type.Array(GateSpecSchema),
		normalizers: Type.Array(NormalizerSpecSchema),
		observations: Type.Array(ObservationSpecSchema),
		verificationContracts: Type.Array(VerificationContractSchema),
		selectors: Type.Array(SelectorSpecSchema),
		languageScopes: Type.Array(LanguageScopeSchema),
	},
	{ additionalProperties: false },
);

export const SelectorProposalSchema = Type.Object(
	{
		selectorId: identifier,
		value: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false },
);

export type GateSpec = Static<typeof GateSpecSchema>;
export type ObservationSpec = Static<typeof ObservationSpecSchema>;
export type VerificationContract = Static<typeof VerificationContractSchema>;
export type SelectorSpec = Static<typeof SelectorSpecSchema>;
export type NormalizerSpec = Static<typeof NormalizerSpecSchema>;
export type MachinePolicy = Static<typeof MachinePolicySchema>;
export type ProjectPolicy = Static<typeof ProjectPolicySchema>;
export type SelectorProposal = Static<typeof SelectorProposalSchema>;

export class PolicyDecodeError extends Error {
	constructor(readonly issues: string[]) {
		super(`Invalid policy: ${issues.join("; ")}`);
		this.name = "PolicyDecodeError";
	}
}

function decode<TSchemaDef extends TSchema>(schema: TSchemaDef, value: unknown): Static<TSchemaDef> {
	if (!Check(schema, value)) {
		const issues = [...Errors(schema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path}: ${error.message}`;
		});
		throw new PolicyDecodeError(issues);
	}
	return value as Static<TSchemaDef>;
}

export const decodeMachinePolicy = (value: unknown): MachinePolicy => decode(MachinePolicySchema, value);
export const decodeProjectPolicy = (value: unknown): ProjectPolicy => decode(ProjectPolicySchema, value);
export const decodeSelectorProposal = (value: unknown): SelectorProposal => decode(SelectorProposalSchema, value);
