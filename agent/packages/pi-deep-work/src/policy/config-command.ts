import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isRecommendedOrchestrator, isRecommendedReviewer } from "./models.ts";
import {
	decodeMachinePolicy,
	PolicyDecodeError,
	type MachinePolicy,
	type ModelSelection,
} from "./schemas.ts";

const HIGH_RIGOR_THINKING = ["max", "xhigh", "high", "medium", "low", "minimal", "off"] as const;
const WORKER_THINKING = ["high", "xhigh", "max", "medium", "low", "minimal", "off"] as const;

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function selectionKey(selection: Pick<ModelSelection, "provider" | "id">): string {
	return `${selection.provider}/${selection.id}`;
}

function label(model: Model<Api>): string {
	return `${modelKey(model)}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`;
}

function available(ctx: ExtensionCommandContext): Model<Api>[] {
	const scoped = ctx.scopedModels.map((entry) => entry.model);
	const values = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
	return [...new Map(values.map((model) => [modelKey(model), model])).values()].filter((model) =>
		ctx.modelRegistry.hasConfiguredAuth(model),
	);
}

function orderedModels(
	models: readonly Model<Api>[],
	current: ModelSelection | undefined,
	recommended: (model: Model<Api>) => boolean,
): Model<Api>[] {
	const currentKey = current ? selectionKey(current) : undefined;
	return [...models].sort((left, right) => {
		const leftPriority = modelKey(left) === currentKey ? 0 : recommended(left) ? 1 : 2;
		const rightPriority = modelKey(right) === currentKey ? 0 : recommended(right) ? 1 : 2;
		if (leftPriority !== rightPriority) return leftPriority - rightPriority;
		const leftLabel = label(left);
		const rightLabel = label(right);
		return leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1 : 0;
	});
}

async function selectModel(
	ctx: ExtensionCommandContext,
	title: string,
	models: readonly Model<Api>[],
	current: ModelSelection | undefined,
	recommended: (model: Model<Api>) => boolean,
): Promise<Model<Api> | undefined> {
	const ordered = orderedModels(models, current, recommended);
	const selected = await ctx.ui.select(title, ordered.map(label));
	return selected ? ordered.find((model) => label(model) === selected) : undefined;
}

function currentThinkingLevel(selection: ModelSelection | undefined, model: Model<Api>): ModelSelection["thinkingLevel"] | undefined {
	return selection && selectionKey(selection) === modelKey(model) ? selection.thinkingLevel : undefined;
}

async function selectThinkingLevel(
	ctx: ExtensionCommandContext,
	title: string,
	model: Model<Api>,
	current: ModelSelection["thinkingLevel"] | undefined,
	preference: readonly ModelSelection["thinkingLevel"][],
): Promise<ModelSelection["thinkingLevel"] | undefined> {
	const supported = getSupportedThinkingLevels(model);
	const ordered = [...new Set([...(current ? [current] : []), ...preference, ...supported])].filter((level) =>
		supported.includes(level),
	);
	const selected = await ctx.ui.select(title, ordered);
	return ordered.find((level) => level === selected);
}

function select(model: Model<Api>, thinkingLevel: ModelSelection["thinkingLevel"]): ModelSelection {
	return { provider: model.provider, id: model.id, thinkingLevel };
}

async function readExisting(path: string): Promise<MachinePolicy | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) {
			throw new Error(`Existing policy contains invalid JSON and will not be translated. Replace ${path} explicitly.`);
		}
		throw error;
	}
	try {
		return decodeMachinePolicy(value);
	} catch (error) {
		if (error instanceof PolicyDecodeError) {
			throw new Error(`Existing policy is not valid and will not be translated. Replace ${path} explicitly.`);
		}
		throw error;
	}
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error) => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}
}

export async function configurePolicy(ctx: ExtensionCommandContext, path: string): Promise<boolean> {
	if (!ctx.hasUI) throw new Error("/deep config requires interactive or RPC UI mode");
	const existing = await readExisting(path);
	const models = available(ctx);
	if (models.length === 0) throw new Error("No authenticated model is available");

	const orchestratorModel = await selectModel(
		ctx,
		"Orchestrator agent (GPT 5.6 Sol recommended)",
		models,
		existing?.models.orchestrator,
		isRecommendedOrchestrator,
	);
	if (!orchestratorModel) return false;
	const orchestratorThinking = await selectThinkingLevel(
		ctx,
		"Orchestrator thinking (max/xhigh recommended)",
		orchestratorModel,
		currentThinkingLevel(existing?.models.orchestrator, orchestratorModel),
		HIGH_RIGOR_THINKING,
	);
	if (!orchestratorThinking) return false;
	const orchestrator = select(orchestratorModel, orchestratorThinking);

	const reviewers: ModelSelection[] = [];
	let remaining = [...models];
	while (remaining.length > 0) {
		const current = existing?.models.reviewers[reviewers.length];
		const reviewerModel = await selectModel(
			ctx,
			reviewers.length === 0
				? "Review agent (Opus 5.0/4.8 recommended)"
				: "Add another review agent",
			remaining,
			current,
			isRecommendedReviewer,
		);
		if (!reviewerModel) return false;
		const reviewerThinking = await selectThinkingLevel(
			ctx,
			`Review agent ${reviewers.length + 1} thinking (max/xhigh recommended)`,
			reviewerModel,
			currentThinkingLevel(current, reviewerModel),
			HIGH_RIGOR_THINKING,
		);
		if (!reviewerThinking) return false;
		reviewers.push(select(reviewerModel, reviewerThinking));
		remaining = remaining.filter((model) => modelKey(model) !== modelKey(reviewerModel));
		if (remaining.length === 0 || !(await ctx.ui.confirm("Review panel", "Add another review agent?"))) break;
	}

	const workerCurrent = existing?.models.worker ?? orchestrator;
	const workerModel = await selectModel(
		ctx,
		"Work agent (reuse orchestrator by default, or choose a cheaper model)",
		models,
		workerCurrent,
		isRecommendedOrchestrator,
	);
	if (!workerModel) return false;
	const workerThinking = await selectThinkingLevel(
		ctx,
		"Work agent thinking (high recommended)",
		workerModel,
		currentThinkingLevel(existing?.models.worker, workerModel),
		WORKER_THINKING,
	);
	if (!workerThinking) return false;

	const policy = decodeMachinePolicy({
		schemaVersion: 2,
		models: {
			orchestrator,
			worker: select(workerModel, workerThinking),
			reviewers,
		},
		concurrency: existing?.concurrency ?? 4,
		maxRepairRounds: existing?.maxRepairRounds ?? 2,
		commandTimeoutMs: existing?.commandTimeoutMs ?? 20 * 60 * 1000,
		minimumQuickGates: existing?.minimumQuickGates ?? [
			{
				id: "rust-check",
				languages: ["rust"],
				argv: ["cargo", "check", "--workspace", "--all-targets", "--locked"],
				timeoutMs: 20 * 60 * 1000,
			},
		],
		minimumFullGates: existing?.minimumFullGates ?? [
			{
				id: "rust-test",
				languages: ["rust"],
				argv: ["cargo", "test", "--workspace", "--locked"],
				timeoutMs: 20 * 60 * 1000,
			},
		],
		observations: existing?.observations ?? [],
		verificationContracts: existing?.verificationContracts ?? [],
		selectors: existing?.selectors ?? [],
	});
	await writeAtomic(path, policy);
	return true;
}
