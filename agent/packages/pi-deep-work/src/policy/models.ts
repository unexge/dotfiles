import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { MachinePolicy } from "./schemas.ts";

export interface ResolvedModels {
	gpt: Model<Api>;
	opusReviewers: readonly Model<Api>[];
}

function normalizedModelId(model: Pick<Model<Api>, "id">): string {
	return model.id.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isGpt56Sol(model: Pick<Model<Api>, "id">): boolean {
	return /(?:^| )gpt 5 6 sol$/.test(normalizedModelId(model));
}

export function isOpus48Or50(model: Pick<Model<Api>, "id">): boolean {
	const id = normalizedModelId(model);
	return /(?:^| )(?:claude )?opus 4 8$/.test(id) || /(?:^| )(?:claude )?opus 5(?: 0)?$/.test(id);
}

function resolveOne(
	registry: ModelRegistry,
	selection: MachinePolicy["models"]["gpt"],
	role: "gpt" | "opus",
): Model<Api> {
	const model = registry.find(selection.provider, selection.id);
	if (!model) throw new Error(`Configured ${role} model not found: ${selection.provider}/${selection.id}`);
	if (!registry.hasConfiguredAuth(model)) {
		throw new Error(`Configured ${role} model is not authenticated: ${selection.provider}/${selection.id}`);
	}
	if (!getSupportedThinkingLevels(model).includes("max")) {
		throw new Error(`Configured ${role} model does not support max thinking: ${selection.provider}/${selection.id}`);
	}
	if (role === "gpt" && !isGpt56Sol(model)) throw new Error(`Configured GPT model is not GPT 5.6 Sol: ${model.id}`);
	if (role === "opus" && !isOpus48Or50(model)) throw new Error(`Configured reviewer is not Opus 4.8/5.0: ${model.id}`);
	return model;
}

export function resolveModels(registry: ModelRegistry, policy: MachinePolicy): ResolvedModels {
	const gpt = resolveOne(registry, policy.models.gpt, "gpt");
	const seen = new Set<string>();
	const opusReviewers = policy.models.opusReviewers.map((selection) => {
		const key = `${selection.provider}/${selection.id}`;
		if (seen.has(key)) throw new Error(`Duplicate Opus reviewer: ${key}`);
		seen.add(key);
		return resolveOne(registry, selection, "opus");
	});
	return Object.freeze({ gpt, opusReviewers: Object.freeze(opusReviewers) });
}
