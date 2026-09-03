import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { AgentProgress } from "../agents/gateway.ts";
import type { RunRef } from "../store/run-store.ts";

export const deepWorkRunEntryType = "deep-work-run";
export const deepWorkAgentEntryType = "deep-work-agent-output";

interface AgentDescriptor {
	label: string;
	role: AgentProgress["role"];
	model: string;
}

type AgentOutputBlock =
	| { type: "thinking"; text: string }
	| { type: "text"; text: string }
	| { type: "tool-call"; name: string; arguments: string };

export type DeepWorkAgentEntry =
	| {
			schemaVersion: 1;
			runId: string;
			job: AgentDescriptor;
			type: "lifecycle";
			state: "started" | "finished";
	  }
	| {
			schemaVersion: 1;
			runId: string;
			job: AgentDescriptor;
			type: "assistant";
			blocks: AgentOutputBlock[];
			errorMessage?: string;
	  }
	| {
			schemaVersion: 1;
			runId: string;
			job: AgentDescriptor;
			type: "tool";
			toolName: string;
			arguments: string;
			output: string;
			isError: boolean;
	  };

interface JobView {
	job: AgentDescriptor;
	activity: string;
	preview: string[];
	finished: boolean;
	updated: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentDescriptor(value: unknown): value is AgentDescriptor {
	return (
		isRecord(value) &&
		typeof value.label === "string" &&
		typeof value.role === "string" &&
		typeof value.model === "string"
	);
}

function isOutputBlock(value: unknown): value is AgentOutputBlock {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "thinking" || value.type === "text") return typeof value.text === "string";
	return value.type === "tool-call" && typeof value.name === "string" && typeof value.arguments === "string";
}

function isDeepWorkAgentEntry(value: unknown): value is DeepWorkAgentEntry {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.runId !== "string" ||
		!isAgentDescriptor(value.job) ||
		typeof value.type !== "string"
	) {
		return false;
	}
	if (value.type === "lifecycle") return value.state === "started" || value.state === "finished";
	if (value.type === "assistant") {
		return (
			Array.isArray(value.blocks) &&
			value.blocks.every(isOutputBlock) &&
			(value.errorMessage === undefined || typeof value.errorMessage === "string")
		);
	}
	return (
		value.type === "tool" &&
		typeof value.toolName === "string" &&
		typeof value.arguments === "string" &&
		typeof value.output === "string" &&
		typeof value.isError === "boolean"
	);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function formatToolArguments(toolName: string, value: unknown): string {
	if (!isRecord(value)) return safeJson(value);
	const path = typeof value.path === "string" ? value.path : undefined;
	if (toolName === "workspace_write" && path && typeof value.content === "string") {
		return `${path} (${value.content.split("\n").length} lines, ${value.content.length} characters)`;
	}
	if (toolName === "workspace_edit" && path && Array.isArray(value.edits)) {
		return `${path} (${value.edits.length} replacement${value.edits.length === 1 ? "" : "s"})`;
	}
	return safeJson(value);
}

function formatToolResult(value: unknown): string {
	if (!isRecord(value) || !Array.isArray(value.content)) return safeJson(value);
	const output = value.content.map((block) => {
		if (!isRecord(block)) return safeJson(block);
		if (block.type === "text" && typeof block.text === "string") return block.text;
		if (block.type === "image") return "[image output]";
		return safeJson(block);
	});
	return output.join("\n") || "(no textual output)";
}

function descriptor(progress: AgentProgress): AgentDescriptor {
	return {
		label: progress.label,
		role: progress.role,
		model: progress.model,
	};
}

function assistantBlocks(message: AssistantMessage): AgentOutputBlock[] {
	return message.content.map((block) => {
		if (block.type === "thinking") return { type: "thinking", text: block.thinking };
		if (block.type === "text") return { type: "text", text: block.text };
		return { type: "tool-call", name: block.name, arguments: "" };
	});
}

function previewLines(message: AssistantMessage): string[] {
	const block = message.content.at(-1);
	if (!block) return [];
	const text = block.type === "thinking" ? block.thinking : block.type === "text" ? block.text : `→ ${block.name}`;
	return text
		.slice(-1_000)
		.replaceAll("\r", "")
		.split("\n")
		.slice(-2)
		.map((line) => (line.length > 160 ? `…${line.slice(-159)}` : line));
}

