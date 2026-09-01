import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configurePolicy } from "../src/policy/config-command.ts";
import { isGpt56Sol, isOpus48Or50, resolveModels } from "../src/policy/models.ts";
import { loadResolvedPolicy } from "../src/policy/resolver.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";

const temporary: string[] = [];

const gpt = {
	provider: "bedrock",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	reasoning: true,
	thinkingLevelMap: { max: "max" },
} as unknown as Model<Api>;
const opus = {
	provider: "bedrock",
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	reasoning: true,
	thinkingLevelMap: { max: "max" },
} as unknown as Model<Api>;

function registry(
	models: Model<Api>[],
	authenticated: boolean | ((model: Model<Api>) => boolean) = true,
): ModelRegistry {
	return {
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		hasConfiguredAuth: (model: Model<Api>) =>
			typeof authenticated === "function" ? authenticated(model) : authenticated,
		getAvailable: () => models,
	} as unknown as ModelRegistry;
}

function machineValue() {
	return {
		schemaVersion: 1,
		models: {
			gpt: { provider: gpt.provider, id: gpt.id, thinkingLevel: "max" },
			opusReviewers: [{ provider: opus.provider, id: opus.id, thinkingLevel: "max" }],
		},
		concurrency: 4,
		maxRepairRounds: 2,
		commandTimeoutMs: 600_000,
		minimumQuickGates: [
			{ id: "rust-check", languages: ["rust"], argv: ["cargo", "check", "--locked"], timeoutMs: 600_000 },
		],
		minimumFullGates: [
			{ id: "rust-test", languages: ["rust"], argv: ["cargo", "test", "--locked"], timeoutMs: 600_000 },
		],
		observations: [],
		verificationContracts: [],
		selectors: [],
	};
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("policy file loading", () => {
	it("loads trusted project policy and ignores it when untrusted", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-policy-"));
		temporary.push(root);
		const machinePath = join(root, "machine.json");
		const projectDir = join(root, ".pi");
		const projectPath = join(projectDir, "pi-deep-work.json");
		await mkdir(projectDir);
		await writeFile(machinePath, JSON.stringify(machineValue()));
		await writeFile(
			projectPath,
			JSON.stringify({
				schemaVersion: 1,
				mainline: "main",
				quickGates: [],
				fullGates: [],
				normalizers: [],
				observations: [],
				verificationContracts: [],
				selectors: [],
				languageScopes: [],
			}),
		);
		const trusted = await loadResolvedPolicy(
			{ isProjectTrusted: () => true },
			{ machine: machinePath, canonicalRoot: root },
		);
		const untrusted = await loadResolvedPolicy(
			{ isProjectTrusted: () => false },
			{ machine: machinePath, canonicalRoot: root },
		);
		expect(trusted.mainline).toBe("main");
		expect(untrusted.mainline).toBeUndefined();
	});

	it("rejects a project policy symlink escaping the canonical root", async () => {
		const container = await mkdtemp(join(tmpdir(), "pi-deep-policy-symlink-"));
		temporary.push(container);
		const root = join(container, "repo");
		const outside = join(container, "outside");
		await mkdir(root);
		await mkdir(outside);
		await writeFile(join(container, "machine.json"), JSON.stringify(machineValue()));
		await writeFile(join(outside, "pi-deep-work.json"), JSON.stringify({}));
		await symlink(outside, join(root, ".pi"));
		await expect(
			loadResolvedPolicy(
				{ isProjectTrusted: () => true },
				{ machine: join(container, "machine.json"), canonicalRoot: root },
			),
		).rejects.toThrow("escapes canonical repository root");
	});

	it("rejects missing and non-machine policy without translating it", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-policy-invalid-"));
		temporary.push(root);
		const machinePath = join(root, "machine.json");
		await expect(
			loadResolvedPolicy({ isProjectTrusted: () => false }, { machine: machinePath, canonicalRoot: root }),
		).rejects.toThrow("machine policy is missing");
		await writeFile(machinePath, JSON.stringify({ models: {} }));
		await expect(
			loadResolvedPolicy({ isProjectTrusted: () => false }, { machine: machinePath, canonicalRoot: root }),
		).rejects.toThrow("Invalid policy");
	});
});

