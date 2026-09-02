import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { MachinePolicy, ModelSelection } from "./schemas.ts";

export interface ResolvedAgentModel {
	model: Model<Api>;
	thinkingLevel: ModelSelection["thinkingLevel"];
}

export interface ResolvedModels {
	orchestrator: ResolvedAgentModel;
	worker: ResolvedAgentModel;
	reviewers: readonly ResolvedAgentModel[];
}

function normalized(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function modelIdentities(model: { id: string; name?: string }): string[] {
	return [model.id, model.name].filter((value): value is string => Boolean(value)).map(normalized);
}

export function isRecommendedOrchestrator(model: { id: string; name?: string }): boolean {
	return modelIdentities(model).some((value) => /(?:^| )gpt 5 6 sol(?=$| [a-z])/.test(value));
}

export function isRecommendedReviewer(model: { id: string; name?: string }): boolean {
	return modelIdentities(model).some((value) =>
		/(?:^| )(?:claude )?opus (?:4 8|5(?: 0)?)(?=$| [a-z])/.test(value),
	);
}

function resolveOne(registry: ModelRegistry, selection: ModelSelection, role: string): ResolvedAgentModel {
	const identity = `${selection.provider}/${selection.id}`;
	const model = registry.find(selection.provider, selection.id);
	if (!model) throw new Error(`Configured ${role} model not found: ${identity}`);
	if (!registry.hasConfiguredAuth(model)) throw new Error(`Configured ${role} model is not authenticated: ${identity}`);
	if (!getSupportedThinkingLevels(model).includes(selection.thinkingLevel)) {
		throw new Error(`Configured ${role} model does not support ${selection.thinkingLevel} thinking: ${identity}`);
	}
	return Object.freeze({ model, thinkingLevel: selection.thinkingLevel });
}

export function resolveModels(registry: ModelRegistry, policy: MachinePolicy): ResolvedModels {
	const orchestrator = resolveOne(registry, policy.models.orchestrator, "orchestrator");
	const worker = resolveOne(registry, policy.models.worker ?? policy.models.orchestrator, "work agent");
	const seen = new Set<string>();
	const reviewers = policy.models.reviewers.map((selection) => {
		const key = `${selection.provider}/${selection.id}`;
		if (seen.has(key)) throw new Error(`Duplicate reviewer: ${key}`);
		seen.add(key);
		return resolveOne(registry, selection, "reviewer");
	});
	return Object.freeze({ orchestrator, worker, reviewers: Object.freeze(reviewers) });
}