function updateActivity(progress: AgentProgress): string {
	const event = progress.event;
	switch (event.type) {
		case "agent_start":
			return "started";
		case "turn_start":
			return "thinking";
		case "message_start":
			return event.message.role === "assistant" ? "responding" : "running";
		case "message_update": {
			const type = event.assistantMessageEvent.type;
			if (type.startsWith("thinking")) return "thinking";
			if (type.startsWith("text")) return "responding";
			if (type.startsWith("toolcall")) return "preparing a tool";
			return type === "error" ? "response failed" : "responding";
		}
		case "message_end":
			return event.message.role === "assistant" && event.message.stopReason === "toolUse"
				? "using tools"
				: "turn complete";
		case "tool_execution_start":
			return `running ${event.toolName}`;
		case "tool_execution_update":
			return `running ${event.toolName}`;
		case "tool_execution_end":
			return `${event.toolName} ${event.isError ? "failed" : "complete"}`;
		case "turn_end":
			return "turn complete";
		case "agent_end":
			return event.willRetry ? "waiting to retry" : "finished";
		case "agent_settled":
			return "finished";
		case "auto_retry_start":
			return `retrying (${event.attempt}/${event.maxAttempts})`;
		case "auto_retry_end":
			return event.success ? "retry complete" : "retry failed";
		default:
			return "running";
	}
}

function renderAgentEntry(data: DeepWorkAgentEntry, theme: ExtensionCommandContext["ui"]["theme"]): Container {
	const container = new Container();
	const identity = `deep ${data.runId.slice(0, 8)} · ${data.job.role} · ${data.job.label}`;
	if (data.type === "lifecycle") {
		const color = data.state === "started" ? "accent" : "success";
		container.addChild(new Text(theme.fg(color, `${identity} · ${data.state}`), 0, 0));
		container.addChild(new Text(theme.fg("dim", data.job.model), 0, 0));
		return container;
	}
	if (data.type === "assistant") {
		container.addChild(new Text(theme.fg("accent", identity), 0, 0));
		for (const block of data.blocks) {
			if (block.type === "thinking") {
				container.addChild(new Text(theme.fg("dim", "thinking"), 0, 0));
				container.addChild(new Text(block.text, 0, 0));
			} else if (block.type === "text") {
				container.addChild(new Markdown(block.text, 0, 0, getMarkdownTheme()));
			} else {
				const argumentsText = block.arguments ? `\n${block.arguments}` : "";
				container.addChild(new Text(`${theme.fg("muted", "→ ")}${theme.fg("accent", block.name)}${argumentsText}`, 0, 0));
			}
		}
		if (data.errorMessage) container.addChild(new Text(theme.fg("error", data.errorMessage), 0, 0));
		return container;
	}
	const color = data.isError ? "error" : "success";
	container.addChild(new Text(theme.fg(color, `${identity} · ${data.toolName}`), 0, 0));
	if (data.arguments) container.addChild(new Text(data.arguments, 0, 0));
	container.addChild(new Text(data.output, 0, 0));
	return container;
}

export function registerDeepWorkPresentation(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<{ schemaVersion: 1; runId: string; backend: string }>(
		deepWorkRunEntryType,
		(entry, _options, theme) => {
			const data = entry.data;
			if (
				!data ||
				data.schemaVersion !== 1 ||
				typeof data.runId !== "string" ||
				typeof data.backend !== "string"
			) {
				return new Text(theme.fg("error", "Invalid deep-work run entry"), 0, 0);
			}
			return new Text(
				theme.fg("accent", `deep ${data.runId.slice(0, 8)} · ${data.backend} · started`),
				0,
				0,
			);
		},
	);
	pi.registerEntryRenderer<DeepWorkAgentEntry>(deepWorkAgentEntryType, (entry, _options, theme) => {
		if (!isDeepWorkAgentEntry(entry.data)) {
			return new Text(theme.fg("error", "Invalid deep-work agent output entry"), 0, 0);
		}
		return renderAgentEntry(entry.data, theme);
	});
}

