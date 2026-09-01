import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGateway, WorkspaceAgentTools } from "../src/agents/gateway.ts";
import { QualifyAndCommit } from "../src/application/qualify-and-commit.ts";
import { RepairAgent } from "../src/application/repair-agent.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
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

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RepairAgent", () => {
	it("owns fresh mutation tools and persists an authoritative repair checkpoint", async () => {
		const fixture = await createRepositoryFixture("git");
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-repair-agent-"));
		temporary.push(agentDir);
		try {
			const repository = await detectRepository(fixture.root, runner);
			if (repository.kind !== "git") throw new Error("expected Git");
			const policy = resolvePolicy(
				decodeMachinePolicy({
					schemaVersion: 1,
					models: {
						gpt: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
						opusReviewers: [{ provider: "test", id: "claude-opus-4.8", thinkingLevel: "max" }],
					},
					concurrency: 1,
					maxRepairRounds: 1,
					commandTimeoutMs: 10_000,
					minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
					minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
					observations: [],
					verificationContracts: [],
					selectors: [],
				}),
			);
			const store = new RunStore(agentDir);
			const initial = {
				schemaVersion: 1 as const,
				runId: randomUUID(),
				workflow: "build" as const,
				repositoryId: repository.repositoryId,
				policyDigest: policy.digest,
				goal: "repair",
				createdAt: "2026-08-25T00:00:00.000Z",
				updatedAt: "2026-08-25T00:00:00.000Z",
				lastEventRevision: 0,
				lifecycle: "Queued" as const,
			};
			const ref = await store.create("git", initial);
			const active = startRun(
				{ ...initial, lastEventRevision: 1 },
				attemptId(randomUUID()),
				"repair",
				"2026-08-25T00:00:01.000Z",
			);
			await store.appendTransition(ref, "AttemptStarted", active, active.updatedAt);
			let delegatedTools: WorkspaceAgentTools | undefined;
			let writeMutation = true;
			let reportedPath = "repair.txt";
			const delegated = {
				runMutation: async () => {
					if (writeMutation) await delegatedTools!.write.execute(
						"repair",
						{ path: "repair.txt", content: "repaired\n" },
						undefined,
						() => undefined,
						undefined as never,
					);
					return {
						report: {
							value: {
								status: "ok",
								changes: writeMutation ? [{ path: reportedPath, detail: "repaired" }] : [],
								testSelectors: [],
							},
						},
					};
				},
			};
			const authority = {
				manualInspection: vi.fn().mockResolvedValue(undefined),
			} as unknown as RunAuthority;
			const baseGateway = {
				assertAuthority: (value: RunAuthority) => {
					if (value !== authority) throw new Error("wrong authority");
				},
				withWorkspaceTools: (tools: WorkspaceAgentTools) => {
					delegatedTools = tools;
					return delegated;
				},
			} as unknown as AgentGateway;
			const trees = {
				captureMutationObservation: async () => ({
					kind: "git",
					observation: await captureGitObservation(repository, policy.digest, runner),
					treeId: "1".repeat(40),
				}),
			} as unknown as BackendTreeService;
			const repair = new RepairAgent(
				authority,
				baseGateway,
				await WorkspaceBoundary.open(repository, runner),
				await TrustedCommandCatalog.build(policy, repository.root),
				trees,
				store,
				ref,
			);
			await repair.repair({
				round: 1,
				candidate: { kind: "git" } as never,
				approvedDesign: { approvedDesignId: "a".repeat(64) } as never,
				findings: [
					{ id: "r1:f1", reviewerId: "opus", severity: "important", title: "Fix", detail: "Repair it" },
				],
				checkpointSequence: 1,
				createdAt: "2026-08-25T00:00:02.000Z",
			});
			expect(await readFile(join(fixture.root, "repair.txt"), "utf8")).toBe("repaired\n");
			const checkpoint = join(
				ref.directory,
				"checkpoints",
				active.attemptId,
				"00000001-repair-1.json",
			);
			expect(JSON.parse(await readFile(checkpoint, "utf8"))).toMatchObject({
				phase: "repair-1",
				mutation: { fileCount: 1 },
			});
			reportedPath = "other.txt";
			await expect(
				repair.repair({
					round: 2,
					candidate: { kind: "git" } as never,
					approvedDesign: { approvedDesignId: "a".repeat(64) } as never,
					findings: [
						{ id: "r1:f1", reviewerId: "opus", severity: "important", title: "Fix", detail: "Repair it" },
					],
					checkpointSequence: 2,
					createdAt: "2026-08-25T00:00:03.000Z",
				}),
			).rejects.toMatchObject({
				name: "MutationRecoveryRequiredError",
				cause: expect.objectContaining({ message: "Repair report changed paths do not match authoritative mutation records" }),
			} satisfies Partial<MutationRecoveryRequiredError>);
			writeMutation = false;
			await expect(
				repair.repair({
					round: 3,
					candidate: { kind: "git" } as never,
					approvedDesign: { approvedDesignId: "a".repeat(64) } as never,
					findings: [
						{ id: "r1:f1", reviewerId: "opus", severity: "important", title: "Fix", detail: "Repair it" },
					],
					checkpointSequence: 3,
					createdAt: "2026-08-25T00:00:04.000Z",
				}),
			).rejects.toThrow("no workspace mutation");
			await expect(
				repair.repair({
					round: 4,
					candidate: { kind: "git" } as never,
					approvedDesign: { approvedDesignId: "a".repeat(64) } as never,
					findings: [
						{ id: "r1:s1", reviewerId: "opus", severity: "suggestion", title: "Nit", detail: "Optional" },
					],
					checkpointSequence: 4,
					createdAt: "2026-08-25T00:00:05.000Z",
				}),
			).rejects.toThrow("blocker or important");

			const repairLoop = { repair: vi.fn().mockResolvedValue(undefined) };
			const qualifier = new QualifyAndCommit(
				policy,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				store,
				ref,
				{ kind: "git", service: {} as never },
				repairLoop as never,
			);
			const substantive = {
				id: "r1:f2",
				reviewerId: "opus",
				severity: "important" as const,
				title: "Fix",
				detail: "Required",
			};
			const suggestion = {
				id: "r1:s2",
				reviewerId: "opus",
				severity: "suggestion" as const,
				title: "Nit",
				detail: "Optional",
			};
			const runRound = vi
				.fn()
				.mockResolvedValueOnce({
					status: "Repair",
					candidate: { kind: "git" },
					findings: [substantive, suggestion],
				})
				.mockResolvedValueOnce({ status: "ChangesRequired", findings: [substantive] });
			(qualifier as unknown as { runRound: typeof runRound }).runRound = runRound;
			const loopResult = await qualifier.run({
				workflow: "build",
				approvedDesign: { caller: "build" } as never,
				userOrigin: userOriginFromRegisteredCommand("goal"),
				checkpointSequence: 10,
				authorizedAt: "2026-08-25T00:00:06.000Z",
			});
			expect(loopResult).toMatchObject({ status: "ChangesRequired" });
			expect(runRound.mock.calls.map((call) => [call[1], call[2]])).toEqual([
				[0, 10],
				[1, 12],
			]);
			expect(repairLoop.repair).toHaveBeenCalledWith(
				expect.objectContaining({ round: 1, findings: [substantive], checkpointSequence: 11 }),
			);

			await store.writeArtifact(
				ref,
				`qualification/${active.attemptId}.json`,
				JSON.stringify({ schemaVersion: 1, attemptId: active.attemptId, baseSequence: 0, phase: "repairing", round: 0 }),
			);
			const resumedRound = vi.fn().mockResolvedValue({ status: "ChangesRequired", findings: [substantive] });
			(qualifier as unknown as { runRound: typeof resumedRound }).runRound = resumedRound;
			const resumed = await qualifier.run({
				workflow: "build",
				approvedDesign: { caller: "build" } as never,
				userOrigin: userOriginFromRegisteredCommand("goal"),
				checkpointSequence: 0,
				authorizedAt: "2026-08-25T00:00:07.000Z",
			});
			expect(resumed.status).toBe("ChangesRequired");
			expect(resumedRound.mock.calls.map((call) => [call[1], call[2]])).toEqual([[1, 2]]);
			expect(
				await qualifier.run({
					workflow: "build",
					approvedDesign: { caller: "build" } as never,
					userOrigin: userOriginFromRegisteredCommand("goal"),
					checkpointSequence: 0,
					authorizedAt: "2026-08-25T00:00:08.000Z",
				}),
			).toMatchObject({ status: "Blocked", reason: expect.stringContaining("already completed") });
			await expect(
				qualifier.run({
					workflow: "build",
					approvedDesign: { caller: "build" } as never,
					userOrigin: userOriginFromRegisteredCommand("goal"),
					checkpointSequence: 1,
					authorizedAt: "2026-08-25T00:00:09.000Z",
				}),
			).rejects.toThrow("malformed or belongs to another attempt");
		} finally {
			await fixture.cleanup();
		}
	}, 15_000);
});
