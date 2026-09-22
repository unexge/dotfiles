import { decodeAgentReport, type DesignReport } from "../agents/schemas.ts";
import type { CanonicalFinding } from "./panel.ts";

export interface ResolutionArtifact {
	design?: DesignReport;
	findings: readonly CanonicalFinding[];
	implementationCheckpoint: boolean;
}

export function decodeResolutionArtifact(value: unknown): ResolutionArtifact {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resolution artifact is not an object");
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.findings)) throw new Error("Resolution artifact has no review findings");
	const findings = record.findings.map((finding, index): CanonicalFinding => {
		if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
			throw new Error(`Resolution finding ${index + 1} is malformed`);
		}
		const item = finding as Record<string, unknown>;
		const severity = item.severity;
		if (
			typeof item.id !== "string" ||
			typeof item.reviewerId !== "string" ||
			(severity !== "blocker" && severity !== "important" && severity !== "suggestion") ||
			typeof item.title !== "string" ||
			typeof item.detail !== "string" ||
			(item.path !== undefined && (typeof item.path !== "string" || item.path.length === 0)) ||
			(item.line !== undefined && (typeof item.line !== "number" || !Number.isInteger(item.line) || item.line < 1)) ||
			(item.evidence !== undefined && (!Array.isArray(item.evidence) || !item.evidence.every((entry): entry is string => typeof entry === "string" && entry.length > 0))) ||
			(item.recommendation !== undefined && (typeof item.recommendation !== "string" || item.recommendation.length === 0))
		) {
			throw new Error(`Resolution finding ${index + 1} is malformed`);
		}
		return {
			id: item.id, reviewerId: item.reviewerId, severity, title: item.title, detail: item.detail,
			...(item.path === undefined ? {} : { path: item.path }),
			...(item.line === undefined ? {} : { line: item.line }),
			...(item.evidence === undefined ? {} : { evidence: item.evidence }),
			...(item.recommendation === undefined ? {} : { recommendation: item.recommendation }),
		};
	});
	return {
		...(record.design === undefined ? {} : { design: decodeAgentReport("design", record.design) }),
		findings,
		implementationCheckpoint: record.implementationCheckpoint !== undefined,
	};
}
