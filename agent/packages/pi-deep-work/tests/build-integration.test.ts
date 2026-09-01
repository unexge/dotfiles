import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { runBuildWorkflow } from "../src/workflows/build.ts";
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

function policy(behaviorPass = true) {
	const command = [process.execPath, "-e", "process.exit(0)"];
	const behaviorCommand = [process.execPath, "-e", `process.exit(${behaviorPass ? 0 : 1})`];
	return resolvePolicy(
		decodeMachinePolicy({
			schemaVersion: 1,
			models: {
				gpt: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
				opusReviewers: [{ provider: "test", id: "claude-opus-4-8", thinkingLevel: "max" }],
			},
			concurrency: 1,
			maxRepairRounds: 0,
			commandTimeoutMs: 10_000,
			minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: command, timeoutMs: 2_000 }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: command, timeoutMs: 2_000 }],
			observations: [{ id: "behavior", claimKeys: ["behavior.ok"], argv: behaviorCommand, timeoutMs: 2_000 }],
			verificationContracts: [],
			selectors: [{ id: "rust-path", language: "rust", observationId: "behavior", valuePattern: ".+\\.rs" }],
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
		summary: "design",
		citations: [],
		usage: "caller usage",
		dataShape: "one feature module",
		interfaces: ["feature()"],
		modules: ["feature.rs"],
		invariants: ["returns true"],
		tradeoffs: [],
		verification: ["trusted behavior command"],
		testSelectors: [{ selectorId: "rust-path", value: "tests/behavior.rs" }],
	};
}

function reviewResult(kind: "review-design" | "review-code"): AgentResult<typeof kind> {
	return {
		kind,
		role: kind === "review-design" ? "design-reviewer" : "code-reviewer",
		model: reviewerModel,
		turns: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		report: {
			source: "untrusted-agent",
			value: { status: "ok", summary: "approved", citations: [], verdict: "approve", findings: [] },
		},
	};
}

