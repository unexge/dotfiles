import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isGpt56Sol, isOpus48Or50 } from "./models.ts";
import { decodeMachinePolicy, PolicyDecodeError, type MachinePolicy } from "./schemas.ts";

function label(model: Model<Api>): string {
	return `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`;
}

function available(ctx: ExtensionCommandContext): Model<Api>[] {
	const scoped = ctx.scopedModels.map((entry) => entry.model);
	const values = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
	return [...new Map(values.map((model) => [`${model.provider}/${model.id}`, model])).values()];
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
	const selectable = (model: Model<Api>) =>
		ctx.modelRegistry.hasConfiguredAuth(model) && getSupportedThinkingLevels(model).includes("max");
	const gptModels = models.filter((model) => isGpt56Sol(model) && selectable(model));
	const opusModels = models.filter((model) => isOpus48Or50(model) && selectable(model));
	if (gptModels.length === 0) throw new Error("No authenticated GPT 5.6 Sol model is available");
	if (opusModels.length === 0) throw new Error("No authenticated Opus 4.8/5.0 model is available");

	const selectedGptLabel = await ctx.ui.select("GPT 5.6 Sol at max", gptModels.map(label));
	if (!selectedGptLabel) return false;
	const gpt = gptModels.find((model) => label(model) === selectedGptLabel);
	if (!gpt) throw new Error("Selected GPT model disappeared from the catalog");

	const reviewers: Model<Api>[] = [];
	let remaining = [...opusModels];
	while (remaining.length > 0) {
		const selectedOpusLabel = await ctx.ui.select(
			reviewers.length === 0 ? "Opus reviewer at max" : "Add another Opus reviewer",
			remaining.map(label),
		);
		if (!selectedOpusLabel) {
			if (reviewers.length === 0) return false;
			break;
		}
		const opus = remaining.find((model) => label(model) === selectedOpusLabel);
		if (!opus) throw new Error("Selected Opus model disappeared from the catalog");
		reviewers.push(opus);
		remaining = remaining.filter((model) => model !== opus);
		if (remaining.length === 0 || !(await ctx.ui.confirm("Review panel", "Add another Opus reviewer?"))) break;
	}

	const policy = decodeMachinePolicy({
		schemaVersion: 1,
		models: {
			gpt: { provider: gpt.provider, id: gpt.id, thinkingLevel: "max" },
			opusReviewers: reviewers.map((opus) => ({ provider: opus.provider, id: opus.id, thinkingLevel: "max" as const })),
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
