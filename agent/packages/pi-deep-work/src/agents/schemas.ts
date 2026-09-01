import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

const identifier = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" });
const nonEmpty = Type.String({ minLength: 1, maxLength: 100_000 });
const relativePath = Type.Refine(Type.String({ minLength: 1, maxLength: 1024 }), (value) => {
	if (value.startsWith("/") || value.includes("\\") || /[\0\n\r]/.test(value)) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
});

const CitationSchema = Type.Object(
	{
		path: relativePath,
		startLine: Type.Optional(Type.Integer({ minimum: 1 })),
		endLine: Type.Optional(Type.Integer({ minimum: 1 })),
		detail: nonEmpty,
	},
	{ additionalProperties: false },
);

const FindingSchema = Type.Object(
	{
		id: identifier,
		severity: StringEnum(["blocker", "important", "suggestion"] as const),
		title: nonEmpty,
		detail: nonEmpty,
		path: Type.Optional(relativePath),
		line: Type.Optional(Type.Integer({ minimum: 1 })),
		evidence: Type.Array(nonEmpty),
		recommendation: nonEmpty,
	},
	{ additionalProperties: false },
);

const SelectorProposalSchema = Type.Object(
	{
		selectorId: identifier,
		value: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false },
);

const common = {
	status: StringEnum(["ok", "blocked", "failed"] as const),
	summary: nonEmpty,
	citations: Type.Array(CitationSchema),
};

export const PlanReportSchema = Type.Object(
	{
		...common,
		interpretation: nonEmpty,
		successCriteria: Type.Array(nonEmpty, { minItems: 1 }),
		steps: Type.Array(nonEmpty, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const ExplorationReportSchema = Type.Object(
	{
		...common,
		components: Type.Array(nonEmpty),
		flow: Type.Array(nonEmpty),
		constraints: Type.Array(nonEmpty),
		unknowns: Type.Array(nonEmpty),
	},
	{ additionalProperties: false },
);

export const DesignReportSchema = Type.Object(
	{
		...common,
		usage: nonEmpty,
		dataShape: nonEmpty,
		interfaces: Type.Array(nonEmpty),
		modules: Type.Array(nonEmpty),
		invariants: Type.Array(nonEmpty, { minItems: 1 }),
		tradeoffs: Type.Array(nonEmpty),
		verification: Type.Array(nonEmpty, { minItems: 1 }),
		testSelectors: Type.Array(SelectorProposalSchema),
	},
	{ additionalProperties: false },
);

export const ImplementationReportSchema = Type.Object(
	{
		...common,
		changes: Type.Array(
			Type.Object(
				{
					path: relativePath,
					detail: nonEmpty,
				},
				{ additionalProperties: false },
			),
		),
		testSelectors: Type.Array(SelectorProposalSchema),
	},
	{ additionalProperties: false },
);

export const VerificationReportSchema = Type.Object(
	{
		...common,
		verdict: StringEnum(["VERIFIED", "NOT_VERIFIED", "INCONCLUSIVE", "BLOCKED"] as const),
		predicate: nonEmpty,
		evidence: Type.Array(nonEmpty),
		limitations: Type.Array(nonEmpty),
	},
	{ additionalProperties: false },
);

export const ReviewReportSchema = Type.Object(
	{
		...common,
		verdict: StringEnum(["approve", "changes_required"] as const),
		findings: Type.Array(FindingSchema),
	},
	{ additionalProperties: false },
);

export const AdjudicationReportSchema = Type.Object(
	{
		...common,
		decisions: Type.Array(
			Type.Object(
				{
					findingId: identifier,
					disposition: StringEnum(["accepted", "disproved", "open"] as const),
					rationale: nonEmpty,
					evidence: Type.Array(nonEmpty, { minItems: 1 }),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const EditorialReportSchema = Type.Object(
	{
		...common,
		output: nonEmpty,
	},
	{ additionalProperties: false },
);

export const agentReportSchemas = Object.freeze({
	plan: PlanReportSchema,
	explore: ExplorationReportSchema,
	design: DesignReportSchema,
	implement: ImplementationReportSchema,
	repair: ImplementationReportSchema,
	verify: VerificationReportSchema,
	adjudicate: AdjudicationReportSchema,
	edit: EditorialReportSchema,
	"review-design": ReviewReportSchema,
	"review-code": ReviewReportSchema,
});

export type AgentJobKind = keyof typeof agentReportSchemas;
export type PlanReport = Static<typeof PlanReportSchema>;
export type ExplorationReport = Static<typeof ExplorationReportSchema>;
export type DesignReport = Static<typeof DesignReportSchema>;
export type ImplementationReport = Static<typeof ImplementationReportSchema>;
export type VerificationReport = Static<typeof VerificationReportSchema>;
export type ReviewReport = Static<typeof ReviewReportSchema>;
export type AdjudicationReport = Static<typeof AdjudicationReportSchema>;
export type EditorialReport = Static<typeof EditorialReportSchema>;

export interface AgentReportByKind {
	plan: PlanReport;
	explore: ExplorationReport;
	design: DesignReport;
	implement: ImplementationReport;
	repair: ImplementationReport;
	verify: VerificationReport;
	adjudicate: AdjudicationReport;
	edit: EditorialReport;
	"review-design": ReviewReport;
	"review-code": ReviewReport;
}

export class AgentReportDecodeError extends Error {
	constructor(readonly issues: string[]) {
		super(`Invalid agent report: ${issues.join("; ")}`);
		this.name = "AgentReportDecodeError";
	}
}

export function decodeAgentReport<K extends AgentJobKind>(kind: K, value: unknown): AgentReportByKind[K] {
	const schema: TSchema = agentReportSchemas[kind];
	if (!Check(schema, value)) {
		const issues = [...Errors(schema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path}: ${error.message}`;
		});
		throw new AgentReportDecodeError(issues);
	}
	return value as AgentReportByKind[K];
}