export class DeepWorkRunPresentation {
	private readonly key: string;
	private readonly jobs = new Map<string, JobView>();
	private readonly toolArguments = new Map<string, string>();
	private widget?: Text;
	private requestRender?: () => void;
	private updateSequence = 0;
	private lastStatus?: string;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ref: RunRef,
		private readonly ctx: ExtensionCommandContext,
	) {
		this.key = `deep-work-${ref.runId}`;
		ctx.ui.setWidget(this.key, (tui) => {
			this.widget = new Text("", 1, 0);
			this.requestRender = () => tui.requestRender();
			this.refresh();
			return this.widget;
		});
		this.refresh();
	}

	handle(progress: AgentProgress): void {
		const view = this.jobView(progress);
		const event = progress.event;
		if (event.type === "agent_start") {
			view.finished = false;
			view.preview = [];
		}
		view.activity = updateActivity(progress);
		view.updated = ++this.updateSequence;
		if ((event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant") {
			view.preview = previewLines(event.message);
		}
		if (event.type === "tool_execution_start") {
			this.toolArguments.set(
				this.toolKey(progress, event.toolCallId),
				formatToolArguments(event.toolName, event.args),
			);
		}
		if (event.type === "agent_start") {
			this.append({
				schemaVersion: 1,
				runId: this.ref.runId,
				job: view.job,
				type: "lifecycle",
				state: "started",
			});
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			this.append({
				schemaVersion: 1,
				runId: this.ref.runId,
				job: view.job,
				type: "assistant",
				blocks: assistantBlocks(event.message),
				...(event.message.errorMessage ? { errorMessage: event.message.errorMessage } : {}),
			});
		} else if (event.type === "tool_execution_end") {
			const toolKey = this.toolKey(progress, event.toolCallId);
			this.append({
				schemaVersion: 1,
				runId: this.ref.runId,
				job: view.job,
				type: "tool",
				toolName: event.toolName,
				arguments: this.toolArguments.get(toolKey) ?? "",
				output: formatToolResult(event.result),
				isError: event.isError,
			});
			this.toolArguments.delete(toolKey);
		} else if (event.type === "agent_end" && !event.willRetry) {
			view.finished = true;
			this.append({
				schemaVersion: 1,
				runId: this.ref.runId,
				job: view.job,
				type: "lifecycle",
				state: "finished",
			});
		}
		this.refresh();
	}

	clear(): void {
		this.ctx.ui.setStatus(this.key, undefined);
		this.ctx.ui.setWidget(this.key, undefined);
		this.lastStatus = undefined;
		this.widget = undefined;
		this.requestRender = undefined;
	}

	private append(entry: DeepWorkAgentEntry): void {
		this.pi.appendEntry(deepWorkAgentEntryType, entry);
	}

	private jobKey(progress: AgentProgress): string {
		return `${progress.kind}\0${progress.label}\0${progress.role}\0${progress.model}`;
	}

	private toolKey(progress: AgentProgress, toolCallId: string): string {
		return `${this.jobKey(progress)}\0${toolCallId}`;
	}

	private jobView(progress: AgentProgress): JobView {
		const key = this.jobKey(progress);
		let view = this.jobs.get(key);
		if (!view) {
			view = {
				job: descriptor(progress),
				activity: "starting",
				preview: [],
				finished: false,
				updated: ++this.updateSequence,
			};
			this.jobs.set(key, view);
		}
		return view;
	}

	private refresh(): void {
		const ordered = [...this.jobs.values()].sort((left, right) => right.updated - left.updated);
		const active = ordered.filter((view) => !view.finished);
		const shown = (active.length > 0 ? active : ordered).slice(0, 3);
		const lines = [`deep ${this.ref.runId.slice(0, 8)}  ${this.ref.backend}  Active`];
		for (const view of shown) {
			lines.push(`${view.finished ? "✓" : "●"} ${view.job.role} · ${view.job.label} · ${view.activity}`);
			for (const line of view.preview) lines.push(`  ${line}`);
		}
		this.widget?.setText(lines.join("\n"));
		this.requestRender?.();

		const current = active[0];
		const status = current
			? `deep ${this.ref.runId.slice(0, 8)} · ${active.length > 1 ? `${active.length} agents · ` : ""}${current.job.role} ${current.activity}`
			: `deep ${this.ref.runId.slice(0, 8)} active`;
		if (status !== this.lastStatus) {
			this.lastStatus = status;
			this.ctx.ui.setStatus(this.key, this.ctx.ui.theme.fg("accent", status));
		}
	}
}
