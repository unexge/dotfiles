import { describe, expect, it } from "vitest";
import { decodeResolutionArtifact } from "../src/review/resolution.ts";
import { renderChangesRequiredMarkdown } from "../src/review/outcome-markdown.ts";

const minimal = { id: "r1:gap", reviewerId: "test/reviewer", severity: "important", title: "Gap", detail: "Missing guard" };
const complete = { ...minimal, path: "src/cache.ts", line: 12, evidence: ["cache.get returns stale data"], recommendation: "Invalidate on update" };

describe("resolution finding evidence", () => {
	it("roundtrips full findings and renders the available evidence", () => {
		const decoded = decodeResolutionArtifact(JSON.parse(JSON.stringify({ findings: [complete] })));
		expect(decoded.findings).toEqual([complete]);
		const markdown = renderChangesRequiredMarkdown({ runId: "run", workflow: "build", goal: "cache", phase: "code review", findings: decoded.findings });
		for (const text of ["src/cache.ts:12", complete.evidence[0], complete.recommendation]) expect(markdown).toContain(text);
	});

	it("keeps minimal stored findings readable without invented evidence", () => {
		expect(decodeResolutionArtifact({ findings: [minimal] }).findings).toEqual([minimal]);
	});

	it.each([{ path: 1 }, { line: 0 }, { line: 1.5 }, { evidence: [1] }, { recommendation: false }])("rejects malformed optional evidence %j", (invalid) => {
		expect(() => decodeResolutionArtifact({ findings: [{ ...minimal, ...invalid }] })).toThrow("malformed");
	});
});
