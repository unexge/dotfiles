import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentGateway } from "../src/agents/gateway.ts";
import type { WorkspaceAgentTools } from "../src/agents/gateway.ts";
import type { ResolvedModels } from "../src/policy/models.ts";
import type { ResolvedPolicy } from "../src/policy/catalog.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { RunAuthority, RunAuthorityClosedError } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import type { RunRef } from "../src/store/run-store.ts";
import { decodeRunProjection, type QueuedRun } from "../src/store/schemas.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner, DetectedRepository } from "../src/vcs/types.ts";
import { WorkflowRuntime, type StartRequest } from "../src/service/runtime.ts";
import { createRepositoryFixture, isolatedVcsEnvironment } from "./helpers/repositories.ts";

const executeFile = promisify(execFile);
const temporary: string[] = [];

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

async function machinePolicy(agentDir: string) {
	const path = join(agentDir, "pi-deep-work", "config.json");
	await mkdir(join(agentDir, "pi-deep-work"), { recursive: true });
	const machine = decodeMachinePolicy({
				schemaVersion: 1,
				models: {
					gpt: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
					opusReviewers: [{ provider: "test", id: "claude-opus-4-8", thinkingLevel: "max" }],
				},
				concurrency: 1,
				maxRepairRounds: 0,
				commandTimeoutMs: 10_000,
				minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
				minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
				observations: [],
				verificationContracts: [],
				selectors: [],
			});
	await writeFile(path, JSON.stringify(machine));
	return resolvePolicy(machine);
}

class CompletingRuntime extends WorkflowRuntime {
	seenRef?: RunRef;
	seenRepository?: DetectedRepository;
	mode: "complete" | "fail" | "active" | "control" | "pause" | "abandon" = "complete";

	protected override async dispatch(
		request: StartRequest,
		_ctx: ExtensionCommandContext,
		repository: DetectedRepository,
		policy: ResolvedPolicy,
		_models: ResolvedModels,
		ref: RunRef,
		authority: RunAuthority,
	): Promise<void> {
		this.seenRef = ref;
		this.seenRepository = repository;
		expect(request.workflow).toBe("how");
		expect(policy.digest).toMatch(/^[0-9a-f]{64}$/);
		if (this.mode === "fail") throw new Error("injected workflow failure");
		if (this.mode === "active") return;
		if (this.mode === "abandon") {
			await authority.abandonForRecovery();
			return;
		}
		if (this.mode === "control" || this.mode === "pause") {
			await authority.requestControl(this.mode === "control" ? "Cancel" : "Pause", "2026-08-25T00:00:01.500Z");
			await authority.runEffect("observe control", async () => undefined);
			return;
		}
		await this.store.writeArtifact(ref, "outputs/how.json", "{}");
		await authority.complete("ExplanationProduced", "outputs/how.json", "2026-08-25T00:00:02.000Z");
	}
}

class HowRuntime extends WorkflowRuntime {
	protected override createGateway(
		authority: RunAuthority,
		_repository: DetectedRepository,
		_models: ResolvedModels,
		_tools: WorkspaceAgentTools,
	): AgentGateway {
		const designReport = {
			status: "ok",
			summary: "design",
			citations: [],
			usage: "usage",
			dataShape: "shape",
			interfaces: [],
			modules: [],
			invariants: ["invariant"],
			tradeoffs: [],
			verification: ["verify"],
			testSelectors: [],
		};
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
									summary: "plan",
									citations: [],
									interpretation: "question",
									successCriteria: ["answer"],
									steps: ["inspect"],
								},
							},
						}
					: job.kind === "design"
						? { report: { value: designReport } }
						: job.kind === "explore"
							? {
								report: {
									value: {
										status: "ok",
										summary: "explored",
										citations: [],
										components: [],
										flow: [],
										constraints: [],
										unknowns: [],
									},
								},
							}
							: { report: { value: { status: "ok", summary: "answer", citations: [], output: "Runtime answer." } } },
			runMany: async (jobs: Array<{ kind: string }>) =>
				jobs.map((job) => ({
					report: {
						value:
							job.kind === "design"
								? designReport
								: {
										status: "ok",
										summary: "explored",
										citations: [],
										components: [],
										flow: [],
										constraints: [],
										unknowns: [],
									},
					},
				})),
			runManySettled: async (jobs: Array<{ kind: "review-design" | "review-code" }>) =>
				jobs.map((job) => ({
					ok: true,
					result: {
						kind: job.kind,
						role: job.kind === "review-design" ? "design-reviewer" : "code-reviewer",
						model: "test/claude-opus-4-8",
						turns: 1,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
						report: {
							source: "untrusted-agent",
							value: { status: "ok", summary: "approved", citations: [], verdict: "approve", findings: [] },
						},
					},
				})),
			runSettled: async () => ({ ok: false, error: "unused" }),
		} as unknown as AgentGateway;
	}
}

