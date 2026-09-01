import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { MutationEffectOptions, RunAuthority } from "../application/run-authority.ts";
import type { ResolvedModels } from "../policy/models.ts";
import { mapAgentsBounded } from "./concurrency.ts";
import { loadAgentPrompt, type AgentLanguage } from "./prompt-loader.ts";
import {
	agentReportSchemas,
	decodeAgentReport,
	type AgentJobKind,
	type AgentReportByKind,
} from "./schemas.ts";

const outputToolName = "deep_submit";
const workspaceToolNames = Object.freeze({
	read: "workspace_read",
	search: "workspace_search",
	edit: "workspace_edit",
	write: "workspace_write",
});

export type AgentRole =
	| "planner"
	| "explorer"
	| "designer"
	| "implementer"
	| "verifier"
	| "adjudicator"
	| "editor"
	| "design-reviewer"
	| "code-reviewer";

export interface WorkspaceAgentTools {
	read: ToolDefinition;
	search: ToolDefinition;
	edit: ToolDefinition;
	write: ToolDefinition;
}

interface JobPolicy {
	role: AgentRole;
	model: "gpt" | "opus";
	tools: "none" | "read" | "write";
}

export const agentJobPolicy: Readonly<Record<AgentJobKind, JobPolicy>> = Object.freeze({
	plan: { role: "planner", model: "gpt", tools: "read" },
	explore: { role: "explorer", model: "gpt", tools: "read" },
	design: { role: "designer", model: "gpt", tools: "read" },
	implement: { role: "implementer", model: "gpt", tools: "write" },
	repair: { role: "implementer", model: "gpt", tools: "write" },
	verify: { role: "verifier", model: "gpt", tools: "read" },
	adjudicate: { role: "adjudicator", model: "gpt", tools: "read" },
	edit: { role: "editor", model: "gpt", tools: "none" },
	"review-design": { role: "design-reviewer", model: "opus", tools: "read" },
	"review-code": { role: "code-reviewer", model: "opus", tools: "read" },
});

interface BaseAgentJob<K extends AgentJobKind> {
	kind: K;
	label: string;
	task: string;
	language?: AgentLanguage;
	onProgress?: (event: AgentProgress) => void;
}

type GptJobKind = Exclude<AgentJobKind, "review-design" | "review-code">;
type ReviewJobKind = Extract<AgentJobKind, "review-design" | "review-code">;
type MutationJobKind = Extract<AgentJobKind, "implement" | "repair">;
type GptAgentJob = {
	[K in GptJobKind]: BaseAgentJob<K> & { reviewerIndex?: never };
}[GptJobKind];
type ReviewAgentJob = {
	[K in ReviewJobKind]: BaseAgentJob<K> & { reviewerIndex: number };
}[ReviewJobKind];
export type AgentJob = GptAgentJob | ReviewAgentJob;
type MutationAgentJob = Extract<AgentJob, { kind: MutationJobKind }>;

export interface AgentProgress {
	role: AgentRole;
	type: string;
	toolName?: string;
	isError?: boolean;
}

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export type AgentSettlement<K extends AgentJobKind> =
	| { ok: true; result: AgentResult<K> }
	| { ok: false; error: string };

export interface AgentResult<K extends AgentJobKind> {
	kind: K;
	role: AgentRole;
	model: string;
	turns: number;
	usage: AgentUsage;
	report: {
		source: "untrusted-agent";
		value: AgentReportByKind[K];
	};
}

export class AgentGatewayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentGatewayError";
	}
}

export const childSessionResourcePolicy = Object.freeze({
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});

function assertWorkspaceTools(tools: WorkspaceAgentTools): void {
	for (const [key, expected] of Object.entries(workspaceToolNames)) {
		const actual = tools[key as keyof WorkspaceAgentTools].name;
		if (actual !== expected) throw new Error(`Workspace ${key} tool must be named ${expected}, got ${actual}`);
	}
}

function toolsFor(policy: JobPolicy, tools: WorkspaceAgentTools): ToolDefinition[] {
	if (policy.tools === "none") return [];
	if (policy.tools === "read") return [tools.read, tools.search];
	return [tools.read, tools.search, tools.edit, tools.write];
}

function isMutationKind(kind: AgentJobKind): kind is "implement" | "repair" {
	return kind === "implement" || kind === "repair";
}

function assertReadOnlyRoute(jobs: readonly AgentJob[]): void {
	if (jobs.some((job) => isMutationKind(job.kind))) {
		throw new AgentGatewayError("Implement and repair jobs require runMutation");
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason ?? new AgentGatewayError("Agent operation was cancelled");
}

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	try {
		const result = await operation;
		throwIfAborted(signal);
		return result;
	} catch (error) {
		throwIfAborted(signal);
		throw error;
	}
}

