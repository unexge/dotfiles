import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentGateway, AgentResult, AgentSettlement, WorkspaceAgentTools } from "../src/agents/gateway.ts";
import { DesignApprover } from "../src/application/approve-design.ts";
import { WritePreflight } from "../src/application/begin-write.ts";
import { ImplementationAgent } from "../src/application/implementation-agent.ts";
import { QualifyAndCommit } from "../src/application/qualify-and-commit.ts";
import { RegressionAgent } from "../src/application/regression-agent.ts";
import { RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import { TrustedCommandCatalog } from "../src/gates/catalog.ts";
import { GateExecutor } from "../src/gates/executor.ts";
import { Normalizer } from "../src/gates/normalizer.ts";
import { BackendTreeService } from "../src/gates/tree-backend.ts";
import { GitTransactionService } from "../src/git/transaction.ts";
import { JjTransactionService } from "../src/jj/transaction.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import type { ResolvedModels } from "../src/policy/models.ts";
import { decodeMachinePolicy, decodeProjectPolicy } from "../src/policy/schemas.ts";
import { ReviewPanel } from "../src/review/panel.ts";
import { RunStore } from "../src/store/run-store.ts";
import { captureGitObservation } from "../src/vcs/git-backend.ts";
import { captureJjObservation } from "../src/vcs/jj-backend.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner, DetectedRepository } from "../src/vcs/types.ts";
import { WorkflowRuntime } from "../src/service/runtime.ts";
import { WorkspaceBoundary } from "../src/workspace/boundary.ts";
import { runFixWorkflow } from "../src/workflows/fix.ts";
import {
	createRepositoryFixture,
	detectJjAvailability,
	isolatedVcsEnvironment,
	type RepositoryFixtureKind,
} from "./helpers/repositories.ts";

const executeFile = promisify(execFile);
const temporary: string[] = [];
const jjAvailability = await detectJjAvailability();
const reviewerModel = "test/claude-opus-4-8";

function policy(redOutcome: "fail" | "pass" | "timeout" | "drift") {
	const pass = [process.execPath, "-e", "process.exit(0)"];
	const behavior =
		redOutcome === "timeout"
			? [process.execPath, "-e", "setTimeout(() => {}, 10_000)"]
			: redOutcome === "drift"
				? [process.execPath, "-e", "require('fs').writeFileSync('gate-drift.txt','drift\\n'); process.exit(1)"]
				: [
						process.execPath,
						"-e",
						"const fs=require('fs'); process.exit(fs.existsSync('feature.txt') && fs.readFileSync('feature.txt','utf8')==='fixed\\n' ? 0 : 1)",
					];
	return resolvePolicy(
		decodeMachinePolicy({
			schemaVersion: 2,
			models: {
				orchestrator: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
				reviewers: [{ provider: "test", id: "claude-opus-4-8", thinkingLevel: "max" }],
			},
			concurrency: 1,
			maxRepairRounds: 0,
			commandTimeoutMs: 10_000,
			minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: pass, timeoutMs: 2_000 }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: pass, timeoutMs: 2_000 }],
			observations: [{ id: "regression", claimKeys: ["bug.fixed"], argv: behavior, timeoutMs: redOutcome === "timeout" ? 1_000 : 2_000 }],
			verificationContracts: [],
			selectors: [{ id: "regression-path", language: "rust", observationId: "regression", valuePattern: ".+\\.rs" }],
		}),
		decodeProjectPolicy({
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
}

function designReport() {
	return {
		status: "ok" as const,
		summary: "fix design",
		citations: [],
		usage: "preserve regression",
		constraints: ["preserve behavior"],
		decisions: [{ decision: "feature state", rationale: "owns the regression" }],
		dataShape: "feature state",
		interfaces: ["feature"],
		modules: ["feature.txt"],
		invariants: ["regression passes"],
		alternatives: [],
		tradeoffs: [],
		verification: ["trusted regression"],
		openQuestions: [],
		testSelectors: [{ selectorId: "regression-path", value: "tests/behavior.rs" }],
	};
}

function reviewResult(kind: "review-design" | "review-code"): AgentResult<typeof kind> {
	return {
		kind,
		role: kind === "review-design" ? "design-reviewer" : "code-reviewer",
		model: reviewerModel,
		turns: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		report: { source: "untrusted-agent", value: { status: "ok", summary: "approved", citations: [], verdict: "approve", findings: [] } },
	};
}

class FixResumeRuntime extends WorkflowRuntime {
	protected override createGateway(
		authority: RunAuthority,
		_repository: DetectedRepository,
		_models: ResolvedModels,
		_tools: WorkspaceAgentTools,
	): AgentGateway {
		let mutationTools: WorkspaceAgentTools | undefined;
		return {
			assertAuthority(value: RunAuthority) {
				if (value !== authority) throw new Error("wrong authority");
			},
			run: async (job: { kind: string }) =>
				job.kind === "explore"
					? { report: { value: { status: "ok", summary: "investigated", citations: [], components: ["feature"], flow: ["missing"], constraints: [], unknowns: [] } } }
					: { report: { value: designReport() } },
			withWorkspaceTools(tools: WorkspaceAgentTools) {
				mutationTools = tools;
				return {
					runMutation: async (job: { label: string }) => {
						const regression = job.label.includes("regression");
						const path = regression ? "tests/behavior.rs" : "feature.txt";
						await mutationTools!.write.execute(
							"mutation",
							{ path, content: regression ? "#[test] fn regression() {}\n" : "fixed\n" },
							undefined,
							() => undefined,
							undefined as never,
						);
						return {
							report: {
								value: {
									status: "ok",
									summary: regression ? "regression" : "fixed",
									citations: [],
									changes: [{ path, detail: "changed" }],
									testSelectors: regression
										? [{ selectorId: "missing", value: "tests/.+\\.rs" }]
										: [{ selectorId: "regression-path", value: "tests/behavior.rs" }],
								},
							},
						};
					},
				};
			},
			runManySettled: async (jobs: Array<{ kind: "review-design" | "review-code" }>) =>
				jobs.map((job) => ({ ok: true, result: reviewResult(job.kind) })) as AgentSettlement<"review-design" | "review-code">[],
			runSettled: async () => ({ ok: false, error: "fallback" }),
		} as unknown as AgentGateway;
	}
}

async function runCase(kind: RepositoryFixtureKind, redOutcome: "fail" | "pass" | "timeout" | "drift" = "fail"): Promise<void> {
	const fixture = await createRepositoryFixture(kind);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-fix-integration-"));
	temporary.push(agentDir);
	try {
		if (redOutcome === "pass") {
			await fixture.write("feature.txt", "fixed\n");
			if (kind === "git") {
				await fixture.run("git", ["add", "feature.txt"]);
				await fixture.run("git", ["commit", "-m", "already fixed"]);
			} else {
				await fixture.run("jj", ["commit", "-m", "already fixed"]);
			}
		}
		if (kind !== "git") await fixture.run("jj", ["bookmark", "create", "main", "-r", "@-"]);
		const commands: Array<{ command: string; args: readonly string[] }> = [];
		const runner: CommandRunner = async (command, args, options) => {
			commands.push({ command, args });
			try {
				const result = await executeFile(command, [...args], {
					cwd: options.cwd,
					env: { ...isolatedVcsEnvironment(tmpdir()), ...options.env },
					signal: options.signal,
					timeout: options.timeoutMs,
					maxBuffer: 20 * 1024 * 1024,
				});
				return { code: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (error) {
				const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
				return {
					code: typeof failure.code === "number" ? failure.code : 1,
					stdout: failure.stdout ?? "",
					stderr: failure.stderr ?? failure.message,
					errorCode: typeof failure.code === "string" ? failure.code : undefined,
				};
			}
		};
		const repository = await detectRepository(fixture.root, runner);
		const resolved = policy(redOutcome);
		const store = new RunStore(agentDir);
		const initial = {
			schemaVersion: 1 as const,
			runId: randomUUID(),
			workflow: "fix" as const,
			repositoryId: repository.repositoryId,
			policyDigest: resolved.digest,
			goal: "fix bug",
			createdAt: "2026-08-25T00:00:00.000Z",
			updatedAt: "2026-08-25T00:00:00.000Z",
			lastEventRevision: 0,
			lifecycle: "Queued" as const,
		};
		const ref = await store.create(repository.kind, initial);
		const authority = await RunAuthority.start(
			{ store, leases: new PortableLeaseManager(agentDir), ref, repository, attemptId: attemptId(randomUUID()), phase: "fix", pollIntervalMs: 5 },
			{ ...initial, lastEventRevision: 1 },
			"2026-08-25T00:00:01.000Z",
		);
		const trees = new BackendTreeService(authority, repository, resolved.digest, runner, join(agentDir, "scratch"));
		let mutationTools: WorkspaceAgentTools | undefined;
		const agentTasks: Array<{ label: string; task: string }> = [];
		const gateway = {
			assertAuthority(value: RunAuthority) {
				if (value !== authority) throw new Error("wrong authority");
			},
			run: async (job: { kind: string; label: string; task: string }) => {
				agentTasks.push({ label: job.label, task: job.task });
				return job.kind === "explore"
					? { report: { value: { status: "ok", summary: "investigated", citations: [], components: ["feature"], flow: ["missing file fails"], constraints: [], unknowns: [] } } }
					: { report: { value: designReport() } };
			},
			withWorkspaceTools(tools: WorkspaceAgentTools) {
				mutationTools = tools;
				return {
					runMutation: async (job: { label: string; task: string }) => {
						agentTasks.push({ label: job.label, task: job.task });
						const regression = job.label.includes("regression");
						const path = regression ? "tests/behavior.rs" : "feature.txt";
						const content = regression ? "#[test] fn regression() {}\n" : "fixed\n";
						await mutationTools!.write.execute("mutation", { path, content }, undefined, () => undefined, undefined as never);
						return {
							report: {
								value: {
									status: "ok",
									summary: regression ? "regression" : "fixed",
									citations: [],
									changes: [{ path, detail: regression ? "added regression" : "fixed behavior" }],
									testSelectors: regression
										? [{ selectorId: "missing", value: "tests/.+\\.rs" }]
										: [{ selectorId: "regression-path", value: "tests/behavior.rs" }],
								},
							},
						};
					},
				};
			},
			runManySettled: async (jobs: Array<{ kind: "review-design" | "review-code" }>) =>
				jobs.map((job) => ({ ok: true, result: reviewResult(job.kind) })) as AgentSettlement<"review-design" | "review-code">[],
			runSettled: async () => ({ ok: false, error: "fallback" }),
		} as unknown as AgentGateway;
		const catalog = await TrustedCommandCatalog.build(resolved, repository.root);
		const panel = new ReviewPanel(gateway, store, ref, resolved);
		const gates = new GateExecutor(
			authority,
			store,
			ref,
			repository.kind,
			() => (repository.kind === "git" ? captureGitObservation(repository, resolved.digest, runner) : captureJjObservation(repository, resolved.digest, runner)),
		);
		const approver = new DesignApprover(panel, catalog, store, ref, async () => (await trees.captureObservation()).observation);
		const boundary = await WorkspaceBoundary.open(repository, runner);
		const regression = new RegressionAgent(authority, gateway, boundary, catalog, trees, gates, store, ref);
		const implementation = new ImplementationAgent(authority, gateway, boundary, trees, store, ref);
		const normalizer = new Normalizer(authority, resolved, trees);
		const backend =
			repository.kind === "git"
				? { kind: "git" as const, service: new GitTransactionService(authority, store, ref, repository, runner, join(agentDir, "git-transaction")) }
				: { kind: "jj" as const, service: new JjTransactionService(authority, store, ref, repository, runner, trees) };
		const qualifier = new QualifyAndCommit(resolved, catalog, normalizer, trees, gates, panel, gateway, store, ref, backend, null);
		const headBefore = repository.kind === "git" ? (await fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim() : undefined;
		const bookmarkBefore = repository.kind === "jj" ? (await fixture.run("jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id"])).stdout.trim() : undefined;
		commands.length = 0;
		const result = await runFixWorkflow({
			origin: userOriginFromRegisteredCommand("Fix the missing feature behavior"),
			policy: resolved,
			catalog,
			authority,
			gateway,
			trees,
			gates,
			boundary,
			preflight: new WritePreflight(authority, trees, repository, resolved, runner),
			regression,
			approver,
			implementation,
			qualifier,
			store,
			ref,
			repositoryKind: repository.kind,
			regressionCheckpointedAt: "2026-08-25T00:00:02.000Z",
			approvedAt: "2026-08-25T00:00:03.000Z",
			implementationCheckpointedAt: "2026-08-25T00:00:04.000Z",
			authorizedAt: "2026-08-25T00:00:05.000Z",
			completedAt: "2026-08-25T00:00:06.000Z",
		});
		const commandRoot = join(ref.directory, "artifacts", "commands");
		const records = await Promise.all(
			(await readdir(commandRoot)).map(async (executionId) =>
				JSON.parse(await readFile(join(commandRoot, executionId, "record.json"), "utf8")),
			),
		);
		if (redOutcome !== "fail") {
			expect(result).toMatchObject({ status: "Blocked", reason: expect.stringContaining("not a clean failure") });
			expect(await store.load(ref)).toMatchObject({ lifecycle: "Blocked" });
			expect(records).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						commandId: "regression",
						outcome: redOutcome === "pass" ? "passed" : redOutcome === "timeout" ? "timed_out" : "drifted",
					}),
				]),
			);
			if (repository.kind === "git") {
				expect((await fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
				expect((await fixture.run("git", ["status", "--porcelain"])).stdout).not.toBe("");
				expect(existsSync(join(fixture.root, "tests/behavior.rs"))).toBe(true);
				if (redOutcome !== "pass") expect(existsSync(join(fixture.root, "feature.txt"))).toBe(false);
			}
			return;
		}
		expect(result).toMatchObject({ status: "LocalCommitCreated", commitId: expect.stringMatching(/^[0-9a-f]{40,64}$/) });
		expect(await store.load(ref)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
		expect(existsSync(join(fixture.root, "tests/behavior.rs"))).toBe(true);
		expect(await readFile(join(fixture.root, "feature.txt"), "utf8")).toBe("fixed\n");
		expect(JSON.parse(await readFile(join(ref.directory, "artifacts/workflow/fix-context.json"), "utf8"))).toMatchObject({
			workflow: "fix",
			stage: "implemented",
			redEvidence: { observationId: "regression" },
			regressionCheckpoint: { phase: "regression", sequence: 1 },
			implementationCheckpoint: { phase: "implement", sequence: 2 },
		});
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ commandId: "regression", outcome: "failed" }),
				expect.objectContaining({ commandId: "regression", outcome: "passed" }),
			]),
		);
		const regressionTask = agentTasks.find((task) => task.label === "write regression only")?.task;
		expect(regressionTask).toContain("coordinator derives the trusted observation");
		expect(regressionTask).not.toContain('"selectorId"');
		const designTask = agentTasks.find((task) => task.label === "design fix")?.task;
		expect(designTask).toContain('"selectorId":"regression-path","value":"tests/behavior.rs"');
		if (repository.kind === "git") {
			expect((await fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).not.toBe(headBefore);
			expect((await fixture.run("git", ["status", "--porcelain"])).stdout).toBe("");
		} else {
			expect((await fixture.run("jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id"])).stdout.trim()).toBe(bookmarkBefore);
			expect((await fixture.run("jj", ["status"])).stdout).toContain("no changes");
		}
		expect(commands.some((entry) => entry.args.includes("push"))).toBe(false);
	} finally {
		await fixture.cleanup();
	}
}