describe("exact model binding", () => {
	it("resolves authenticated GPT and every Opus reviewer without fallback", () => {
		const resolved = resolveModels(registry([gpt, opus]), decodeMachinePolicy(machineValue()));
		expect(resolved.gpt).toBe(gpt);
		expect(resolved.opusReviewers).toEqual([opus]);
	});

	it("rejects unavailable, unauthenticated, duplicate, or wrong-family models", () => {
		expect(() => resolveModels(registry([opus]), decodeMachinePolicy(machineValue()))).toThrow("not found");
		expect(() => resolveModels(registry([gpt, opus], false), decodeMachinePolicy(machineValue()))).toThrow(
			"not authenticated",
		);
		const duplicate = decodeMachinePolicy(machineValue());
		duplicate.models.opusReviewers.push(duplicate.models.opusReviewers[0]);
		expect(() => resolveModels(registry([gpt, opus]), duplicate)).toThrow("Duplicate Opus reviewer");
		const wrong = { ...opus, id: "claude-opus-5-1", name: "Claude Opus 5.1" } as Model<Api>;
		const wrongPolicy = decodeMachinePolicy({
			...machineValue(),
			models: {
				...machineValue().models,
				opusReviewers: [{ provider: wrong.provider, id: wrong.id, thinkingLevel: "max" }],
			},
		});
		expect(() => resolveModels(registry([gpt, wrong]), wrongPolicy)).toThrow("not Opus 4.8/5.0");
		const noMax = { ...gpt, thinkingLevelMap: { max: null } } as unknown as Model<Api>;
		expect(() => resolveModels(registry([noMax, opus]), decodeMachinePolicy(machineValue()))).toThrow(
			"does not support max thinking",
		);
		expect(isGpt56Sol({ id: "gpt-5.6-sol-preview" })).toBe(false);
		expect(isGpt56Sol({ id: "gpt-5.6-sol-20250805" })).toBe(false);
		expect(isOpus48Or50({ id: "global.anthropic.claude-opus-4-8" })).toBe(true);
		expect(isOpus48Or50({ id: "claude-opus-5" })).toBe(true);
		expect(isOpus48Or50({ id: "claude-opus-4-8-preview" })).toBe(false);
		expect(isOpus48Or50({ id: "claude-opus-4-8-20250805" })).toBe(false);
	});
});

describe("config writer", () => {
	it("writes a new strict policy and preserves valid settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-config-"));
		temporary.push(root);
		await mkdir(root, { recursive: true });
		const path = join(root, "config.json");
		const select = vi.fn().mockResolvedValueOnce(`${gpt.provider}/${gpt.id} (${gpt.name})`).mockResolvedValueOnce(
			`${opus.provider}/${opus.id} (${opus.name})`,
		);
		const ctx = {
			hasUI: true,
			scopedModels: [],
			modelRegistry: registry([gpt, opus]),
			ui: { select },
		} as unknown as ExtensionCommandContext;
		expect(await configurePolicy(ctx, path)).toBe(true);
		const first = decodeMachinePolicy(JSON.parse(await readFile(path, "utf8")));
		expect(first.models.gpt.thinkingLevel).toBe("max");
		expect(first.minimumQuickGates).toHaveLength(1);
		expect(first.minimumFullGates).toHaveLength(1);
		first.concurrency = 7;
		await writeFile(path, JSON.stringify(first));
		select.mockResolvedValueOnce(`${gpt.provider}/${gpt.id} (${gpt.name})`).mockResolvedValueOnce(
			`${opus.provider}/${opus.id} (${opus.name})`,
		);
		expect(await configurePolicy(ctx, path)).toBe(true);
		expect(decodeMachinePolicy(JSON.parse(await readFile(path, "utf8"))).concurrency).toBe(7);
	});

	it("excludes unauthenticated or non-max scoped models", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-config-models-"));
		temporary.push(root);
		const unauthenticated = { ...gpt, provider: "unauth" } as Model<Api>;
		const noMax = { ...gpt, provider: "no-max", thinkingLevelMap: { max: null } } as unknown as Model<Api>;
		const ctx = {
			hasUI: true,
			scopedModels: [{ model: unauthenticated }, { model: noMax }],
			modelRegistry: registry([unauthenticated, noMax], (model) => model.provider !== "unauth"),
			ui: { select: vi.fn() },
		} as unknown as ExtensionCommandContext;
		await expect(configurePolicy(ctx, join(root, "config.json"))).rejects.toThrow(
			"No authenticated GPT 5.6 Sol model is available",
		);
	});

	it("refuses to translate an existing invalid-schema config", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-config-invalid-"));
		temporary.push(root);
		const path = join(root, "config.json");
		await writeFile(path, JSON.stringify({ models: machineValue().models }));
		const ctx = { hasUI: true, scopedModels: [], modelRegistry: registry([gpt, opus]), ui: { select: vi.fn() } } as unknown as ExtensionCommandContext;
		await expect(configurePolicy(ctx, path)).rejects.toThrow("will not be translated");
	});
});