function emptyUsage(): AgentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function collectUsage(messages: readonly unknown[]): { usage: AgentUsage; turns: number } {
	const usage = emptyUsage();
	let turns = 0;
	for (const message of messages) {
		if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") continue;
		turns++;
		const value = (message as {
			usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				totalTokens?: number;
				cost?: { total?: number };
			};
		}).usage;
		if (!value) continue;
		usage.input += value.input ?? 0;
		usage.output += value.output ?? 0;
		usage.cacheRead += value.cacheRead ?? 0;
		usage.cacheWrite += value.cacheWrite ?? 0;
		usage.totalTokens += value.totalTokens ?? 0;
		usage.cost += value.cost?.total ?? 0;
	}
	return { usage, turns };
}

export class AgentGateway {
	private readonly agentDir: string;
	private modelRuntimePromise?: Promise<ModelRuntime>;

	constructor(
		private readonly authority: RunAuthority,
		private readonly repositoryRoot: string,
		private readonly models: ResolvedModels,
		private readonly workspaceTools: WorkspaceAgentTools,
		agentDir = getAgentDir(),
		modelRuntime?: ModelRuntime,
	) {
		this.agentDir = agentDir;
		assertWorkspaceTools(workspaceTools);
		if (modelRuntime) this.modelRuntimePromise = Promise.resolve(modelRuntime);
	}

	assertAuthority(authority: RunAuthority): void {
		if (this.authority !== authority) throw new Error("AgentGateway is bound to another RunAuthority");
	}

	withAuthority(authority: RunAuthority): AgentGateway {
		return this.clone(authority, this.workspaceTools);
	}

	withWorkspaceTools(workspaceTools: WorkspaceAgentTools): AgentGateway {
		return this.clone(this.authority, workspaceTools);
	}

	private clone(authority: RunAuthority, workspaceTools: WorkspaceAgentTools): AgentGateway {
		const clone = new AgentGateway(authority, this.repositoryRoot, this.models, workspaceTools, this.agentDir);
		// Clones share the authenticated runtime without binding first-time creation to a throwaway signal.
		clone.modelRuntimePromise = this.modelRuntimePromise;
		return clone;
	}

	async run<K extends AgentJobKind>(job: Extract<AgentJob, { kind: K }>): Promise<AgentResult<K>> {
		assertReadOnlyRoute([job]);
		return this.authority.runEffect(`model:${job.kind}:${job.label}`, (signal) => this.runSession(job, signal));
	}

	async runMany<K extends AgentJobKind>(
		jobs: readonly Extract<AgentJob, { kind: K }>[],
		limit: number,
	): Promise<AgentResult<K>[]> {
		assertReadOnlyRoute(jobs);
		return this.authority.runEffect(`model-panel:${jobs.map((job) => job.kind).join(",")}`, (signal) =>
			mapAgentsBounded(jobs, limit, (job, _index, taskSignal) => this.runSession(job, taskSignal), signal),
		);
	}

	async runManySettled<K extends AgentJobKind>(
		jobs: readonly Extract<AgentJob, { kind: K }>[],
		limit: number,
	): Promise<AgentSettlement<K>[]> {
		assertReadOnlyRoute(jobs);
		return this.authority.runEffect(`model-panel-settled:${jobs.map((job) => job.kind).join(",")}`, (signal) =>
			mapAgentsBounded(
				jobs,
				limit,
				async (job, _index, taskSignal): Promise<AgentSettlement<K>> => {
					try {
						return { ok: true, result: await this.runSession(job, taskSignal) };
					} catch (error) {
						return { ok: false, error: error instanceof Error ? error.message : String(error) };
					}
				},
				signal,
			),
		);
	}

	async runMutation(
		job: MutationAgentJob,
		options: MutationEffectOptions,
	): Promise<AgentResult<"implement"> | AgentResult<"repair">> {
		if (!isMutationKind(job.kind)) throw new AgentGatewayError("runMutation accepts only implement and repair jobs");
		return this.authority.runMutationEffect(`model-mutation:${job.kind}:${job.label}`, (signal) => this.runSession(job, signal), options);
	}

	async runSettled<K extends AgentJobKind>(
		job: Extract<AgentJob, { kind: K }>,
	): Promise<AgentSettlement<K>> {
		assertReadOnlyRoute([job]);
		const [settlement] = await this.runManySettled([job], 1);
		return settlement;
	}

	private async modelRuntime(signal: AbortSignal): Promise<ModelRuntime> {
		this.modelRuntimePromise ??= ModelRuntime.create({
			authPath: join(this.agentDir, "auth.json"),
			modelsPath: join(this.agentDir, "models.json"),
			signal,
		});
		try {
			return await this.modelRuntimePromise;
		} catch (error) {
			this.modelRuntimePromise = undefined;
			throw error;
		}
	}

