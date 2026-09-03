import type { WorkflowKind } from "../application/types.ts";

export type ParsedCommand =
	| { kind: "help" | "config" }
	| { kind: "init"; refresh: boolean }
	| { kind: "status" | "cancel"; runId?: string }
	| { kind: "resume"; runId: string }
	| { kind: "recover"; runId: string; challenge: string }
	| {
			kind: "start";
			workflow: WorkflowKind;
			goal: string;
			base?: string;
			unslopText?: string;
			sourceDesignRunId?: string;
			designFeedback?: string;
	  };

const workflowNames = new Set<WorkflowKind>(["how", "design", "review", "fix", "build", "verify", "unslop"]);

export const usage = `Usage:
  /deep help
  /deep config
  /deep init [--refresh]
  /deep how <question>
  /deep design [--from <run-id>] <goal-or-feedback>
  /deep review [--base <ref-or-revset>] [intent]
  /deep fix <bug report>
  /deep build [--design <run-id>] [additional constraints]
  /deep verify <claim>
  /deep unslop [--base <ref-or-revset>] [text]
  /deep status [run-id]
  /deep resume <run-id>
  /deep cancel [run-id]
  /deep recover <run-id> <challenge>`;

export class CommandParseError extends Error {
	constructor(message: string) {
		super(`${message}\n\n${usage}`);
		this.name = "CommandParseError";
	}
}

export function parseCommand(raw: string): ParsedCommand {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "help" };
	const name = tokens.shift()!;
	if (name === "help" || name === "config") {
		if (tokens.length > 0) throw new CommandParseError(`/deep ${name} does not accept arguments`);
		return { kind: name };
	}
	if (name === "init") {
		if (tokens.length === 0) return { kind: "init", refresh: false };
		if (tokens.length === 1 && tokens[0] === "--refresh") return { kind: "init", refresh: true };
		throw new CommandParseError("/deep init accepts only --refresh");
	}
	if (name === "status" || name === "cancel") {
		if (tokens.length > 1) throw new CommandParseError(`/deep ${name} accepts at most one run ID`);
		return { kind: name, ...(tokens[0] ? { runId: tokens[0] } : {}) };
	}
	if (name === "resume") {
		if (tokens.length !== 1) throw new CommandParseError("/deep resume requires exactly one run ID");
		return { kind: "resume", runId: tokens[0] };
	}
	if (name === "recover") {
		if (tokens.length !== 2) throw new CommandParseError("/deep recover requires one run ID and one status challenge");
		return { kind: "recover", runId: tokens[0], challenge: tokens[1] };
	}
	if (!workflowNames.has(name as WorkflowKind)) throw new CommandParseError(`Unknown /deep command: ${name}`);
	const workflow = name as WorkflowKind;
	let base: string | undefined;
	let sourceDesignRunId: string | undefined;
	let sourceOption: "from" | "design" | undefined;
	const goal: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--base") {
			if (base !== undefined) throw new CommandParseError("--base may be supplied only once");
			base = tokens[++index];
			if (!base || base.startsWith("--")) throw new CommandParseError("--base requires a ref or revset value");
			continue;
		}
		if (token === "--from" || token === "--design") {
			if (sourceDesignRunId !== undefined) throw new CommandParseError("A design source may be supplied only once");
			sourceOption = token === "--from" ? "from" : "design";
			sourceDesignRunId = tokens[++index];
			if (!sourceDesignRunId || sourceDesignRunId.startsWith("--")) {
				throw new CommandParseError(`${token} requires a run ID`);
			}
			continue;
		}
		if (token.startsWith("--")) throw new CommandParseError(`Unknown option: ${token}`);
		goal.push(token);
	}
	if (base && workflow !== "review" && workflow !== "unslop") {
		throw new CommandParseError(`--base is not valid for /deep ${workflow}`);
	}
	if (sourceOption === "from" && workflow !== "design") {
		throw new CommandParseError("--from is valid only for /deep design");
	}
	if (sourceOption === "design" && workflow !== "build") {
		throw new CommandParseError("--design is valid only for /deep build");
	}
	const text = goal.join(" ");
	if (workflow === "design" && sourceDesignRunId && !text) {
		throw new CommandParseError("/deep design --from requires operator feedback");
	}
	if (!["review", "unslop"].includes(workflow) && !text && !(workflow === "build" && sourceDesignRunId)) {
		throw new CommandParseError(`/deep ${workflow} requires a goal`);
	}
	if (workflow === "unslop" && base && text) {
		throw new CommandParseError("/deep unslop accepts either text or --base, not both");
	}
	const effectiveGoal = text ||
		(workflow === "build" && sourceDesignRunId
			? `Build approved design ${sourceDesignRunId}`
			: workflow === "review"
				? "Review current changes"
				: "Audit current changes");
	return {
		kind: "start",
		workflow,
		goal: effectiveGoal,
		...(base ? { base } : {}),
		...(workflow === "unslop" && text ? { unslopText: text } : {}),
		...(sourceDesignRunId ? { sourceDesignRunId, ...(text ? { designFeedback: text } : {}) } : {}),
	};
}

export const commandNames = [
	"help",
	"config",
	"init",
	"how",
	"design",
	"review",
	"fix",
	"build",
	"verify",
	"unslop",
	"status",
	"resume",
	"cancel",
	"recover",
] as const;
