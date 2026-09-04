import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import { RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import type { AgentProgress } from "../src/agents/gateway.ts";
import { parseCommand, CommandParseError } from "../src/service/command.ts";
import { deepWorkAgentEntryType } from "../src/service/presentation.ts";
import { DeepWorkService } from "../src/service/service.ts";
import {
	WorkflowRuntime,
	type RecoveryResult,
	type RunResult,
	type StartHooks,
	type StartRequest,
} from "../src/service/runtime.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import { commandRunner } from "../src/vcs/runner.ts";
import { createRepositoryFixture } from "./helpers/repositories.ts";
import { decodeRunProjection, type QueuedRun } from "../src/store/schemas.ts";

const temporary: string[] = [];

function queued(runId: string, repositoryId = "a".repeat(64)): QueuedRun {
	return decodeRunProjection({
		schemaVersion: 1,
		runId,
		workflow: "how",
		repositoryId,
		policyDigest: "b".repeat(64),
		goal: "service",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued",
	}) as QueuedRun;
}

function context() {
	const notifications: string[] = [];
	return {
		notifications,
		ctx: {
			cwd: "/repo",
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: () => undefined,
				setWidget: () => undefined,
				theme: { fg: (_color: string, value: string) => value },
			},
		} as unknown as ExtensionCommandContext,
	};
}

class CapturingRuntime extends WorkflowRuntime {
	request?: StartRequest;
	result?: RunResult;

	override async start(request: StartRequest): Promise<RunResult> {
		this.request = request;
		if (!this.result) throw new Error("missing captured result");
		return this.result;
	}
}

class DeferredRuntime extends WorkflowRuntime {
	started?: string;
	progress?: AgentProgress;
	delayBeforeStart = false;
	private releaseDelay?: () => void;

	releaseStart(): void {
		this.releaseDelay?.();
	}

	override async recover(ref: import("../src/store/run-store.ts").RunRef): Promise<RecoveryResult> {
		return { ref, state: await this.store.load(ref), status: "None" };
	}

