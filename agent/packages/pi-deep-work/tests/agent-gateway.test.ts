import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineTool, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ControlAcceptedError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import {
	AgentGateway,
	AgentGatewayError,
	agentJobPolicy,
	type AgentProgress,
	type WorkspaceAgentTools,
} from "../src/agents/gateway.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import type { ResolvedModels } from "../src/policy/models.ts";
import { RunStore } from "../src/store/run-store.ts";
import { decodeRunProjection, type QueuedRun } from "../src/store/schemas.ts";
import type { GitRepository } from "../src/vcs/types.ts";

const temporary: string[] = [];

function tool(name: string): ToolDefinition {
	return defineTool({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			return { content: [{ type: "text" as const, text: name }], details: {} };
		},
	}) as ToolDefinition;
}

function workspaceTools(): WorkspaceAgentTools {
	return {
		read: tool("workspace_read"),
		search: tool("workspace_search"),
		edit: tool("workspace_edit"),
		write: tool("workspace_write"),
	};
}

function authority(signal?: AbortSignal): RunAuthority {
	return {
		runEffect: async <T>(_name: string, effect: (effectSignal: AbortSignal) => Promise<T>) =>
			effect(signal ?? new AbortController().signal),
		runMutationEffect: async <T>(_name: string, effect: (effectSignal: AbortSignal) => Promise<T>) =>
			effect(signal ?? new AbortController().signal),
	} as unknown as RunAuthority;
}

const planReport = {
	status: "ok",
	summary: "planned",
	citations: [],
	interpretation: "Do the work",
	successCriteria: ["It works"],
	steps: ["Inspect"],
};

const implementationReport = {
	status: "ok",
	summary: "implemented",
	citations: [],
	changes: [{ path: "src/value.ts", detail: "updated" }],
	testSelectors: [{ selectorId: "ts.test", value: "tests/value.test.ts" }],
};

const reviewReport = {
	status: "ok",
	summary: "clean",
	citations: [],
	verdict: "approve",
	findings: [],
};

