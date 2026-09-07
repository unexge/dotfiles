import type { DesignReport } from "../agents/schemas.ts";
import type { CanonicalFinding } from "../review/panel.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { ObservationSession } from "./observation-session.ts";

interface ChangesRequired {
	status: "ChangesRequired";
	findings: readonly CanonicalFinding[];
}

interface RevisionInput<Approval extends { status: string }> {
	initialDesign: DesignReport;
	maxRevisionRounds: number;
	observed: ObservationSession;
	approve: (design: DesignReport, priorFindings: readonly CanonicalFinding[]) => Promise<Approval>;
	validate?: (design: DesignReport) => void;
	context?: readonly string[];
}

export async function reviseDesignUntilSettled<Approval extends { status: string }>(
	input: RevisionInput<Approval>,
): Promise<{ design: DesignReport; approval: Approval; revisionRounds: number }> {
	let design = input.initialDesign;
	let priorFindings: readonly CanonicalFinding[] = [];
	for (let round = 0; ; round++) {
		input.validate?.(design);
		const approval = await input.approve(design, priorFindings);
		if (!isChangesRequired(approval) || round >= input.maxRevisionRounds) {
			return { design, approval, revisionRounds: round };
		}
		priorFindings = approval.findings;
		const revision = await input.observed.run({
			kind: "design",
			label: `revise design ${round + 1}`,
			task: [
				"Revise the complete design to address every blocker and important review finding.",
				"Suggestions are optional and must not distract from substantive findings.",
				"Preserve valid decisions and return a complete replacement design, not a patch or commentary.",
				...(input.context ?? []),
				"Current design:",
				canonicalJson(design),
				"Validated review findings:",
				canonicalJson(approval.findings),
			].join("\n\n"),
		});
		if (revision.report.value.status !== "ok") {
			throw new DesignRevisionAgentStatusError(revision.report.value.status);
		}
		design = revision.report.value;
	}
}

function isChangesRequired<T extends { status: string }>(value: T): value is T & ChangesRequired {
	return value.status === "ChangesRequired";
}

export class DesignRevisionAgentStatusError extends Error {
	constructor(readonly status: "blocked" | "failed") {
		super(`design revision agent returned ${status}`);
		this.name = "DesignRevisionAgentStatusError";
	}
}