	override async start(request: StartRequest, _ctx: ExtensionCommandContext, hooks: StartHooks = {}): Promise<RunResult> {
		if (this.delayBeforeStart) await new Promise<void>((resolve) => (this.releaseDelay = resolve));
		const ref = await this.store.create("git", queued(randomUUID()));
		await this.store.writeImmutableArtifact(
			ref,
			"run/request.json",
			JSON.stringify({ schemaVersion: 1, workflow: request.workflow, goal: request.origin.goal }),
		);
		await this.store.writeImmutableArtifact(
			ref,
			"run/repository.json",
			JSON.stringify({
				schemaVersion: 1,
				kind: "git",
				root: "/repo",
				sharedRoot: "/repo/.git",
				commonDir: "/repo/.git",
				repositoryId: "a".repeat(64),
			}),
		);
		this.started = ref.runId;
		hooks.onStarted?.(ref);
		if (this.progress) hooks.onProgress?.(this.progress);
		for (let attempt = 0; attempt < 100; attempt++) {
			if ((await this.store.controls(ref)).revision > 0) return { ref, state: await this.store.load(ref) };
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("control was not admitted");
	}
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("command grammar", () => {
	it("parses workflow and control commands with strict aliases", () => {
		expect(parseCommand("how explain this")).toEqual({ kind: "start", workflow: "how", goal: "explain this" });
		expect(parseCommand("review --base main intent")).toEqual({
			kind: "start",
			workflow: "review",
			goal: "intent",
			base: "main",
		});
		expect(parseCommand("unslop prose here")).toEqual({
			kind: "start",
			workflow: "unslop",
			goal: "prose here",
			unslopText: "prose here",
		});
		expect(parseCommand("review --base intent")).toEqual({
			kind: "start",
			workflow: "review",
			goal: "Review current changes",
			base: "intent",
		});
		expect(parseCommand("recover 1234 available/1234")).toEqual({
			kind: "recover",
			runId: "1234",
			challenge: "available/1234",
		});
		expect(parseCommand("resolve 1234")).toEqual({ kind: "resolve", runId: "1234", accept: false });
		expect(parseCommand("resolve 1234 --accept")).toEqual({ kind: "resolve", runId: "1234", accept: true });
		expect(parseCommand("resolve --accept 1234")).toEqual({ kind: "resolve", runId: "1234", accept: true });
		expect(parseCommand("design --from abc123 keep existing storage")).toEqual({
			kind: "start",
			workflow: "design",
			goal: "keep existing storage",
			sourceDesignRunId: "abc123",
			designFeedback: "keep existing storage",
		});
		expect(parseCommand("build --design abc123")).toEqual({
			kind: "start",
			workflow: "build",
			goal: "Build approved design abc123",
			sourceDesignRunId: "abc123",
		});
		expect(parseCommand("build --design abc123 cap retries")).toEqual({
			kind: "start",
			workflow: "build",
			goal: "cap retries",
			sourceDesignRunId: "abc123",
			designFeedback: "cap retries",
		});
		expect(parseCommand("cancel")).toEqual({ kind: "cancel" });
		expect(parseCommand("init")).toEqual({ kind: "init", refresh: false });
		expect(parseCommand("init --refresh")).toEqual({ kind: "init", refresh: true });
	});

	it("rejects ambiguous or unsupported grammar", () => {
		for (const command of [
			"unknown",
			"init main",
			"build",
			"build --base main goal",
			"design --from abc123",
			"design --design abc123 feedback",
			"build --from abc123",
			"review --design abc123",
			"review --base",
			"review --base main --base other",
			"unslop --base main prose",
			"resume",
			"resolve",
			"resolve one two",
			"resolve one --accept --accept",
			"resolve one --unknown",
			"resolve --accept --unknown",
			"recover one",
			"recover one two three",
		]) {
			expect(() => parseCommand(command)).toThrow(CommandParseError);
		}
	});
});

describe("command service controls", () => {
	it("collects resolution feedback and starts a linked design workflow", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-command-resolve-"));
		temporary.push(agentDir);
		const runtime = new CapturingRuntime(agentDir);
		const repository = {
			kind: "git" as const,
			root: "/repo",
			sharedRoot: "/repo/.git",
			commonDir: "/repo/.git",
			repositoryId: "a".repeat(64),
		};
		const initial = decodeRunProjection({
			...queued(randomUUID()),
			workflow: "design",
			goal: "Design safe cleanup",
		}) as QueuedRun;
		const ref = await runtime.store.create("git", initial);
		await runtime.store.writeImmutableArtifact(ref, "run/request.json", JSON.stringify({
			schemaVersion: 1,
			workflow: "design",
			goal: initial.goal,
		}));
		await runtime.store.writeImmutableArtifact(ref, "run/repository.json", JSON.stringify({ schemaVersion: 1, ...repository }));
		const authority = await RunAuthority.start(
			{
				store: runtime.store,
				leases: runtime.leases,
				ref,
				repository,
				attemptId: attemptId(randomUUID()),
				phase: "design",
				pollIntervalMs: 5,
			},
			await runtime.store.load(ref) as QueuedRun,
			"2026-08-25T00:00:01.000Z",
		);
		const design = {
			status: "ok",
			summary: "cleanup",
			citations: [],
			usage: "/deep clean",
			constraints: [],
			decisions: [{ decision: "lease", rationale: "safe" }],
			dataShape: "plan",
			interfaces: [],
			modules: [],
			invariants: ["safe"],
			alternatives: [],
			tradeoffs: [],
			verification: ["test"],
			openQuestions: [],
			testSelectors: [],
		};
		await runtime.store.writeArtifact(ref, "outputs/design.json", JSON.stringify({
			schemaVersion: 1,
			proposedOutcome: "ChangesRequired",
			goal: initial.goal,
			design,
			findings: [{ id: "r1:lease", reviewerId: "opus", severity: "blocker", title: "Lease", detail: "Use the repository lease" }],
		}));
		await authority.complete("ChangesRequired", "outputs/design.json", "2026-08-25T00:00:02.000Z");
		runtime.result = { ref, state: await runtime.store.load(ref) };
		const service = new DeepWorkService({ sendMessage: () => undefined, appendEntry: () => undefined } as never, runtime);
		const editorCalls: Array<{ title: string; value: string }> = [];
		const confirmations: string[] = [];
		const ctx = {
			cwd: "/repo",
			hasUI: true,
			ui: {
				select: async () => "Answer one by one",
				editor: async (title: string, value: string) => {
					editorCalls.push({ title, value });
					return "Use the repository lease.\n\nDecision: Use the external repository lease.";
				},
				confirm: async (_title: string, value: string) => {
					confirmations.push(value);
					return true;
				},
				notify: () => undefined,
				setStatus: () => undefined,
				setWidget: () => undefined,
				theme: { fg: (_color: string, value: string) => value },
			},
		} as unknown as ExtensionCommandContext;
		await service.execute(
			{ kind: "resolve", runId: ref.runId.slice(0, 8), accept: false },
			userOriginFromRegisteredCommand(`/deep resolve ${ref.runId.slice(0, 8)}`),
			ctx,
		);
		expect(editorCalls).toEqual([{
			title: "Finding 1/1: Lease",
			value: "Use the repository lease\n\nDecision: <enter decision>",
		}]);
		expect(confirmations).toEqual([`Collected 1 decision for design run ${ref.runId.slice(0, 8)}.`]);
		expect(runtime.request).toMatchObject({
			workflow: "design",
			sourceDesignRunId: ref.runId,
			designFeedback: "## blocker: Lease\nUse the repository lease.\n\nDecision: Use the external repository lease.",
		});

		const noPromptCtx = {
			...ctx,
			hasUI: false,
			ui: {
				...ctx.ui,
				select: async () => { throw new Error("unexpected select"); },
				editor: async () => { throw new Error("unexpected editor"); },
				confirm: async () => { throw new Error("unexpected confirm"); },
			},
		} as unknown as ExtensionCommandContext;
		await service.execute(
			{ kind: "resolve", runId: ref.runId.slice(0, 8), accept: true },
			userOriginFromRegisteredCommand(`/deep resolve ${ref.runId.slice(0, 8)} --accept`),
			noPromptCtx,
		);
		expect(runtime.request).toMatchObject({
			workflow: "design",
			sourceDesignRunId: ref.runId,
			designFeedback: [
				"## blocker: Lease",
				"Use the repository lease",
				"Decision: Accepted as a known limitation. Proceed without addressing this finding.",
			].join("\n"),
		});
	});

	it("admits durable Cancel and renders only status metadata", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-command-service-"));
		temporary.push(agentDir);
		const runtime = new WorkflowRuntime(agentDir);
		const ref = await runtime.store.create("git", queued(randomUUID()));
		await runtime.store.writeImmutableArtifact(
			ref,
			"run/request.json",
			JSON.stringify({ schemaVersion: 1, workflow: "how", goal: "service" }),
		);
		await runtime.store.writeImmutableArtifact(
			ref,
			"run/repository.json",
			JSON.stringify({
				schemaVersion: 1,
				kind: "git",
				root: "/missing/repo",
				sharedRoot: "/missing/repo/.git",
				commonDir: "/missing/repo/.git",
				repositoryId: "a".repeat(64),
			}),
		);
		const sent: unknown[] = [];
		const service = new DeepWorkService({ sendMessage: (value: unknown) => sent.push(value), appendEntry: () => undefined } as never, runtime);
		const values = context();
		const origin = userOriginFromRegisteredCommand("control");
		await service.execute({ kind: "cancel", runId: ref.runId.slice(0, 8) }, origin, values.ctx);
		expect(await runtime.store.controls(ref)).toMatchObject({ revision: 1, requests: [{ kind: "Cancel" }] });
		const liveLease = await runtime.leases.acquire({
			scope: "repository",
			repositoryId: ref.repositoryId,
			runId: ref.runId,
			attemptId: randomUUID(),
		});
		await service.execute({ kind: "status", runId: ref.runId }, origin, values.ctx);
		expect(values.notifications.at(-1)).toContain("how  Queued  git");
		expect(values.notifications.at(-1)).toContain("repository-recovery-challenge: unavailable");
		await liveLease.release();
		expect(values.notifications.at(-1)).toContain("live-observation: unavailable");
		(values.ctx as { cwd: string }).cwd = agentDir;
		await service.execute({ kind: "status" }, origin, values.ctx);
		expect(values.notifications.at(-1)).toContain("pass an explicit run ID");
		expect(sent).toEqual([]);
	});

	it("propagates malformed metadata and unexpected cwd detection errors", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-command-detection-"));
		temporary.push(agentDir);
		const runtime = new WorkflowRuntime(agentDir);
		const service = new DeepWorkService({ sendMessage: () => undefined, appendEntry: () => undefined } as never, runtime);
		for (const cwd of [join(agentDir, "missing"), join(agentDir, "broken-jj")] as const) {
			if (cwd.endsWith("broken-jj")) await mkdir(join(cwd, ".jj"), { recursive: true });
			const values = context();
			(values.ctx as { cwd: string }).cwd = cwd;
			await expect(
				service.execute({ kind: "status" }, userOriginFromRegisteredCommand("status"), values.ctx),
			).rejects.toThrow(cwd.endsWith("broken-jj") ? "Installed jj lacks required " : "Cannot inspect repository path");
			expect(values.notifications).toEqual([]);
		}
	});