async function fixture(options: { tokensPerSecond?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-gateway-"));
	temporary.push(root);
	const faux = fauxProvider({
		provider: `test-agent-${temporary.length}`,
		tokensPerSecond: options.tokensPerSecond,
		models: [
			{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", reasoning: true },
			{ id: "fast-worker", name: "Fast Worker", reasoning: true },
			{ id: "claude-opus-4.8", name: "Claude Opus 4.8", reasoning: true },
		],
	});
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
	runtime.registerNativeProvider(faux.provider);
	const orchestrator = runtime.getModel(faux.provider.id, "gpt-5.6-sol");
	const worker = runtime.getModel(faux.provider.id, "fast-worker");
	const reviewer = runtime.getModel(faux.provider.id, "claude-opus-4.8");
	if (!orchestrator || !worker || !reviewer) throw new Error("Faux models were not registered");
	orchestrator.thinkingLevelMap = { xhigh: "xhigh", max: "max" };
	reviewer.thinkingLevelMap = { xhigh: "xhigh", max: "max" };
	const models: ResolvedModels = {
		orchestrator: { model: orchestrator, thinkingLevel: "max" },
		worker: { model: worker, thinkingLevel: "high" },
		reviewers: [{ model: reviewer, thinkingLevel: "xhigh" }],
	};
	return { root, faux, runtime, models };
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AgentGateway", () => {
	it("keeps role, model, and tool authority in one closed table", () => {
		expect(Object.entries(agentJobPolicy).filter(([, policy]) => policy.tools === "write").map(([kind]) => kind)).toEqual([
			"implement",
			"repair",
		]);
		expect(Object.entries(agentJobPolicy).filter(([, policy]) => policy.model === "worker").map(([kind]) => kind)).toEqual([
			"explore",
			"implement",
			"repair",
		]);
		expect(Object.entries(agentJobPolicy).filter(([, policy]) => policy.model === "reviewer").map(([kind]) => kind)).toEqual([
			"review-design",
			"review-code",
		]);
		expect(agentJobPolicy.edit).toMatchObject({ model: "orchestrator", tools: "none" });
	});

	it("rebinds a fresh gateway to a resumed RunAuthority", async () => {
		const values = await fixture();
		const first = authority();
		const second = authority();
		const gateway = new AgentGateway(first, values.root, values.models, workspaceTools(), values.root, values.runtime);
		expect(() => gateway.assertAuthority(first)).not.toThrow();
		const rebound = gateway.withAuthority(second);
		expect(() => rebound.assertAuthority(second)).not.toThrow();
		expect(() => rebound.assertAuthority(first)).toThrow("another RunAuthority");
	});

	it("uses the configured orchestrator and thinking level while isolating child resources", async () => {
		const values = await fixture();
		await writeFile(join(values.root, "AGENTS.md"), "SECRET PROJECT CONTEXT", "utf8");
		await mkdir(join(values.root, ".pi", "skills", "secret"), { recursive: true });
		await mkdir(join(values.root, ".pi", "prompts"), { recursive: true });
		await writeFile(join(values.root, ".pi", "skills", "secret", "SKILL.md"), "SECRET PROJECT SKILL", "utf8");
		await writeFile(join(values.root, ".pi", "prompts", "secret.md"), "SECRET PROJECT PROMPT", "utf8");
		values.faux.setResponses([
			(context: Context, options: SimpleStreamOptions | undefined, _state: unknown, model: Model<string>) => {
				expect(model.id).toBe("gpt-5.6-sol");
				expect(options?.reasoning).toBe("max");
				expect(context.systemPrompt).toContain("# Planner");
				expect(context.systemPrompt).not.toContain("SECRET PROJECT CONTEXT");
				expect(context.systemPrompt).not.toContain("SECRET PROJECT SKILL");
				expect(context.systemPrompt).not.toContain("SECRET PROJECT PROMPT");
				expect(context.tools?.map((entry) => entry.name).sort()).toEqual(
					["deep_submit", "workspace_read", "workspace_search"].sort(),
				);
				return fauxAssistantMessage(fauxToolCall("deep_submit", planReport), { stopReason: "toolUse" });
			},
		]);
		const gateway = new AgentGateway(
			authority(),
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
		);
		const result = await gateway.run({ kind: "plan", label: "frame", task: "Plan it" });
		expect(result).toMatchObject({
			kind: "plan",
			role: "planner",
			model: `${values.faux.provider.id}/gpt-5.6-sol`,
			report: { source: "untrusted-agent", value: { summary: "planned" } },
		});
	});

	it("streams labeled child-session output and tool progress to the coordinator", async () => {
		const values = await fixture();
		values.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("Inspect the repository"),
					fauxText("Reading the relevant file."),
					fauxToolCall("workspace_read", {}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("deep_submit", planReport), { stopReason: "toolUse" }),
		]);
		const progress: AgentProgress[] = [];
		let rejectedPresentationUpdate = false;
		const gateway = new AgentGateway(
			authority(),
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
			(event) => {
				progress.push(event);
				if (!rejectedPresentationUpdate && event.event.type === "message_update") {
					rejectedPresentationUpdate = true;
					throw new Error("presentation failed");
				}
			},
		);
		await gateway.run({ kind: "plan", label: "frame request", task: "Plan it" });

		expect(rejectedPresentationUpdate).toBe(true);
		expect(progress.every((event) => event.label === "frame request" && event.role === "planner")).toBe(true);
		expect(progress.every((event) => event.model === `${values.faux.provider.id}/gpt-5.6-sol`)).toBe(true);
		expect(
			progress.some(
				({ event }) =>
					event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta",
			),
		).toBe(true);
		expect(
			progress.some(
				({ event }) => event.type === "message_end" && event.message.role === "assistant",
			),
		).toBe(true);
		expect(
			progress.some(
				({ event }) => event.type === "tool_execution_end" && event.toolName === "workspace_read" && !event.isError,
			),
		).toBe(true);
	});

	it("gives only implement and repair jobs mutation tools", async () => {
		const values = await fixture();
		values.faux.setResponses([
			(context, options, _state, model) => {
				expect(model.id).toBe("fast-worker");
				expect(options?.reasoning).toBe("high");
				expect(context.tools?.map((entry) => entry.name).sort()).toEqual(
					["deep_submit", "workspace_edit", "workspace_read", "workspace_search", "workspace_write"].sort(),
				);
				return fauxAssistantMessage(fauxToolCall("deep_submit", implementationReport), { stopReason: "toolUse" });
			},
		]);
		const gateway = new AgentGateway(
			authority(),
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
		);
		await expect(gateway.run({ kind: "implement", label: "wrong route", task: "Implement" })).rejects.toThrow(
			"require runMutation",
		);
		await expect(gateway.runSettled({ kind: "repair", label: "wrong settled route", task: "Repair" })).rejects.toThrow(
			"require runMutation",
		);
		expect(
			(
				await gateway.runMutation(
					{ kind: "implement", label: "edit", task: "Implement" },
					{ requiresManualInspection: () => false, reason: "unused" },
				)
			).role,
		).toBe("implementer");
		await expect(
			gateway.runMutation(
				{ kind: "plan", label: "wrong", task: "Plan" } as never,
				{ requiresManualInspection: () => false, reason: "unused" },
			),
		).rejects.toThrow("only implement and repair");
	});

	it("selects the configured reviewer and keeps it read-only", async () => {
		const values = await fixture();
		values.faux.setResponses([
			(context, options, _state, model) => {
				expect(model.id).toBe("claude-opus-4.8");
				expect(options?.reasoning).toBe("xhigh");
				expect(context.tools?.map((entry) => entry.name).sort()).toEqual(
					["deep_submit", "workspace_read", "workspace_search"].sort(),
				);
				return fauxAssistantMessage(fauxToolCall("deep_submit", reviewReport), { stopReason: "toolUse" });
			},
		]);
		const gateway = new AgentGateway(
			authority(),
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
		);
		const result = await gateway.run({
			kind: "review-code",
			label: "review",
			task: "Review",
			reviewerIndex: 0,
		});
		expect(result.role).toBe("code-reviewer");
		await expect(
			gateway.run({ kind: "review-design", label: "bad reviewer", task: "Review", reviewerIndex: 1 }),
		).rejects.toThrow("Unknown reviewer index");
	});

	it("gives editor sessions no repository tools", async () => {
		const values = await fixture();
		values.faux.setResponses([
			(context, options, _state, model) => {
				expect(model.id).toBe("gpt-5.6-sol");
				expect(options?.reasoning).toBe("max");
				expect(context.tools?.map((entry) => entry.name)).toEqual(["deep_submit"]);
				return fauxAssistantMessage(
					fauxToolCall("deep_submit", {
						status: "ok",
						summary: "edited",
						citations: [],
						output: "Result",
					}),
					{ stopReason: "toolUse" },
				);
			},
		]);
		const gateway = new AgentGateway(
			authority(),
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
		);
		expect((await gateway.run({ kind: "edit", label: "edit", task: "Edit" })).role).toBe("editor");
	});

	it("rejects language prompt selection outside fixed language-aware jobs", async () => {
		const values = await fixture();
		const gateway = new AgentGateway(
			authority(),
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
		);
		await expect(gateway.run({ kind: "plan", label: "bad language", task: "Plan", language: "rust" })).rejects.toThrow(
			"cannot select a language prompt",
		);
	});

	it("runs a bounded panel inside one authority effect", async () => {
		const values = await fixture();
		values.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("deep_submit", { ...planReport, summary: "first" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("deep_submit", { ...planReport, summary: "second" }), { stopReason: "toolUse" }),
		]);
		const effects: string[] = [];
		const panelAuthority = {
			runEffect: async <T>(name: string, effect: (signal: AbortSignal) => Promise<T>) => {
				effects.push(name);
				return effect(new AbortController().signal);
			},
		} as RunAuthority;
		const gateway = new AgentGateway(
			panelAuthority,
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
		);
		const results = await gateway.runMany(
			[
				{ kind: "plan", label: "one", task: "Plan one" },
				{ kind: "plan", label: "two", task: "Plan two" },
			],
			2,
		);
		expect(results.map((result) => result.kind)).toEqual(["plan", "plan"]);
		expect(results.every((result) => result.report.source === "untrusted-agent")).toBe(true);
		expect(effects).toEqual(["model-panel:plan,plan"]);
	});

	it("settles every panel branch without turning one malformed agent into an authority failure", async () => {
		const values = await fixture();
		values.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("deep_submit", planReport), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("malformed prose"), { stopReason: "stop" }),
		]);
		const gateway = new AgentGateway(
			authority(),
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
		);
		const results = await gateway.runManySettled(
			[
				{ kind: "plan", label: "one", task: "Plan one" },
				{ kind: "plan", label: "two", task: "Plan two" },
			],
			2,
		);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toHaveLength(1);
	});

	it("requires a terminating schema-valid report", async () => {
		const values = await fixture();
		values.faux.setResponses([fauxAssistantMessage(fauxText("prose only"), { stopReason: "stop" })]);
		const gateway = new AgentGateway(
			authority(),
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
		);
		await expect(gateway.run({ kind: "plan", label: "bad", task: "Return prose" })).rejects.toBeInstanceOf(
			AgentGatewayError,
		);
	});

	it("aborts and disposes a child session when authority cancels", async () => {
		const values = await fixture({ tokensPerSecond: 100 });
		values.faux.setResponses([
			fauxAssistantMessage([fauxText("x".repeat(200)), fauxToolCall("deep_submit", planReport)], {
				stopReason: "toolUse",
			}),
		]);
		const controller = new AbortController();
		const gateway = new AgentGateway(
			authority(controller.signal),
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
		);
		const running = gateway.run({ kind: "plan", label: "cancel", task: "Wait" });
		const rejected = expect(running).rejects.toThrow("cancelled");
		while (values.faux.state.callCount === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort(new Error("operator cancelled"));
		await rejected;
	});

	it("preserves pause semantics through a real settled panel wait", async () => {
		const values = await fixture({ tokensPerSecond: 100 });
		values.faux.setResponses([
			fauxAssistantMessage([fauxText("x".repeat(200)), fauxToolCall("deep_submit", planReport)], {
				stopReason: "toolUse",
			}),
		]);
		const store = new RunStore(values.root);
		const leases = new PortableLeaseManager(values.root);
		const initial = decodeRunProjection({
			schemaVersion: 1,
			runId: randomUUID(),
			workflow: "how",
			repositoryId: "a".repeat(64),
			policyDigest: "b".repeat(64),
			goal: "pause model",
			createdAt: "2026-08-25T00:00:00.000Z",
			updatedAt: "2026-08-25T00:00:00.000Z",
			lastEventRevision: 0,
			lifecycle: "Queued",
		}) as QueuedRun;
		const ref = await store.create("git", initial);
		const repository: GitRepository = {
			kind: "git",
			root: values.root,
			sharedRoot: join(values.root, ".git"),
			commonDir: join(values.root, ".git"),
			repositoryId: initial.repositoryId,
		};
		const runAuthority = await RunAuthority.start(
			{
				store,
				leases,
				ref,
				repository,
				attemptId: attemptId(randomUUID()),
				phase: "explore",
				pollIntervalMs: 5,
			},
			{ ...initial, lastEventRevision: 1 },
			"2026-08-25T00:00:01.000Z",
		);
		const gateway = new AgentGateway(
			runAuthority,
			values.root,
			values.models,
			workspaceTools(),
			values.root,
			values.runtime,
		);
		const running = gateway.runManySettled([{ kind: "plan", label: "pause", task: "Wait" }], 1);
		const rejected = expect(running).rejects.toBeInstanceOf(ControlAcceptedError);
		while (values.faux.state.callCount === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		await runAuthority.requestControl("Pause", "2026-08-25T00:00:02.000Z");
		await rejected;
		const paused = await store.load(ref);
		expect(paused).toMatchObject({ lifecycle: "Paused" });
		if (paused.lifecycle !== "Paused") throw new Error("expected paused run");
		values.faux.setResponses([
			fauxAssistantMessage([fauxText("y".repeat(200)), fauxToolCall("deep_submit", planReport)], {
				stopReason: "toolUse",
			}),
		]);
		const resumed = await RunAuthority.resume(
			{
				store,
				leases,
				ref,
				repository,
				attemptId: attemptId(randomUUID()),
				phase: "explore",
				pollIntervalMs: 5,
			},
			paused,
			"2026-08-25T00:00:03.000Z",
		);
		const rebound = gateway.withAuthority(resumed);
		const priorCalls = values.faux.state.callCount;
		const resumedRun = rebound.runManySettled([{ kind: "plan", label: "cancel", task: "Wait again" }], 1);
		const cancelled = expect(resumedRun).rejects.toBeInstanceOf(ControlAcceptedError);
		while (values.faux.state.callCount === priorCalls) await new Promise((resolve) => setTimeout(resolve, 5));
		await resumed.requestControl("Cancel", "2026-08-25T00:00:04.000Z");
		await cancelled;
		expect(await store.load(ref)).toMatchObject({ lifecycle: "Cancelled" });
	}, 15_000);

	it("rejects workspace tool substitution at construction", async () => {
		const values = await fixture();
		const tools = workspaceTools();
		tools.write = tool("bash");
		expect(() => new AgentGateway(authority(), values.root, values.models, tools, values.root, values.runtime)).toThrow(
			"workspace_write",
		);
	});
});