class BuildResumeRuntime extends WorkflowRuntime {
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
				job.kind === "plan"
					? {
							report: {
								value: {
									status: "ok",
									summary: "frame",
									citations: [],
									interpretation: "feature",
									successCriteria: ["works"],
									steps: ["implement"],
								},
							},
						}
					: { report: { value: designReport() } },
			withWorkspaceTools(tools: WorkspaceAgentTools) {
				mutationTools = tools;
				return {
					runMutation: async () => {
						await mutationTools!.write.execute(
							"implement",
							{ path: "feature.rs", content: "pub fn feature() -> bool { true }\n" },
							undefined,
							() => undefined,
							undefined as never,
						);
						return {
							report: {
								value: {
									status: "ok",
									summary: "implemented",
									citations: [],
									changes: [{ path: "feature.rs", detail: "added" }],
									testSelectors: [{ selectorId: "rust-path", value: "tests/behavior.rs" }],
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

async function runCase(kind: RepositoryFixtureKind, behaviorPass = true): Promise<void> {
	const fixture = await createRepositoryFixture(kind);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-build-integration-"));
	temporary.push(agentDir);
	try {
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
		const resolved = policy(behaviorPass);
		const store = new RunStore(agentDir);
		const initial = {
			schemaVersion: 1 as const,
			runId: randomUUID(),
			workflow: "build" as const,
			repositoryId: repository.repositoryId,
			policyDigest: resolved.digest,
			goal: "build feature",
			createdAt: "2026-08-25T00:00:00.000Z",
			updatedAt: "2026-08-25T00:00:00.000Z",
			lastEventRevision: 0,
			lifecycle: "Queued" as const,
		};
		const ref = await store.create(repository.kind, initial);
		const authority = await RunAuthority.start(
			{
				store,
				leases: new PortableLeaseManager(agentDir),
				ref,
				repository,
				attemptId: attemptId(randomUUID()),
				phase: "build",
				pollIntervalMs: 5,
			},
			{ ...initial, lastEventRevision: 1 },
			"2026-08-25T00:00:01.000Z",
		);
		const trees = new BackendTreeService(authority, repository, resolved.digest, runner, join(agentDir, "scratch"));
		let mutationTools: WorkspaceAgentTools | undefined;
		const gateway = {
			assertAuthority(value: RunAuthority) {
				if (value !== authority) throw new Error("wrong authority");
			},
			run: async (job: { kind: string }) =>
				job.kind === "plan"
					? {
							report: {
								value: {
									status: "ok",
									summary: "frame",
									citations: [],
									interpretation: "feature",
									successCriteria: ["works"],
									steps: ["implement"],
								},
							},
						}
					: { report: { value: designReport() } },
			withWorkspaceTools(tools: WorkspaceAgentTools) {
				mutationTools = tools;
				return {
					runMutation: async () => {
						await mutationTools!.write.execute(
							"implement",
							{ path: "feature.rs", content: "pub fn feature() -> bool { true }\n" },
							undefined,
							() => undefined,
							undefined as never,
						);
						return {
							report: {
								value: {
									status: "ok",
									summary: "implemented",
									citations: [],
									changes: [{ path: "feature.rs", detail: "added" }],
									testSelectors: [{ selectorId: "rust-path", value: "tests/behavior.rs" }],
								},
							},
						};
					},
				};
			},
			runManySettled: async (jobs: Array<{ kind: "review-design" | "review-code" }>) =>
				jobs.map((job) => ({ ok: true, result: reviewResult(job.kind) })) as AgentSettlement<"review-design" | "review-code">[],
			runSettled: async () => ({ ok: false, error: "use deterministic fallback" }),
		} as unknown as AgentGateway;
		const catalog = await TrustedCommandCatalog.build(resolved, repository.root);
		const panel = new ReviewPanel(gateway, store, ref, resolved);
		const approver = new DesignApprover(
			panel,
			catalog,
			store,
			ref,
			async () => (await trees.captureObservation()).observation,
		);
		const implementation = new ImplementationAgent(
			authority,
			gateway,
			await WorkspaceBoundary.open(repository, runner),
			catalog,
			trees,
			store,
			ref,
		);
		const normalizer = new Normalizer(authority, resolved, trees);
		const capture = () =>
			repository.kind === "git"
				? captureGitObservation(repository, resolved.digest, runner)
				: captureJjObservation(repository, resolved.digest, runner);
		const gates = new GateExecutor(authority, store, ref, repository.kind, capture);
		const backend =
			repository.kind === "git"
				? {
						kind: "git" as const,
						service: new GitTransactionService(authority, store, ref, repository, runner, join(agentDir, "git-transaction")),
					}
				: {
						kind: "jj" as const,
						service: new JjTransactionService(authority, store, ref, repository, runner, trees),
					};
		const qualifier = new QualifyAndCommit(
			resolved,
			catalog,
			normalizer,
			trees,
			gates,
			panel,
			gateway,
			store,
			ref,
			backend,
			null,
		);
		const preflight = new WritePreflight(authority, trees, repository, resolved, runner);
		const gitHeadBefore =
			repository.kind === "git" ? (await fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim() : undefined;
		const jjBookmarkBefore =
			repository.kind === "jj"
				? (await fixture.run("jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id"])).stdout.trim()
				: undefined;
		commands.length = 0;
		const result = await runBuildWorkflow({
			origin: userOriginFromRegisteredCommand("Build the feature"),
			policy: resolved,
			catalog,
			authority,
			gateway,
			trees,
			preflight,
			approver,
			implementation,
			qualifier,
			store,
			ref,
			repositoryKind: repository.kind,
			approvedAt: "2026-08-25T00:00:02.000Z",
			checkpointedAt: "2026-08-25T00:00:03.000Z",
			authorizedAt: "2026-08-25T00:00:04.000Z",
			completedAt: "2026-08-25T00:00:05.000Z",
		});
		expect(await readFile(join(fixture.root, "feature.rs"), "utf8")).toContain("feature");
		expect(JSON.parse(await readFile(join(ref.directory, "artifacts/workflow/build-context.json"), "utf8"))).toMatchObject({
			workflow: "build",
			stage: "implemented",
			implementationCheckpoint: { phase: "implement", sequence: 1 },
		});
		if (!behaviorPass) {
			expect(result).toMatchObject({ status: "NotVerified" });
			expect(await store.load(ref)).toMatchObject({ lifecycle: "Completed", outcome: "NotVerified" });
			if (repository.kind === "git") {
				expect((await fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).toBe(gitHeadBefore);
				expect((await fixture.run("git", ["status", "--porcelain"])).stdout).toContain("feature.rs");
			}
			return;
		}
		expect(result).toMatchObject({ status: "LocalCommitCreated", commitId: expect.stringMatching(/^[0-9a-f]{40,64}$/) });
		expect(await store.load(ref)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
		if (repository.kind === "git") {
			const headAfter = (await fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim();
			expect(headAfter).not.toBe(gitHeadBefore);
			expect((await fixture.run("git", ["status", "--porcelain"])).stdout).toBe("");
			expect((await fixture.run("git", ["branch", "--show-current"])).stdout.trim()).toBe("main");
		} else {
			expect((await fixture.run("jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id"])).stdout.trim()).toBe(
				jjBookmarkBefore,
			);
			expect((await fixture.run("jj", ["status"])).stdout).toContain("no changes");
			expect(
				commands.filter((entry) => entry.command === "git").every((entry) => entry.args.includes("check-ignore")),
			).toBe(true);
		}
		expect(commands.some((entry) => entry.args.includes("push"))).toBe(false);
	} finally {
		await fixture.cleanup();
	}
}

async function runResumeCase(tamperContext = false): Promise<void> {
	const fixture = await createRepositoryFixture("git");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-build-resume-"));
	temporary.push(agentDir);
	try {
		const resolved = policy();
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
		const runtime = new BuildResumeRuntime(agentDir, runner, () => ({}) as ResolvedModels);
		const originalWrite = runtime.store.writeArtifact.bind(runtime.store);
		let pauseRequested = false;
		runtime.store.writeArtifact = async (...args) => {
			const result = await originalWrite(...args);
			if (!pauseRequested && args[1] === "workflow/build-context.json") {
				const value = JSON.parse(Buffer.isBuffer(args[2]) ? args[2].toString("utf8") : args[2]);
				if (value.stage === "implemented") {
					pauseRequested = true;
					await runtime.store.appendControl(args[0], "Pause", "2026-08-25T00:00:04.500Z");
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
			{ workflow: "build", origin: userOriginFromRegisteredCommand("Build resumable feature") },
			ctx,
		);
		expect(paused.state).toMatchObject({ lifecycle: "Paused" });
		if (paused.state.lifecycle !== "Paused") throw new Error("expected paused build");
		const pausedAttempt = paused.state.lastAttemptId;
		if (tamperContext) {
			const path = "workflow/build-context.json";
			const context = JSON.parse((await runtime.store.readArtifact(paused.ref, path)).toString("utf8"));
			context.implementationCheckpoint.controlRevision++;
			await runtime.store.writeArtifact(paused.ref, path, JSON.stringify(context));
			await expect(runtime.resume(paused.ref, userOriginFromRegisteredCommand("resume tampered build"), ctx)).rejects.toThrow(
				"contradicts durable store",
			);
			expect(await runtime.store.load(paused.ref)).toMatchObject({ lifecycle: "Paused" });
			return;
		}
		const resumed = await runtime.resume(paused.ref, userOriginFromRegisteredCommand("resume build"), ctx);
		expect(resumed.state).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
		if (resumed.state.lifecycle !== "Completed") throw new Error("expected completed build");
		expect(resumed.state.lastAttemptId).not.toBe(pausedAttempt);
		expect((await fixture.run("git", ["status", "--porcelain"])).stdout).toBe("");
		expect(await readFile(join(fixture.root, "feature.rs"), "utf8")).toContain("feature");
	} finally {
		await fixture.cleanup();
	}
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("build integration", () => {
	it("creates one local Git commit through the complete build path", async () => runCase("git"), 60_000);
	it("leaves a non-Verified Git candidate uncommitted", async () => runCase("git", false), 60_000);
	it("resumes qualification from the persisted implementation checkpoint", async () => runResumeCase(), 60_000);
	it("rejects a mutable context that contradicts the immutable checkpoint", async () => runResumeCase(true), 60_000);
	const jjIt = jjAvailability.available ? it : it.skip;
	jjIt(`creates one native-jj commit (${jjAvailability.diagnostic})`, async () => runCase("jj-native"), 60_000);
	jjIt(`creates one colocated-jj commit without Git evidence or publication (${jjAvailability.diagnostic})`, async () => runCase("jj-colocated"), 60_000);
});
