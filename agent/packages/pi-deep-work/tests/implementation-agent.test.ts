import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGateway, WorkspaceAgentTools } from "../src/agents/gateway.ts";
import {
	ImplementationAgent,
	ImplementationAgentStatusError,
} from "../src/application/implementation-agent.ts";
import { MutationRecoveryRequiredError, type RunAuthority } from "../src/application/run-authority.ts";
import { startRun } from "../src/application/lifecycle.ts";
import { attemptId } from "../src/application/types.ts";
import { TrustedCommandCatalog } from "../src/gates/catalog.ts";
import type { BackendTreeService } from "../src/gates/tree-backend.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { RunStore } from "../src/store/run-store.ts";
import { captureGitObservation } from "../src/vcs/git-backend.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner } from "../src/vcs/types.ts";
import { WorkspaceBoundary } from "../src/workspace/boundary.ts";
import { createRepositoryFixture, isolatedVcsEnvironment } from "./helpers/repositories.ts";

const executeFile = promisify(execFile);
const temporary: string[] = [];

const runner: CommandRunner = async (command, args, options) => {
	try {
		const result = await executeFile(command, [...args], {
			cwd: options.cwd,
			env: { ...isolatedVcsEnvironment(tmpdir()), ...options.env },
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

async function fixture(scenario: "ok" | "status" | "path" | "selector" | "provider" | "none" | "checkpoint") {
	const repositoryFixture = await createRepositoryFixture("git");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-implementation-agent-"));
	temporary.push(agentDir);
	const repository = await detectRepository(repositoryFixture.root, runner);
	if (repository.kind !== "git") throw new Error("expected git");
	const policy = resolvePolicy(
		decodeMachinePolicy({
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
			observations: [{ id: "behavior", claimKeys: ["behavior.ok"], argv: ["true"], timeoutMs: 1_000 }],
			verificationContracts: [],
			selectors: [
				{ id: "rust-path", language: "rust", observationId: "behavior", valuePattern: "[a-zA-Z0-9_./-]+\\.rs" },
			],
		}),
	);
	const store = new RunStore(agentDir);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "build" as const,
		repositoryId: repository.repositoryId,
		policyDigest: policy.digest,
		goal: "implement",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create("git", initial);
	const active = startRun(
		{ ...initial, lastEventRevision: 1 },
		attemptId(randomUUID()),
		"implement",
		"2026-08-25T00:00:01.000Z",
	);
	await store.appendTransition(ref, "AttemptStarted", active, active.updatedAt);
	const manualInspection = vi.fn().mockResolvedValue(undefined);
	const authority = { manualInspection } as unknown as RunAuthority;
	let tools: WorkspaceAgentTools | undefined;
	const delegated = {
		runMutation: async () => {
			if (scenario !== "none") {
				await tools!.write.execute(
					"implement",
					{ path: "implemented.rs", content: "pub fn implemented() {}\n" },
					undefined,
					() => undefined,
					undefined as never,
				);
			}
			if (scenario === "provider") throw new Error("provider failed");
			return {
				report: {
					value: {
						status: scenario === "status" || scenario === "none" ? "failed" : "ok",
						summary: "implemented",
						citations: [],
						changes:
							scenario === "path" ? [{ path: "other.rs", detail: "wrong" }] : [{ path: "implemented.rs", detail: "added" }],
						testSelectors: [
							{
								selectorId: scenario === "selector" ? "missing" : "rust-path",
								value: "tests/behavior.rs",
							},
						],
					},
				},
			};
		},
	};
	const gateway = {
		assertAuthority: (value: RunAuthority) => {
			if (value !== authority) throw new Error("wrong authority");
		},
		withWorkspaceTools: (value: WorkspaceAgentTools) => {
			tools = value;
			return delegated;
		},
	} as unknown as AgentGateway;
	const trees = {
		captureMutationObservation: async () => ({
			kind: "git",
			treeId: "1".repeat(40),
			observation: await captureGitObservation(repository, policy.digest, runner),
		}),
	} as unknown as BackendTreeService;
	if (scenario === "checkpoint") {
		store.writeCheckpoint = async () => {
			throw new Error("checkpoint failed");
		};
	}
	const agent = new ImplementationAgent(
		authority,
		gateway,
		await WorkspaceBoundary.open(repository, runner),
		await TrustedCommandCatalog.build(policy, repository.root),
		trees,
		store,
		ref,
	);
	return { repositoryFixture, agentDir, store, ref, active, manualInspection, agent };
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ImplementationAgent", () => {
	it("owns mutation tools and persists an exact implementation checkpoint", async () => {
		const values = await fixture("ok");
		try {
			const result = await values.agent.implement({
				approvedDesign: { approvedDesignId: "a".repeat(64) } as never,
				goal: "implement behavior",
				checkpointSequence: 1,
				createdAt: "2026-08-25T00:00:02.000Z",
			});
			expect(result.report.changes).toEqual([{ path: "implemented.rs", detail: "added" }]);
			expect(result.checkpoint).toMatchObject({ phase: "implement", mutation: { fileCount: 1 } });
			expect(await readFile(join(values.repositoryFixture.root, "implemented.rs"), "utf8")).toContain("implemented");
			expect(values.manualInspection).not.toHaveBeenCalled();
		} finally {
			await values.repositoryFixture.cleanup();
		}
	});

	for (const scenario of ["status", "path", "selector", "provider", "checkpoint"] as const) {
		it(`settles manual inspection for ${scenario} failure after mutation`, async () => {
			const values = await fixture(scenario);
			try {
				await expect(
					values.agent.implement({
						approvedDesign: { approvedDesignId: "a".repeat(64) } as never,
						goal: "implement behavior",
						checkpointSequence: 1,
						createdAt: "2026-08-25T00:00:02.000Z",
					}),
				).rejects.toBeInstanceOf(MutationRecoveryRequiredError);
				expect(values.manualInspection).toHaveBeenCalledTimes(1);
			} finally {
				await values.repositoryFixture.cleanup();
			}
		});
	}

	it("preserves an ordinary agent status failure before any mutation", async () => {
		const values = await fixture("none");
		try {
			await expect(
				values.agent.implement({
					approvedDesign: { approvedDesignId: "a".repeat(64) } as never,
					goal: "implement behavior",
					checkpointSequence: 1,
					createdAt: "2026-08-25T00:00:02.000Z",
				}),
			).rejects.toBeInstanceOf(ImplementationAgentStatusError);
			expect(values.manualInspection).not.toHaveBeenCalled();
		} finally {
			await values.repositoryFixture.cleanup();
		}
	});
});