	it("requires the status challenge and audits recovery before execution", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-command-recovery-"));
		temporary.push(agentDir);
		const runtime = new DeferredRuntime(agentDir);
		const ref = await runtime.store.create("git", queued(randomUUID()));
		const service = new DeepWorkService({ sendMessage: () => undefined, appendEntry: () => undefined } as never, runtime);
		const values = context();
		await service.execute(
			{ kind: "recover", runId: ref.runId, challenge: `available/${ref.runId.slice(0, 8)}` },
			userOriginFromRegisteredCommand("recover"),
			values.ctx,
		);
		const recoveryFiles = await readdir(join(ref.directory, "artifacts/recovery"));
		expect(recoveryFiles.some((name) => name.startsWith("requested-"))).toBe(true);
		expect(recoveryFiles.some((name) => name.startsWith("completed-"))).toBe(true);
	});

	it("scopes default status to the repository detected from cwd", async () => {
		const firstFixture = await createRepositoryFixture("git");
		const secondFixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-command-scope-"));
		temporary.push(agentDir);
		try {
			const firstRepository = await detectRepository(firstFixture.root, commandRunner);
			const secondRepository = await detectRepository(secondFixture.root, commandRunner);
			const runtime = new WorkflowRuntime(agentDir);
			const first = await runtime.store.create("git", queued(randomUUID(), firstRepository.repositoryId));
			const second = await runtime.store.create("git", queued(randomUUID(), secondRepository.repositoryId));
			for (const [ref, repository] of [
				[first, firstRepository],
				[second, secondRepository],
			] as const) {
				await runtime.store.writeImmutableArtifact(
					ref,
					"run/request.json",
					JSON.stringify({ schemaVersion: 1, workflow: "how", goal: "service" }),
				);
				await runtime.store.writeImmutableArtifact(
					ref,
					"run/repository.json",
					JSON.stringify({ schemaVersion: 1, ...repository }),
				);
			}
			const service = new DeepWorkService({ sendMessage: () => undefined, appendEntry: () => undefined } as never, runtime);
			const values = context();
			(values.ctx as { cwd: string }).cwd = firstFixture.root;
			await service.execute({ kind: "status" }, userOriginFromRegisteredCommand("status"), values.ctx);
			expect(values.notifications.at(-1)).toContain(first.runId.slice(0, 8));
			expect(values.notifications.at(-1)).not.toContain(second.runId.slice(0, 8));
		} finally {
			await firstFixture.cleanup();
			await secondFixture.cleanup();
		}
	});

	it("bridges runtime progress into display-only transcript entries", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-command-progress-"));
		temporary.push(agentDir);
		const runtime = new DeferredRuntime(agentDir);
		runtime.progress = {
			kind: "plan",
			label: "frame request",
			role: "planner",
			model: "test/model",
			event: { type: "agent_start" },
		};
		const entries: Array<{ customType: string; data: unknown }> = [];
		const service = new DeepWorkService(
			{
				sendMessage: () => undefined,
				appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
			} as unknown as ExtensionAPI,
			runtime,
		);
		const values = context();
		const origin = userOriginFromRegisteredCommand("visible progress");
		const running = service.execute({ kind: "start", workflow: "how", goal: "visible progress" }, origin, values.ctx);
		while (!runtime.started) await new Promise((resolve) => setTimeout(resolve, 5));
		await service.execute({ kind: "cancel", runId: runtime.started }, origin, values.ctx);
		await running;

		expect(entries).toContainEqual({
			customType: deepWorkAgentEntryType,
			data: expect.objectContaining({
				type: "lifecycle",
				state: "started",
				job: expect.objectContaining({ label: "frame request", role: "planner" }),
			}),
		});
	});

	it("shutdown fences and pauses a start still waiting before onStarted", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-command-start-race-"));
		temporary.push(agentDir);
		const runtime = new DeferredRuntime(agentDir);
		runtime.delayBeforeStart = true;
		const service = new DeepWorkService({ sendMessage: () => undefined, appendEntry: () => undefined } as never, runtime);
		const values = context();
		const running = service.execute(
			{ kind: "start", workflow: "how", goal: "race" },
			userOriginFromRegisteredCommand("race"),
			values.ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const shutdown = service.shutdown();
		runtime.releaseStart();
		await shutdown;
		await running;
		const ref = await runtime.store.find(runtime.started!);
		expect(await runtime.store.controls(ref)).toMatchObject({ revision: 1, requests: [{ kind: "Pause" }] });
	});

	it("session shutdown durably requests Pause for every active run", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-command-shutdown-"));
		temporary.push(agentDir);
		const runtime = new DeferredRuntime(agentDir);
		const service = new DeepWorkService({ sendMessage: () => undefined, appendEntry: () => undefined } as unknown as ExtensionAPI, runtime);
		const values = context();
		const running = service.execute(
			{ kind: "start", workflow: "how", goal: "shutdown" },
			userOriginFromRegisteredCommand("shutdown"),
			values.ctx,
		);
		while (!runtime.started) await new Promise((resolve) => setTimeout(resolve, 5));
		await service.shutdown();
		await running;
		const ref = await runtime.store.find(runtime.started);
		expect(await runtime.store.controls(ref)).toMatchObject({ revision: 1, requests: [{ kind: "Pause" }] });
		await expect(
			service.execute(
				{ kind: "start", workflow: "how", goal: "too late" },
				userOriginFromRegisteredCommand("too late"),
				values.ctx,
			),
		).rejects.toThrow("shutting down");
	});
});
