import type { Component } from "@earendil-works/pi-tui";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AgentProgress } from "../src/agents/gateway.ts";
import {
	DeepWorkRunPresentation,
	deepWorkAgentEntryType,
	registerDeepWorkPresentation,
	type DeepWorkAgentEntry,
} from "../src/service/presentation.ts";
import type { RunRef } from "../src/store/run-store.ts";

const ref: RunRef = {
	directory: "/tmp/run",
	runId: "12345678-1234-1234-1234-123456789abc",
	repositoryId: "a".repeat(64),
	backend: "git",
};

function progress(event: AgentProgress["event"]): AgentProgress {
	return {
		kind: "design",
		label: "design candidate 1",
		role: "designer",
		model: "test/model",
		event,
	};
}

function fixture() {
	const entries: Array<{ customType: string; data: unknown }> = [];
	const statuses: Array<string | undefined> = [];
	let widget: Component | undefined;
	let renders = 0;
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: {
			theme: { fg: (_color: string, value: string) => value },
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			setWidget: (
				_key: string,
				content:
					| undefined
					| string[]
					| ((tui: { requestRender(): void }, theme: unknown) => Component),
			) => {
				if (typeof content === "function") {
					widget = content({ requestRender: () => renders++ }, {});
				} else if (content === undefined) {
					widget = undefined;
				}
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		entries,
		statuses,
		get widget() {
			return widget;
		},
		get renders() {
			return renders;
		},
		presentation: new DeepWorkRunPresentation(pi, ref, ctx),
	};
}

describe("deep-work presentation", () => {
	it("renders persisted child output in the transcript", () => {
		let renderer: ((entry: unknown, options: unknown, theme: unknown) => Component | undefined) | undefined;
		registerDeepWorkPresentation({
			registerEntryRenderer: (customType: string, value: typeof renderer) => {
				if (customType === deepWorkAgentEntryType) renderer = value;
			},
		} as unknown as ExtensionAPI);
		const component = renderer?.(
			{
				data: {
					schemaVersion: 1,
					runId: ref.runId,
					job: { label: "design candidate 1", role: "designer", model: "test/model" },
					type: "assistant",
					blocks: [{ type: "text", text: "Visible answer" }],
				},
			},
			{ expanded: false },
			{ fg: (_color: string, value: string) => value },
		);
		expect(component?.render(100).join("\n")).toContain("Visible answer");
	});

	it("shows a live tail and persists complete child messages and tool results outside model context", () => {
		const values = fixture();
		values.presentation.handle(progress({ type: "agent_start" }));

		const partial = fauxAssistantMessage([fauxThinking("Reasoning live")], { stopReason: "pending" });
		values.presentation.handle(
			progress({
				type: "message_update",
				message: partial,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: " live",
					partial,
				},
			}),
		);
		expect(values.widget?.render(100).join("\n")).toContain("Reasoning live");
		expect(values.statuses.at(-1)).toContain("designer thinking");
		expect(values.renders).toBeGreaterThan(0);

		const message = fauxAssistantMessage(
			[
				fauxThinking("Complete reasoning"),
				fauxText("Visible answer"),
				fauxToolCall("workspace_write", { path: "src/value.ts", content: "one\ntwo\n" }),
			],
			{ stopReason: "toolUse" },
		);
		values.presentation.handle(progress({ type: "message_end", message }));
		values.presentation.handle(
			progress({
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "workspace_write",
				args: { path: "src/value.ts", content: "one\ntwo\n" },
			}),
		);
		values.presentation.handle(
			progress({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "workspace_write",
				result: {
					content: [{ type: "text", text: "Wrote src/value.ts" }],
					details: { path: "src/value.ts" },
				},
				isError: false,
			}),
		);
		values.presentation.handle(progress({ type: "agent_end", messages: [], willRetry: false }));

		const outputEntries = values.entries
			.filter((entry) => entry.customType === deepWorkAgentEntryType)
			.map((entry) => entry.data as DeepWorkAgentEntry);
		expect(outputEntries.map((entry) => entry.type)).toEqual([
			"lifecycle",
			"assistant",
			"tool",
			"lifecycle",
		]);
		expect(outputEntries[1]).toMatchObject({
			type: "assistant",
			blocks: [
				{ type: "thinking", text: "Complete reasoning" },
				{ type: "text", text: "Visible answer" },
				{ type: "tool-call", name: "workspace_write", arguments: "" },
			],
		});
		expect(outputEntries[2]).toMatchObject({
			type: "tool",
			arguments: "src/value.ts (3 lines, 8 characters)",
			output: "Wrote src/value.ts",
			isError: false,
		});

		values.presentation.handle(progress({ type: "agent_start" }));
		expect(values.widget?.render(100).join("\n")).toContain("● designer · design candidate 1 · started");
		expect(values.statuses.at(-1)).toContain("designer started");

		values.presentation.clear();
		expect(values.widget).toBeUndefined();
		expect(values.statuses.at(-1)).toBeUndefined();
	});
});
