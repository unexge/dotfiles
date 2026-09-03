import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configurePolicy } from "../src/policy/config-command.ts";
import {
	isRecommendedOrchestrator,
	isRecommendedReviewer,
	resolveModels,
} from "../src/policy/models.ts";
import { initializeProjectPolicy } from "../src/policy/project-init.ts";
import { loadResolvedPolicy } from "../src/policy/resolver.ts";
import { decodeMachinePolicy, decodeProjectPolicy } from "../src/policy/schemas.ts";
import { commandRunner } from "../src/vcs/runner.ts";
import { createRepositoryFixture } from "./helpers/repositories.ts";

const temporary: string[] = [];

const orchestrator = {
	provider: "bedrock",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", max: "max" },
} as unknown as Model<Api>;
const reviewer = {
	provider: "bedrock",
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", max: "max" },
} as unknown as Model<Api>;
const worker = {
	provider: "bedrock",
	id: "fast-worker",
	name: "Fast Worker",
	reasoning: true,
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
		schemaVersion: 2,
		models: {
			orchestrator: { provider: orchestrator.provider, id: orchestrator.id, thinkingLevel: "max" },
			worker: { provider: worker.provider, id: worker.id, thinkingLevel: "high" },
			reviewers: [{ provider: reviewer.provider, id: reviewer.id, thinkingLevel: "xhigh" }],
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

function configUi() {
	const select = vi.fn(async (title: string, choices: string[]) => {
		if (title === "Orchestrator thinking (max/xhigh recommended)") {
			expect(choices.slice(0, 2)).toEqual(["max", "xhigh"]);
			return "max";
		}
		if (title.startsWith("Review agent ") && title.includes(" thinking ")) {
			expect(choices.slice(0, 2).sort()).toEqual(["max", "xhigh"]);
			return "xhigh";
		}
		if (title === "Work agent thinking (high recommended)") {
			expect(choices[0]).toBe("high");
			return "high";
		}
		if (title.startsWith("Orchestrator agent")) {
			expect(choices[0]).toContain(orchestrator.id);
			return choices[0];
		}
		if (title.startsWith("Review agent") || title === "Add another review agent") {
			expect(choices[0]).toContain(reviewer.id);
			return choices[0];
		}
		if (title.startsWith("Work agent")) {
			expect(choices[0]).toContain(orchestrator.id);
			return choices[0];
		}
		return undefined;
	});
	return { select, confirm: vi.fn().mockResolvedValue(false) };
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

describe("project policy initializer", () => {
	it("creates a strict starter policy at the repository root using main by default", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			const nested = join(fixture.root, "nested");
			await mkdir(nested);
			const input = vi.fn().mockResolvedValue("");
			const ctx = {
				hasUI: true,
				cwd: nested,
				isProjectTrusted: () => true,
				ui: { input },
			} as unknown as ExtensionCommandContext;

			const result = await initializeProjectPolicy(ctx, commandRunner);
			const path = join(fixture.root, ".pi", "pi-deep-work.json");
			expect(result).toEqual({ status: "created", path, mainline: "main" });
			expect(input).toHaveBeenCalledWith("Mainline branch or bookmark", "main");
			expect(decodeProjectPolicy(JSON.parse(await readFile(path, "utf8")))).toEqual({
				schemaVersion: 1,
				mainline: "main",
				quickGates: [],
				fullGates: [],
				normalizers: [],
				observations: [],
				verificationContracts: [],
				selectors: [],
				languageScopes: [],
			});
		} finally {
			await fixture.cleanup();
		}
	});

	it("reports an existing valid policy without prompting or overwriting it", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			const directory = join(fixture.root, ".pi");
			const path = join(directory, "pi-deep-work.json");
			await mkdir(directory);
			const existing = {
				schemaVersion: 1,
				mainline: "trunk",
				quickGates: [],
				fullGates: [],
				normalizers: [],
				observations: [],
				verificationContracts: [],
				selectors: [],
				languageScopes: [],
			};
			await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`);
			const input = vi.fn();
			const ctx = {
				hasUI: true,
				cwd: fixture.root,
				isProjectTrusted: () => true,
				ui: { input },
			} as unknown as ExtensionCommandContext;

			expect(await initializeProjectPolicy(ctx, commandRunner)).toEqual({
				status: "existing",
				path,
				mainline: "trunk",
			});
			expect(input).not.toHaveBeenCalled();
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual(existing);
		} finally {
			await fixture.cleanup();
		}
	});

	it("requires interactive UI and project trust before inspecting the repository", async () => {
		const base = {
			cwd: "/missing",
			isProjectTrusted: () => true,
			ui: { input: vi.fn() },
		};
		await expect(
			initializeProjectPolicy({ ...base, hasUI: false } as unknown as ExtensionCommandContext, commandRunner),
		).rejects.toThrow("/deep init requires interactive or RPC UI mode");
		await expect(
			initializeProjectPolicy({ ...base, hasUI: true, isProjectTrusted: () => false } as unknown as ExtensionCommandContext, commandRunner),
		).rejects.toThrow("/deep init requires a trusted project");
	});
});

describe("model binding", () => {
	it("resolves each role with its configured thinking level", () => {
		const resolved = resolveModels(registry([orchestrator, worker, reviewer]), decodeMachinePolicy(machineValue()));
		expect(resolved.orchestrator).toEqual({ model: orchestrator, thinkingLevel: "max" });
		expect(resolved.worker).toEqual({ model: worker, thinkingLevel: "high" });
		expect(resolved.reviewers).toEqual([{ model: reviewer, thinkingLevel: "xhigh" }]);
	});

	it("rejects unavailable, unauthenticated, duplicate, or unsupported selections", () => {
		expect(() => resolveModels(registry([worker, reviewer]), decodeMachinePolicy(machineValue()))).toThrow("not found");
		expect(() =>
			resolveModels(registry([orchestrator, worker, reviewer], false), decodeMachinePolicy(machineValue())),
		).toThrow("not authenticated");
		const duplicate = decodeMachinePolicy(machineValue());
		duplicate.models.reviewers.push(duplicate.models.reviewers[0]);
		expect(() => resolveModels(registry([orchestrator, worker, reviewer]), duplicate)).toThrow("Duplicate reviewer");
		const unsupported = decodeMachinePolicy({
			...machineValue(),
			models: {
				...machineValue().models,
				worker: { provider: worker.provider, id: worker.id, thinkingLevel: "max" },
			},
		});
		expect(() => resolveModels(registry([orchestrator, worker, reviewer]), unsupported)).toThrow(
			"does not support max thinking",
		);
	});

	it("treats model families as recommendations rather than requirements", () => {
		const generic = {
			provider: "local",
			id: "qwen-coder",
			name: "Qwen Coder",
			reasoning: true,
		} as unknown as Model<Api>;
		const policy = decodeMachinePolicy({
			...machineValue(),
			models: {
				orchestrator: { provider: generic.provider, id: generic.id, thinkingLevel: "high" },
				worker: { provider: generic.provider, id: generic.id, thinkingLevel: "low" },
				reviewers: [{ provider: generic.provider, id: generic.id, thinkingLevel: "off" }],
			},
		});
		expect(() => resolveModels(registry([generic]), policy)).not.toThrow();
		expect(isRecommendedOrchestrator(orchestrator)).toBe(true);
		expect(isRecommendedReviewer(reviewer)).toBe(true);
		expect(isRecommendedOrchestrator(generic)).toBe(false);
		expect(isRecommendedReviewer({ id: "claude-opus-5-1" })).toBe(false);
	});

	it("reads legacy role names without changing their selections", () => {
		const current = machineValue();
		const legacy = decodeMachinePolicy({
			...current,
			schemaVersion: 1,
			models: {
				gpt: { provider: orchestrator.provider, id: orchestrator.id, thinkingLevel: "max" },
				opusReviewers: [{ provider: reviewer.provider, id: reviewer.id, thinkingLevel: "max" }],
			},
		});
		expect(legacy).toMatchObject({
			schemaVersion: 2,
			models: {
				orchestrator: { provider: orchestrator.provider, id: orchestrator.id, thinkingLevel: "max" },
				reviewers: [{ provider: reviewer.provider, id: reviewer.id, thinkingLevel: "max" }],
			},
		});
		expect(legacy.models.worker).toBeUndefined();
	});
});

describe("config writer", () => {
	it("writes role-based choices and preserves valid settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-config-"));
		temporary.push(root);
		const path = join(root, "config.json");
		const ui = configUi();
		const ctx = {
			hasUI: true,
			scopedModels: [],
			modelRegistry: registry([worker, reviewer, orchestrator]),
			ui,
		} as unknown as ExtensionCommandContext;
		expect(await configurePolicy(ctx, path)).toBe(true);
		const first = decodeMachinePolicy(JSON.parse(await readFile(path, "utf8")));
		expect(first.schemaVersion).toBe(2);
		expect(first.models).toEqual({
			orchestrator: { provider: orchestrator.provider, id: orchestrator.id, thinkingLevel: "max" },
			worker: { provider: orchestrator.provider, id: orchestrator.id, thinkingLevel: "high" },
			reviewers: [{ provider: reviewer.provider, id: reviewer.id, thinkingLevel: "xhigh" }],
		});
		expect(first.minimumQuickGates).toHaveLength(1);
		expect(first.minimumFullGates).toHaveLength(1);
		first.concurrency = 7;
		await writeFile(path, JSON.stringify(first));
		expect(await configurePolicy(ctx, path)).toBe(true);
		expect(decodeMachinePolicy(JSON.parse(await readFile(path, "utf8"))).concurrency).toBe(7);
	});

	it("allows one generic authenticated model for every role", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-config-generic-"));
		temporary.push(root);
		const generic = {
			provider: "local",
			id: "small-model",
			name: "Small Model",
			reasoning: false,
		} as unknown as Model<Api>;
		const ui = {
			select: vi.fn(async (title: string, choices: string[]) =>
				title.includes("thinking") ? "off" : choices[0],
			),
			confirm: vi.fn().mockResolvedValue(false),
		};
		const path = join(root, "config.json");
		const ctx = {
			hasUI: true,
			scopedModels: [{ model: generic }],
			modelRegistry: registry([generic]),
			ui,
		} as unknown as ExtensionCommandContext;
		expect(await configurePolicy(ctx, path)).toBe(true);
		const configured = decodeMachinePolicy(JSON.parse(await readFile(path, "utf8")));
		expect(configured.models.orchestrator.thinkingLevel).toBe("off");
		expect(configured.models.worker?.id).toBe(generic.id);
		expect(configured.models.reviewers).toHaveLength(1);
	});

	it("excludes unauthenticated scoped models", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-config-models-"));
		temporary.push(root);
		const unauthenticated = { ...orchestrator, provider: "unauth" } as Model<Api>;
		const ctx = {
			hasUI: true,
			scopedModels: [{ model: unauthenticated }],
			modelRegistry: registry([unauthenticated], false),
			ui: { select: vi.fn() },
		} as unknown as ExtensionCommandContext;
		await expect(configurePolicy(ctx, join(root, "config.json"))).rejects.toThrow(
			"No authenticated model is available",
		);
	});

	it("refuses to translate an existing invalid-schema config", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-config-invalid-"));
		temporary.push(root);
		const path = join(root, "config.json");
		await writeFile(path, JSON.stringify({ models: machineValue().models }));
		const ctx = {
			hasUI: true,
			scopedModels: [],
			modelRegistry: registry([orchestrator, worker, reviewer]),
			ui: { select: vi.fn() },
		} as unknown as ExtensionCommandContext;
		await expect(configurePolicy(ctx, path)).rejects.toThrow("will not be translated");
	});
});