function context(root: string): ExtensionCommandContext {
	return {
		cwd: root,
		isProjectTrusted: () => false,
		modelRegistry: {} as never,
	} as unknown as ExtensionCommandContext;
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workflow runtime", () => {
	it("creates only metadata and returns the durable workflow projection", async () => {
		const fixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new CompletingRuntime(agentDir, runner, () => ({}) as ResolvedModels);
			const result = await runtime.start(
				{ workflow: "how", origin: userOriginFromRegisteredCommand("Explain runtime") },
				context(fixture.root),
			);
			expect(result.state).toMatchObject({ lifecycle: "Completed", outcome: "ExplanationProduced" });
			expect(result.ref.directory).toContain(join("runs"));
			expect(JSON.parse(await readFile(join(result.ref.directory, "artifacts/run/request.json"), "utf8"))).toMatchObject({
				schemaVersion: 1,
				workflow: "how",
				goal: "Explain runtime",
			});
			expect(JSON.parse(await readFile(join(result.ref.directory, "artifacts/run/repository.json"), "utf8"))).toMatchObject({
				schemaVersion: 1,
				kind: "git",
				root: fixture.root,
			});
		} finally {
			await fixture.cleanup();
		}
	});

	it("durably fails and releases an unexpectedly Active workflow", async () => {
		const fixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-fail-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new CompletingRuntime(agentDir, runner, () => ({}) as ResolvedModels);
			runtime.mode = "fail";
			await expect(
				runtime.start({ workflow: "how", origin: userOriginFromRegisteredCommand("Fail runtime") }, context(fixture.root)),
			).rejects.toThrow("injected workflow failure");
			const state = await runtime.store.load(runtime.seenRef!);
			expect(state).toMatchObject({ lifecycle: "Failed", reason: "injected workflow failure" });
			await expect(
				runtime.leases.acquire({
					scope: "repository",
					repositoryId: state.repositoryId,
					runId: randomUUID(),
					attemptId: randomUUID(),
				}),
			).resolves.toBeTruthy();
		} finally {
			await fixture.cleanup();
		}
	});

	it("preserves the workflow cause and releases leases when failure settlement also errors", async () => {
		const fixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-double-failure-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new CompletingRuntime(agentDir, runner, () => ({}) as ResolvedModels);
			runtime.mode = "fail";
			const originalAppend = runtime.store.appendTransition.bind(runtime.store);
			runtime.store.appendTransition = async (...args) => {
				if (args[1] === "AttemptStopped") throw new Error("failure transition write failed");
				return originalAppend(...args);
			};
			let rejection: unknown;
			try {
				await runtime.start(
					{ workflow: "how", origin: userOriginFromRegisteredCommand("Double failure") },
					context(fixture.root),
				);
			} catch (error) {
				rejection = error;
			}
			expect(rejection).toBeInstanceOf(AggregateError);
			expect((rejection as AggregateError).errors[0]).toMatchObject({ message: "injected workflow failure" });
			const state = await runtime.store.load(runtime.seenRef!);
			await expect(
				runtime.leases.acquire({
					scope: "repository",
					repositoryId: state.repositoryId,
					runId: randomUUID(),
					attemptId: randomUUID(),
				}),
			).resolves.toBeTruthy();
		} finally {
			await fixture.cleanup();
		}
	});

	it("settles metadata and authority-start failures without orphaning Queued runs", async () => {
		for (const failure of ["metadata", "authority", "post-active"] as const) {
			const fixture = await createRepositoryFixture("git");
			const agentDir = await mkdtemp(join(tmpdir(), `pi-deep-runtime-${failure}-`));
			temporary.push(agentDir);
			try {
				await machinePolicy(agentDir);
				const runtime = new CompletingRuntime(agentDir, runner, () => ({}) as ResolvedModels);
				let createdRef: RunRef | undefined;
				let repositoryLeaseAcquired = false;
				let repositoryLeaseReleased = false;
				const originalCreate = runtime.store.create.bind(runtime.store);
				runtime.store.create = async (...args) => {
					createdRef = await originalCreate(...args);
					return createdRef;
				};
				const originalAcquire = runtime.leases.acquire.bind(runtime.leases);
				runtime.leases.acquire = async (request) => {
					const handle = await originalAcquire(request);
					if (request.scope === "repository" && request.runId === createdRef?.runId) {
						repositoryLeaseAcquired = true;
						const originalRelease = handle.release.bind(handle);
						handle.release = async () => {
							repositoryLeaseReleased = true;
							await originalRelease();
						};
					}
					return handle;
				};
				if (failure === "metadata") {
					runtime.store.writeImmutableArtifact = async () => {
						throw new Error("metadata write failed");
					};
				} else if (failure === "authority") {
					const originalAppend = runtime.store.appendTransition.bind(runtime.store);
					let failed = false;
					runtime.store.appendTransition = async (...args) => {
						if (!failed) {
							failed = true;
							throw new Error("attempt start failed");
						}
						return originalAppend(...args);
					};
				} else {
					runtime.store.controls = async () => {
						throw new Error("post-active control read failed");
					};
				}
				await expect(
					runtime.start(
						{ workflow: "how", origin: userOriginFromRegisteredCommand(`Fail ${failure}`) },
						context(fixture.root),
					),
				).rejects.toThrow();
				const state = await runtime.store.load(createdRef!);
				expect(state).toMatchObject({ lifecycle: "Failed" });
				const events = await Promise.all(
					(await readdir(join(createdRef!.directory, "events"))).map(async (name) =>
						JSON.parse(await readFile(join(createdRef!.directory, "events", name), "utf8")),
					),
				);
				expect(events.map((event) => event.kind)).toEqual(
					failure === "post-active"
						? ["RunCreated", "AttemptStarted", "AttemptStopped"]
						: ["RunCreated", "RunFailed"],
				);
				expect(events.some((event) => event.kind === "AttemptStarted")).toBe(failure === "post-active");
				expect(repositoryLeaseAcquired).toBe(failure !== "metadata");
				expect(repositoryLeaseReleased).toBe(failure !== "metadata");
				await expect(
					runtime.leases.acquire({
						scope: "repository",
						repositoryId: state.repositoryId,
						runId: randomUUID(),
						attemptId: randomUUID(),
					}),
				).resolves.toBeTruthy();
			} finally {
				await fixture.cleanup();
			}
		}
	});

	it("resolves models before creating a run", async () => {
		const fixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-models-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new CompletingRuntime(agentDir, runner, () => {
				throw new Error("model resolution failed");
			});
			await expect(
				runtime.start({ workflow: "how", origin: userOriginFromRegisteredCommand("Resolve models") }, context(fixture.root)),
			).rejects.toThrow("model resolution failed");
			await expect(readdir(runtime.store.root)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fixture.cleanup();
		}
	});

	it("executes the real common composition and how dispatch", async () => {
		const fixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-dispatch-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new HowRuntime(agentDir, runner, () => ({}) as ResolvedModels);
			const result = await runtime.start(
				{ workflow: "how", origin: userOriginFromRegisteredCommand("Explain actual dispatch") },
				context(fixture.root),
			);
			expect(result.state).toMatchObject({ lifecycle: "Completed", outcome: "ExplanationProduced" });
			const output = JSON.parse(await readFile(join(result.ref.directory, "artifacts/outputs/how.json"), "utf8"));
			expect(output.output).toBe("Runtime answer.");
		} finally {
			await fixture.cleanup();
		}
	}, 20_000);

	it("routes every workflow through the real composition switch", async () => {
		const fixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-all-workflows-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new HowRuntime(agentDir, runner, () => ({}) as ResolvedModels);
			const cases: Array<{
				request: StartRequest;
				lifecycle: "Completed" | "Blocked";
				outcome?: string;
			}> = [
				{
					request: { workflow: "how", origin: userOriginFromRegisteredCommand("How") },
					lifecycle: "Completed",
					outcome: "ExplanationProduced",
				},
				{
					request: { workflow: "design", origin: userOriginFromRegisteredCommand("Design") },
					lifecycle: "Completed",
					outcome: "DesignApproved",
				},
				{
					request: { workflow: "unslop", origin: userOriginFromRegisteredCommand("Text"), unslopSource: { kind: "text", text: "Text" } },
					lifecycle: "Completed",
					outcome: "UnslopReportProduced",
				},
				{ request: { workflow: "review", origin: userOriginFromRegisteredCommand("Review") }, lifecycle: "Blocked" },
				{ request: { workflow: "verify", origin: userOriginFromRegisteredCommand("Claim") }, lifecycle: "Blocked" },
				{ request: { workflow: "build", origin: userOriginFromRegisteredCommand("Build") }, lifecycle: "Blocked" },
				{ request: { workflow: "fix", origin: userOriginFromRegisteredCommand("Fix") }, lifecycle: "Blocked" },
			];
			for (const value of cases) {
				const result = await runtime.start(value.request, context(fixture.root));
				expect(result.state.lifecycle).toBe(value.lifecycle);
				if (value.outcome && result.state.lifecycle === "Completed") expect(result.state.outcome).toBe(value.outcome);
			}
		} finally {
			await fixture.cleanup();
		}
	}, 60_000);

	it("returns accepted controls and fails a normal return that leaves the run Active", async () => {
		for (const mode of ["control", "active"] as const) {
			const fixture = await createRepositoryFixture("git");
			const agentDir = await mkdtemp(join(tmpdir(), `pi-deep-runtime-${mode}-`));
			temporary.push(agentDir);
			try {
				await machinePolicy(agentDir);
				const runtime = new CompletingRuntime(agentDir, runner, () => ({}) as ResolvedModels);
				runtime.mode = mode;
				if (mode === "control") {
					const result = await runtime.start(
						{ workflow: "how", origin: userOriginFromRegisteredCommand("Control runtime") },
						context(fixture.root),
					);
					expect(result.state).toMatchObject({ lifecycle: "Cancelled" });
					await expect(
						runtime.leases.acquire({
							scope: "repository",
							repositoryId: result.state.repositoryId,
							runId: randomUUID(),
							attemptId: randomUUID(),
						}),
					).resolves.toBeTruthy();
				} else {
					await expect(
						runtime.start(
							{ workflow: "how", origin: userOriginFromRegisteredCommand("Active runtime") },
							context(fixture.root),
						),
					).rejects.toThrow("without a durable outcome");
					const failedState = await runtime.store.load(runtime.seenRef!);
					expect(failedState).toMatchObject({ lifecycle: "Failed" });
					await expect(
						runtime.leases.acquire({
							scope: "repository",
							repositoryId: failedState.repositoryId,
							runId: randomUUID(),
							attemptId: randomUUID(),
						}),
					).resolves.toBeTruthy();
				}
			} finally {
				await fixture.cleanup();
			}
		}
	});

	it("resumes a persisted read-only run with a fresh attempt and original goal", async () => {
		const fixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-resume-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new CompletingRuntime(agentDir, runner, () => ({}) as ResolvedModels);
			runtime.mode = "pause";
			const paused = await runtime.start(
				{ workflow: "how", origin: userOriginFromRegisteredCommand("Original goal") },
				context(fixture.root),
			);
			expect(paused.state).toMatchObject({ lifecycle: "Paused" });
			runtime.mode = "complete";
			const resumed = await runtime.resume(
				paused.ref,
				userOriginFromRegisteredCommand("resume command"),
				context(fixture.root),
			);
			expect(resumed.state).toMatchObject({ lifecycle: "Completed", outcome: "ExplanationProduced", goal: "Original goal" });
			if (resumed.state.lifecycle !== "Completed" || paused.state.lifecycle !== "Paused") throw new Error("unexpected lifecycle");
			expect(resumed.state.lastAttemptId).not.toBe(paused.state.lastAttemptId);
		} finally {
			await fixture.cleanup();
		}
	});

	it("restarts a clean no-context write run and preserves a dirty no-context pause", async () => {
		for (const dirty of [false, true]) {
			const fixture = await createRepositoryFixture("git");
			const agentDir = await mkdtemp(join(tmpdir(), `pi-deep-runtime-write-restart-${dirty}-`));
			temporary.push(agentDir);
			try {
				const resolved = await machinePolicy(agentDir);
				const runtime = new HowRuntime(agentDir, runner, () => ({}) as ResolvedModels);
				const repository = await detectRepository(fixture.root, runner);
				const queued = decodeRunProjection({
					schemaVersion: 1,
					runId: randomUUID(),
					workflow: "build",
					repositoryId: repository.repositoryId,
					policyDigest: resolved.digest,
					goal: "Restart build",
					createdAt: "2026-08-25T00:00:00.000Z",
					updatedAt: "2026-08-25T00:00:00.000Z",
					lastEventRevision: 0,
					lifecycle: "Queued",
				}) as QueuedRun;
				const ref = await runtime.store.create("git", queued);
				await runtime.store.writeImmutableArtifact(
					ref,
					"run/request.json",
					JSON.stringify({ schemaVersion: 1, workflow: "build", goal: "Restart build" }),
				);
				await runtime.store.writeImmutableArtifact(
					ref,
					"run/repository.json",
					JSON.stringify({ schemaVersion: 1, ...repository }),
				);
				const created = await runtime.store.load(ref);
				if (created.lifecycle !== "Queued") throw new Error("expected queued");
				const authority = await RunAuthority.start(
					{
						store: runtime.store,
						leases: runtime.leases,
						ref,
						repository,
						attemptId: attemptId(randomUUID()),
						phase: "build",
						pollIntervalMs: 5,
					},
					created,
					"2026-08-25T00:00:01.000Z",
				);
				await authority.pause("pause before context", "2026-08-25T00:00:02.000Z");
				if (dirty) await fixture.write("dirty.txt", "dirty\n");
				if (dirty) {
					const resumed = await runtime.resume(
						ref,
						userOriginFromRegisteredCommand("resume dirty build"),
						context(fixture.root),
					);
					expect(resumed.state).toMatchObject({
						lifecycle: "NeedsManualInspection",
						reason: "Write resume has no durable context and the checkout is not clean",
					});
				} else {
					const resumed = await runtime.resume(
						ref,
						userOriginFromRegisteredCommand("resume clean build"),
						context(fixture.root),
					);
					expect(resumed.state).toMatchObject({ lifecycle: "Blocked", reason: expect.stringContaining("mainline") });
				}
			} finally {
				await fixture.cleanup();
			}
		}
	});

	it("recovers an abandoned Active run to Blocked without swallowing a pending Cancel", async () => {
		const fixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-active-recover-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new CompletingRuntime(agentDir, runner, () => ({}) as ResolvedModels);
			runtime.mode = "abandon";
			await expect(
				runtime.start(
					{ workflow: "how", origin: userOriginFromRegisteredCommand("Abandon") },
					context(fixture.root),
				),
			).rejects.toBeInstanceOf(RunAuthorityClosedError);
			const ref = runtime.seenRef!;
			expect(await runtime.store.load(ref)).toMatchObject({ lifecycle: "Active" });
			await runtime.store.appendControl(ref, "Cancel", "2026-08-25T00:00:04.000Z");
			const recovered = await runtime.recover(ref, userOriginFromRegisteredCommand("recover abandoned"));
			expect(recovered).toMatchObject({
				status: "None",
				state: { lifecycle: "Blocked", observedControlRevision: 0 },
			});
			const resumed = await runtime.resume(ref, userOriginFromRegisteredCommand("resume abandoned"), context(fixture.root));
			expect(resumed.state).toMatchObject({ lifecycle: "Cancelled" });
		} finally {
			await fixture.cleanup();
		}
	});

	it("recovers a markerless completed Git run through recovery-only transaction wiring", async () => {
		const fixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-recover-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new CompletingRuntime(agentDir, runner, () => ({}) as ResolvedModels);
			const completed = await runtime.start(
				{ workflow: "how", origin: userOriginFromRegisteredCommand("Recover") },
				context(fixture.root),
			);
			const recovered = await runtime.recover(completed.ref, userOriginFromRegisteredCommand("recover command"));
			expect(recovered).toMatchObject({ status: "None", state: { lifecycle: "Completed" } });
		} finally {
			await fixture.cleanup();
		}
	});

	it("uses recovery-only Jujutsu wiring without authority or tree dependencies", async () => {
		const fixture = await createRepositoryFixture("jj-native");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-jj-recover-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new CompletingRuntime(agentDir, runner, () => ({}) as ResolvedModels);
			const completed = await runtime.start(
				{ workflow: "how", origin: userOriginFromRegisteredCommand("Recover jj") },
				context(fixture.root),
			);
			const recovered = await runtime.recover(completed.ref, userOriginFromRegisteredCommand("recover jj command"));
			expect(recovered).toMatchObject({ status: "None", state: { lifecycle: "Completed" } });
			await expect(
				runtime.leases.acquire({
					scope: "repository",
					repositoryId: completed.state.repositoryId,
					runId: randomUUID(),
					attemptId: randomUUID(),
				}),
			).resolves.toBeTruthy();
		} finally {
			await fixture.cleanup();
		}
	});

	it("persists jj-first repository metadata without invoking the real workflow", async () => {
		const fixture = await createRepositoryFixture("jj-native");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-runtime-jj-"));
		temporary.push(agentDir);
		try {
			await machinePolicy(agentDir);
			const runtime = new CompletingRuntime(agentDir, runner, () => ({}) as ResolvedModels);
			const result = await runtime.start(
				{ workflow: "how", origin: userOriginFromRegisteredCommand("Observe jj") },
				context(fixture.root),
			);
			expect(runtime.seenRepository?.kind).toBe("jj");
			expect(result.ref.backend).toBe("jj");
			expect(JSON.parse(await readFile(join(result.ref.directory, "artifacts/run/repository.json"), "utf8"))).toMatchObject({
				kind: "jj",
				workspaceId: "default",
			});
		} finally {
			await fixture.cleanup();
		}
	});
});
