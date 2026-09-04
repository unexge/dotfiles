import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { decodeAgentReport, type DesignReport } from "../agents/schemas.ts";
import { uuidPatternSource } from "../application/types.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { CanonicalFinding } from "./panel.ts";
import {
	ApprovedDesignRecordSchema,
	decodeDesignData,
	type ApprovedDesignRecord,
} from "./design.ts";
import { digestFrozenArtifact } from "./subjects.ts";
import type { RunStore } from "../store/run-store.ts";
import { loadRunRecords } from "../service/records.ts";

const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
const uuid = Type.String({ pattern: uuidPatternSource });
const nonEmpty = Type.String({ minLength: 1 });
const finding = Type.Object(
	{
		id: nonEmpty,
		reviewerId: nonEmpty,
		severity: Type.Union([Type.Literal("blocker"), Type.Literal("important"), Type.Literal("suggestion")]),
		title: nonEmpty,
		detail: nonEmpty,
	},
	{ additionalProperties: false },
);
const legacyDesignReport = Type.Object(
	{
		status: Type.Union([Type.Literal("ok"), Type.Literal("blocked"), Type.Literal("failed")]),
		summary: nonEmpty,
		citations: Type.Array(
			Type.Object(
				{
					path: nonEmpty,
					startLine: Type.Optional(Type.Integer({ minimum: 1 })),
					endLine: Type.Optional(Type.Integer({ minimum: 1 })),
					detail: nonEmpty,
				},
				{ additionalProperties: false },
			),
		),
		usage: nonEmpty,
		dataShape: nonEmpty,
		interfaces: Type.Array(nonEmpty),
		modules: Type.Array(nonEmpty),
		invariants: Type.Array(nonEmpty, { minItems: 1 }),
		tradeoffs: Type.Array(nonEmpty),
		verification: Type.Array(nonEmpty, { minItems: 1 }),
		testSelectors: Type.Array(
			Type.Object({ selectorId: nonEmpty, value: nonEmpty }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);
const source = Type.Object(
	{
		runId: uuid,
		approvedDesignId: Type.Optional(digest),
		artifactDigest: digest,
		feedback: nonEmpty,
	},
	{ additionalProperties: false },
);
const designOutput = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		proposedOutcome: Type.Union([Type.Literal("DesignApproved"), Type.Literal("ChangesRequired")]),
		goal: nonEmpty,
		designDigest: digest,
		design: Type.Unknown(),
		findings: Type.Optional(Type.Array(finding)),
		approval: Type.Record(Type.String(), Type.Unknown()),
		source: Type.Optional(source),
	},
	{ additionalProperties: true },
);

type DesignOutput = Static<typeof designOutput>;

export interface DesignHandoff {
	runId: string;
	goal: string;
	design: DesignReport;
	designDigest: string;
	findings: readonly CanonicalFinding[];
	approvedDesign?: ApprovedDesignRecord;
}

export interface DesignLineage {
	runId: string;
	approvedDesignId?: string;
	artifactDigest: string;
	feedback: string;
}

export async function loadDesignHandoff(
	store: RunStore,
	runId: string,
	expectedRepositoryId: string,
): Promise<DesignHandoff> {
	const ref = await store.find(runId);
	if (ref.repositoryId !== expectedRepositoryId) throw new Error("Design run belongs to another repository");
	const state = await store.load(ref);
	if (
		state.workflow !== "design" ||
		state.lifecycle !== "Completed" ||
		(state.outcome !== "DesignApproved" && state.outcome !== "ChangesRequired")
	) {
		throw new Error(`run ${ref.runId.slice(0, 8)} is not a completed design`);
	}
	const records = await loadRunRecords(store, ref);
	if (records.repository.repositoryId !== expectedRepositoryId) {
		throw new Error("Design run repository metadata contradicts its run identity");
	}
	const output = decode(designOutput, JSON.parse((await store.readArtifact(ref, state.summaryArtifact)).toString("utf8")));
	if (output.goal !== state.goal || output.goal !== records.request.goal || output.proposedOutcome !== state.outcome) {
		throw new Error("Design output contradicts its run metadata");
	}
	const rawDesign = output.design;
	const design = decodeCompatibleDesign(rawDesign);
	if (digestFrozenArtifact(canonicalJson(rawDesign)) !== output.designDigest) {
		throw new Error("Design output digest does not match its structured design");
	}
	const findings = output.findings ?? legacyFindings(output.approval);
	const handoff: DesignHandoff = {
		runId: ref.runId,
		goal: output.goal,
		design,
		designDigest: output.designDigest,
		findings,
	};
	if (state.outcome !== "DesignApproved") return handoff;
	const approval = output.approval;
	const approvedDesignId = approval.approvedDesignId;
	const recordPath = approval.recordPath;
	if (typeof approvedDesignId !== "string" || typeof recordPath !== "string") {
		throw new Error("Approved design output does not identify its immutable record");
	}
	const record = decodeDesignData(
		ApprovedDesignRecordSchema,
		JSON.parse((await store.readArtifact(ref, recordPath)).toString("utf8")),
	);
	if (record.approvedDesignId !== approvedDesignId || record.caller !== "design") {
		throw new Error("Approved design record contradicts its standalone design run");
	}
	const designBytes = await store.readArtifact(ref, record.design.artifactPath);
	if (
		digestFrozenArtifact(designBytes) !== record.design.artifactDigest ||
		designBytes.toString("utf8") !== canonicalJson(rawDesign)
	) {
		throw new Error("Approved design artifact contradicts its reviewed design");
	}
	return { ...handoff, approvedDesign: record };
}

export function renderDesignMarkdown(input: {
	runId: string;
	goal: string;
	design: DesignReport;
	designDigest: string;
	outcome: "DesignApproved" | "ChangesRequired";
	revisionRounds: number;
	findings: readonly CanonicalFinding[];
	approvedDesignId?: string;
	source?: DesignLineage;
}): string {
	const lines = [
		"<!--",
		`deep-work-run-id: ${input.runId}`,
		...(input.approvedDesignId ? [`deep-work-design-id: ${input.approvedDesignId}`] : []),
		`source-digest: ${input.designDigest}`,
		"-->",
		"",
		`# Design: ${input.goal}`,
		"",
		`**Status:** ${input.outcome === "DesignApproved" ? (input.findings.length > 0 ? "Approved with suggestions" : "Approved") : "Changes required"}`,
		"",
		`**Corrective iterations completed:** ${input.revisionRounds}`,
	];
	if (input.source) {
		lines.push(
			"",
			"## Revision",
			"",
			`Revises design run \`${input.source.runId}\`${input.source.approvedDesignId ? ` (\`${input.source.approvedDesignId}\`)` : ""}.`,
			"",
			"### Operator feedback",
			"",
			input.source.feedback,
		);
	}
	lines.push(
		"",
		"## Summary",
		"",
		input.design.summary,
		"",
		"## Caller usage",
		"",
		input.design.usage,
		"",
		"## Constraints",
		"",
		...list(input.design.constraints),
		"",
		"## Decisions",
		"",
		...input.design.decisions.flatMap((decision) => [
			`### ${decision.decision}`,
			"",
			decision.rationale,
			"",
		]),
		"## Data shape",
		"",
		input.design.dataShape,
		"",
		"## Interfaces",
		"",
		...list(input.design.interfaces),
		"",
		"## Module changes",
		"",
		...list(input.design.modules),
		"",
		"## Invariants",
		"",
		...list(input.design.invariants),
		"",
		"## Rejected alternatives",
		"",
		...(input.design.alternatives.length > 0
			? input.design.alternatives.flatMap((alternative) => [
					`### ${alternative.option}`,
					"",
					alternative.rejectedBecause,
					"",
				])
			: ["None recorded.", ""]),
		"## Tradeoffs",
		"",
		...list(input.design.tradeoffs),
		"",
		"## Verification",
		"",
		...list(input.design.verification),
		"",
		"## Open questions",
		"",
		...list(input.design.openQuestions),
		"",
		"## Source citations",
		"",
		...(input.design.citations.length > 0
			? input.design.citations.map((citation) => {
					const range = citation.startLine
						? `:${citation.startLine}${citation.endLine && citation.endLine !== citation.startLine ? `-${citation.endLine}` : ""}`
						: "";
					return `- \`${citation.path}${range}\` - ${citation.detail}`;
				})
			: ["None recorded."]),
		"",
		"## Review",
		"",
		...(input.findings.length > 0
			? input.findings.flatMap((finding) => [
					`### ${finding.severity}: ${finding.title}`,
					"",
					finding.detail,
					"",
					`Reviewer: \`${finding.reviewerId}\``,
					"",
				])
			: ["No findings.", ""]),
		"## Recommended next step",
		"",
		input.outcome === "DesignApproved"
			? `Build this design with \`/deep build --design ${input.runId.slice(0, 8)}\`.`
			: `Resolve the remaining decisions with \`/deep resolve ${input.runId.slice(0, 8)}\`.`,
	);
	return `${lines.join("\n").trimEnd()}\n`;
}

function decodeCompatibleDesign(value: unknown): DesignReport {
	try {
		return decodeAgentReport("design", value);
	} catch {
		const legacy = decode(legacyDesignReport, value);
		return {
			...legacy,
			constraints: [],
			decisions: [{ decision: legacy.summary, rationale: "Approved by the legacy design review." }],
			alternatives: [],
			openQuestions: [],
		};
	}
}

function legacyFindings(approval: Record<string, unknown>): readonly CanonicalFinding[] {
	return Array.isArray(approval.findings) ? decode(Type.Array(finding), approval.findings) : [];
}

function list(values: readonly string[]): string[] {
	return values.length > 0 ? values.map((value) => `- ${value}`) : ["None recorded."];
}

function decode<T extends TSchema>(schema: T, value: unknown): Static<T> {
	if (!Check(schema, value)) {
		const issues = [...Errors(schema, value)].map((error) => `${"path" in error ? error.path : "/"}: ${error.message}`);
		throw new Error(`Invalid design handoff: ${issues.join("; ")}`);
	}
	return value as Static<T>;
}