async function runResumeCase(pauseStage: "red" | "implemented", tamperContext = false): Promise<void> {
	const fixture = await createRepositoryFixture("git");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-fix-resume-"));
	temporary.push(agentDir);
	try {
		const resolved = policy("fail");
		await mkdir(join(agentDir, "pi-deep-work"), { recursive: true });
		await writeFile(join(agentDir, "pi-deep-work", "config.json"), JSON.stringify(resolved.machine), "utf8");
		await mkdir(join(fixture.root, ".pi"), { recursive: true });
		await writeFile(join(fixture.root, ".pi", "pi-deep-work.json"), JSON.stringify(resolved.project), "utf8");
		await fixture.run("git", ["add", ".pi/pi-deep-work.json"]);
		await fixture.run("git", ["commit", "-m", "add project policy"]);
		const runner: CommandRunner = async (command, args, options) => {
			try {
				const result = await executeFile(command, [...args], {
					cwd: options.cwd,
					env: { ...isolatedVcsEnvironment(tmpdir()), ...options.env },
					signal: options.signal,
					timeout: options.timeoutMs,
					maxBuffer: 20 * 1024 * 1024,
				});
				return { code: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (error) {
				const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
				return {
					code: typeof failure.code === "number" ? failure.code : 1,
					stdout: failure.stdout ?? "",
					stderr: failure.stderr ?? failure.message,
					errorCode: typeof failure.code === "string" ? failure.code : undefined,
				};
			}
		};
		const runtime = new FixResumeRuntime(agentDir, runner, () => ({}) as ResolvedModels);
		const originalWrite = runtime.store.writeArtifact.bind(runtime.store);
		let pauseRequested = false;
		runtime.store.writeArtifact = async (...args) => {
			const result = await originalWrite(...args);
			if (!pauseRequested && args[1] === "workflow/fix-context.json") {
				const value = JSON.parse(Buffer.isBuffer(args[2]) ? args[2].toString("utf8") : args[2]);
				if (value.stage === pauseStage) {
					pauseRequested = true;
					await runtime.store.appendControl(args[0], "Pause", "2026-08-25T00:00:05.500Z");
				}
			}
			return result;
		};
		const ctx = {
			cwd: fixture.root,
			isProjectTrusted: () => true,
			modelRegistry: {} as never,
		} as unknown as ExtensionCommandContext;
		const paused = await runtime.start(
			{ workflow: "fix", origin: userOriginFromRegisteredCommand("Fix resumable behavior") },
			ctx,
		);
		expect(paused.state).toMatchObject({ lifecycle: "Paused" });
		if (paused.state.lifecycle !== "Paused") throw new Error("expected paused fix");
		const pausedAttempt = paused.state.lastAttemptId;
		if (tamperContext) {
			const path = "workflow/fix-context.json";
			const context = JSON.parse((await runtime.store.readArtifact(paused.ref, path)).toString("utf8"));
			context.regressionCheckpoint.controlRevision++;
			await runtime.store.writeArtifact(paused.ref, path, JSON.stringify(context));
			await expect(runtime.resume(paused.ref, userOriginFromRegisteredCommand("resume tampered fix"), ctx)).rejects.toThrow(
				"contradicts durable store",
			);
			expect(await runtime.store.load(paused.ref)).toMatchObject({ lifecycle: "Paused" });
			return;
		}
		const resumed = await runtime.resume(paused.ref, userOriginFromRegisteredCommand("resume fix"), ctx);
		expect(resumed.state).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
		if (resumed.state.lifecycle !== "Completed") throw new Error("expected completed fix");
		expect(resumed.state.lastAttemptId).not.toBe(pausedAttempt);
		expect((await fixture.run("git", ["status", "--porcelain"])).stdout).toBe("");
		expect(await readFile(join(fixture.root, "feature.txt"), "utf8")).toBe("fixed\n");
	} finally {
		await fixture.cleanup();
	}
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("fix integration", () => {
	it("proves red-to-green and creates one Git commit", async () => runCase("git"), 80_000);
	it("blocks when the regression passes before the fix", async () => runCase("git", "pass"), 80_000);
	it("blocks when the red observation times out", async () => runCase("git", "timeout"), 80_000);
	it("blocks when the red observation mutates the subject", async () => runCase("git", "drift"), 80_000);
	it("resumes design, implementation, and qualification from persisted red evidence", async () => runResumeCase("red"), 90_000);
	it("resumes qualification from persisted red and implementation contexts", async () => runResumeCase("implemented"), 90_000);
	it("rejects fix context that contradicts the immutable regression checkpoint", async () => runResumeCase("implemented", true), 90_000);
	const jjIt = jjAvailability.available ? it : it.skip;
	jjIt(`proves red-to-green and commits native jj (${jjAvailability.diagnostic})`, async () => runCase("jj-native"), 80_000);
	jjIt(`proves red-to-green and commits colocated jj (${jjAvailability.diagnostic})`, async () => runCase("jj-colocated"), 80_000);
});