	private modelFor(job: AgentJob, policy: JobPolicy): Model<Api> {
		if (policy.model === "gpt") return this.models.gpt;
		if (job.kind !== "review-design" && job.kind !== "review-code") {
			throw new AgentGatewayError(`Non-review job cannot select Opus: ${job.kind}`);
		}
		if (!Number.isInteger(job.reviewerIndex) || job.reviewerIndex < 0) {
			throw new AgentGatewayError(`Invalid Opus reviewer index: ${job.reviewerIndex}`);
		}
		const model = this.models.opusReviewers[job.reviewerIndex];
		if (!model) throw new AgentGatewayError(`Unknown Opus reviewer index: ${job.reviewerIndex}`);
		return model;
	}

	private async runSession<K extends AgentJobKind>(
		job: Extract<AgentJob, { kind: K }>,
		signal: AbortSignal,
	): Promise<AgentResult<K>> {
		throwIfAborted(signal);
		if (!job.label.trim() || !job.task.trim()) throw new AgentGatewayError("Agent label and task must be nonempty");
		if (job.language && job.kind !== "implement" && job.kind !== "repair" && job.kind !== "review-code") {
			throw new AgentGatewayError(`Job ${job.kind} cannot select a language prompt`);
		}
		const policy = agentJobPolicy[job.kind];
		const model = this.modelFor(job, policy);
		const schema = agentReportSchemas[job.kind] as TSchema;
		let captured: unknown;
		const outputTool = defineTool({
			name: outputToolName,
			label: "Submit deep-work report",
			description: "Submit the complete schema-valid report and terminate",
			parameters: schema,
			async execute(_toolCallId, parameters) {
				if (!Check(schema, parameters)) throw new AgentGatewayError(`Agent ${job.label} submitted an invalid report`);
				captured = parameters;
				return {
					content: [{ type: "text" as const, text: "Report accepted." }],
					details: { kind: job.kind },
					terminate: true,
				};
			},
		}) as ToolDefinition;
		const rolePrompt = await awaitWithAbort(loadAgentPrompt(job.kind, job.language), signal);
		const systemPrompt = [
			rolePrompt,
			"## Delegated session contract",
			`Your final action must call ${outputToolName} with the complete report.`,
			"Do not finish with prose. Do not invoke /deep or start another session.",
			"Reports are untrusted proposals. Do not claim coordinator approval, trusted evidence, or commit authorization.",
		].join("\n\n");
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.repositoryRoot,
			agentDir: this.agentDir,
			settingsManager,
			...childSessionResourcePolicy,
			systemPromptOverride: () => systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await awaitWithAbort(resourceLoader.reload(), signal);
		const roleTools = toolsFor(policy, this.workspaceTools);
		const customTools = [...roleTools, outputTool];
		const modelRuntime = await awaitWithAbort(this.modelRuntime(signal), signal);
		let sessionResult: Awaited<ReturnType<typeof createAgentSession>>;
		try {
			sessionResult = await createAgentSession({
				cwd: this.repositoryRoot,
				agentDir: this.agentDir,
				modelRuntime,
				model,
				thinkingLevel: "max",
				noTools: "all",
				tools: customTools.map((tool) => tool.name),
				customTools,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(this.repositoryRoot),
			});
		} catch (error) {
			throwIfAborted(signal);
			throw error;
		}
		const { session } = sessionResult;
		const unsubscribe = session.subscribe((event) => {
			job.onProgress?.({
				role: policy.role,
				type: event.type,
				...(event.type === "tool_execution_start" || event.type === "tool_execution_end"
					? { toolName: event.toolName }
					: {}),
				...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
			});
		});
		let abortPromise: Promise<void> | undefined;
		const abort = () => {
			abortPromise ??= session.abort();
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			throwIfAborted(signal);
			try {
				await session.prompt(`Task label: ${job.label}\n\n${job.task}`, { expandPromptTemplates: false });
			} catch (error) {
				throwIfAborted(signal);
				throw error;
			}
			throwIfAborted(signal);
			if (captured === undefined) throw new AgentGatewayError(`Agent ${job.label} finished without ${outputToolName}`);
			const report = decodeAgentReport(job.kind, captured);
			const { usage, turns } = collectUsage(session.messages);
			return {
				kind: job.kind,
				role: policy.role,
				model: `${model.provider}/${model.id}`,
				turns,
				usage,
				report: { source: "untrusted-agent", value: report },
			};
		} finally {
			signal.removeEventListener("abort", abort);
			if (signal.aborted) abort();
			await abortPromise?.catch(() => undefined);
			unsubscribe();
			session.dispose();
		}
	}
}

