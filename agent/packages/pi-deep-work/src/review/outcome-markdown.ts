import type { CanonicalFinding } from "./panel.ts";

export function renderChangesRequiredMarkdown(input: {
	runId: string;
	workflow: "build" | "fix" | "review";
	goal: string;
	phase: "design review" | "code review";
	findings: readonly CanonicalFinding[];
	iterationCount?: number;
}): string {
	const lines = [
		"<!--",
		`deep-work-run-id: ${input.runId}`,
		"-->",
		"",
		`# ${title(input.workflow)}: changes required`,
		"",
		`**Goal:** ${input.goal}`,
		"",
		`**Stopped during:** ${input.phase}`,
		...(input.iterationCount === undefined ? [] : ["", `**Corrective iterations completed:** ${input.iterationCount}`]),
		"",
		"## Review findings",
		"",
		...findings(input.findings),
		"",
		"## Recommended next step",
		"",
		input.workflow === "review"
			? "Address the findings, then run `/deep review` again against the updated diff."
			: `Run \`/deep resolve ${input.runId.slice(0, 8)}\` to answer unresolved decisions and start a linked ${input.workflow} workflow.`,
	];
	return `${lines.join("\n").trimEnd()}\n`;
}

function title(workflow: "build" | "fix" | "review"): string {
	return workflow[0].toUpperCase() + workflow.slice(1);
}

function findings(values: readonly CanonicalFinding[]): string[] {
	if (values.length === 0) return ["No structured findings were recorded."];
	return values.flatMap((finding) => [
		`### ${finding.severity}: ${finding.title}`,
		"",
		finding.detail,
		"",
		`Reviewer: \`${finding.reviewerId}\``,
		"",
	]);
}
