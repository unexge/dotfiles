import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGateway, AgentResult, AgentSettlement } from "../src/agents/gateway.ts";
import { DesignApprover } from "../src/application/approve-design.ts";
import { ControlAcceptedError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import type { BackendObservationSnapshot, BackendTreeService } from "../src/gates/tree-backend.ts";
import { TrustedCommandCatalog } from "../src/gates/catalog.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { ReviewPanel } from "../src/review/panel.ts";
import { RunStore } from "../src/store/run-store.ts";
import type { DetectedRepository } from "../src/vcs/types.ts";
import { runDesignWorkflow } from "../src/workflows/design.ts";

const temporary: string[] = [];
const reviewerModel = "test/claude-opus-4-8";

function policy() {
	return resolvePolicy(
		decodeMachinePolicy({
			schemaVersion: 2,
			models: {
				orchestrator: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
				reviewers: [{ provider: "test", id: "claude-opus-4-8", thinkingLevel: "max" }],
			},
			concurrency: 2,
			maxRepairRounds: 0,
			commandTimeoutMs: 10_000,
			minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			observations: [],
			verificationContracts: [],
			selectors: [],
		}),
	);
}

function snapshot(kind: "git" | "jj", policyDigest: string, workingDigest = "c".repeat(64)): BackendObservationSnapshot {
	if (kind === "git") {
		return {
			kind: "git",
			treeId: "3".repeat(40),
			observation: {
				schemaVersion: 1,
				kind: "git",
				repositoryId: "a".repeat(64),
				root: "/repo",
				policyDigest,
				workingDigest,
				changedPathsDigest: "d".repeat(64),
				headOid: "1".repeat(40),
				symbolicRef: "refs/heads/main",
				conflicted: false,
				indexTree: "2".repeat(40),
			},
		};
	}
	return {
		kind: "jj",
		treeDigest: "3".repeat(64),
		observation: {
			schemaVersion: 1,
			kind: "jj",
			repositoryId: "a".repeat(64),
			root: "/repo",
			policyDigest,
			workingDigest,
			changedPathsDigest: "d".repeat(64),
			operationId: workingDigest === "c".repeat(64) ? "op-1" : "op-2",
			workspaceId: "default",
			changeId: "4".repeat(32),
			commitId: workingDigest === "c".repeat(64) ? "5".repeat(64) : "7".repeat(64),
			parentCommitIds: ["6".repeat(64)],
			conflicted: false,
		},
	};
}

function designReport(label: string, status: "ok" | "blocked" | "failed" = "ok") {
	return {
		status,
		summary: label,
		citations: [],
		usage: `${label} usage`,
		dataShape: `${label} data`,
		interfaces: [`${label} interface`],
		modules: [`${label} module`],
		invariants: [`${label} invariant`],
		tradeoffs: [`${label} tradeoff`],
		verification: [`${label} verification`],
		testSelectors: [],
	};
}

function reviewReport(changesRequired: boolean) {
	return {
		status: "ok",
		summary: "reviewed",
		citations: [],
		verdict: changesRequired ? "changes_required" : "approve",
		findings: changesRequired
			? [
					{
						id: "gap",
						severity: "important",
						title: "Design gap",
						detail: "Missing invariant",
						evidence: ["design"],
						recommendation: "Add it",
					},
				]
			: [],
	};
}

async function fixture(kind: "git" | "jj" = "git") {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-design-"));
	temporary.push(root);
	const resolved = policy();
	const store = new RunStore(root);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "design" as const,
		repositoryId: "a".repeat(64),
		policyDigest: resolved.digest,
		goal: "design",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create(kind, initial);
	const repository: DetectedRepository =
		kind === "git"
			? {
					kind: "git",
					root: "/repo",
					sharedRoot: "/repo/.git",
					commonDir: "/repo/.git",
					repositoryId: initial.repositoryId,
				}
			: {
					kind: "jj",
					root: "/repo",
					sharedRoot: "/repo/.jj/repo",
					gitStore: "/repo/.jj/repo/store/git",
					workspaceId: "default",
					repositoryId: initial.repositoryId,
				};
	const authority = await RunAuthority.start(
		{
			store,
			leases: new PortableLeaseManager(root),
			ref,
			repository,
			attemptId: attemptId(randomUUID()),
			phase: "design",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	let liveSnapshot = snapshot(kind, resolved.digest);
	let foreignApproverCapture = false;
	const trees = { captureObservation: async () => liveSnapshot } as unknown as BackendTreeService;
	let candidateStatus: "ok" | "blocked" | "failed" = "ok";
	let synthesisStatus: "ok" | "blocked" | "failed" = "ok";
	let panelFailure = false;
	let changesRequired = false;
	const candidateJobs: Array<{ task: string }> = [];
	let synthesisTask = "";
	const gateway = {
		assertAuthority(value: RunAuthority) {
			if (value !== authority) throw new Error("wrong authority");
		},
		runMany: async (jobs: Array<{ task: string }>) => {
			candidateJobs.push(...jobs);
			return jobs.map((_, index) => ({ report: { value: designReport(`candidate-${index + 1}`, candidateStatus) } }));
		},
		run: async (job: { task: string }) => {
			synthesisTask = job.task;
			return { report: { value: designReport("synthesis", synthesisStatus) } };
		},
		runManySettled: async () => {
			if (panelFailure) return [{ ok: false, error: "reviewer unavailable" }];
			const result: AgentResult<"review-design"> = {
				kind: "review-design",
				role: "design-reviewer",
				model: reviewerModel,
				turns: 1,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
				report: { source: "untrusted-agent", value: reviewReport(changesRequired) as never },
			};
			return [{ ok: true, result }] as AgentSettlement<"review-design">[];
		},
		runSettled: async () => ({ ok: false, error: "adjudication unavailable" }),
	} as unknown as AgentGateway;
	const panel = new ReviewPanel(gateway, store, ref, resolved);
	const catalog = await TrustedCommandCatalog.build(resolved, root);
	const capture = async () =>
		foreignApproverCapture
			? snapshot(kind, resolved.digest, "9".repeat(64)).observation
			: (await trees.captureObservation()).observation;
	const approver = new DesignApprover(panel, catalog, store, ref, capture);
	const originalImmutable = store.writeImmutableArtifact.bind(store);
	let driftAfterApproval = false;
	let pauseAfterApproval = false;
	store.writeImmutableArtifact = async (...args) => {
		const result = await originalImmutable(...args);
		if (args[1].startsWith("approved-designs/") && args[1].endsWith("/record.json")) {
			if (driftAfterApproval) liveSnapshot = snapshot(kind, resolved.digest, "f".repeat(64));
			if (pauseAfterApproval) {
				pauseAfterApproval = false;
				await store.appendControl(ref, "Pause", "2026-08-25T00:00:01.500Z");
			}
		}
		return result;
	};
	let failOutput = false;
	const originalWrite = store.writeArtifact.bind(store);
	store.writeArtifact = async (...args) => {
		if (failOutput && args[1] === "outputs/design.json") throw new Error("design output write failed");
		return originalWrite(...args);
	};
	return {
		root,
		store,
		ref,
		authority,
		gateway,
		trees,
		approver,
		candidateJobs,
		synthesisTask: () => synthesisTask,
		setCandidateStatus(value: "ok" | "blocked" | "failed") {
			candidateStatus = value;
		},
		setSynthesisStatus(value: "ok" | "blocked" | "failed") {
			synthesisStatus = value;
		},
		setPanelFailure() {
			panelFailure = true;
		},
		setChangesRequired() {
			changesRequired = true;
		},
		useForeignApproverCapture() {
			foreignApproverCapture = true;
		},
		driftAfterApprovedRecord() {
			driftAfterApproval = true;
		},
		pauseAfterApprovedRecord() {
			pauseAfterApproval = true;
		},
		failOutputWrite() {
			failOutput = true;
		},
	};
}

async function run(values: Awaited<ReturnType<typeof fixture>>) {
	return runDesignWorkflow({
		origin: userOriginFromRegisteredCommand("Design a cache"),
		authority: values.authority,
		gateway: values.gateway,
		trees: values.trees,
		approver: values.approver,
		store: values.store,
		ref: values.ref,
		concurrency: 2,
		approvedAt: "2026-08-25T00:00:02.000Z",
		completedAt: "2026-08-25T00:00:03.000Z",
	});
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("design workflow", () => {
	for (const kind of ["git", "jj"] as const) {
		it(`publishes a current approved ${kind} design from exactly two candidates`, async () => {
			const values = await fixture(kind);
			const result = await run(values);
			expect(result).toMatchObject({ outcome: "DesignApproved", approvedDesignId: expect.stringMatching(/^[0-9a-f]{64}$/) });
			expect(values.candidateJobs).toHaveLength(2);
			expect(values.candidateJobs[0].task).not.toBe(values.candidateJobs[1].task);
			expect(values.synthesisTask()).toContain("candidate-1");
			expect(values.synthesisTask()).toContain("candidate-2");
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "DesignApproved" });
			const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/design.json"), "utf8"));
			expect(artifact).toMatchObject({
				proposedOutcome: "DesignApproved",
				authoritative: false,
				lifecycleAuthority: "state.json",
				approval: { approvedDesignId: result.approvedDesignId, designArtifactDigest: artifact.designDigest },
				candidates: [{ summary: "candidate-1" }, { summary: "candidate-2" }],
			});
		});
	}

	it("publishes complete important findings as ChangesRequired", async () => {
		const values = await fixture();
		values.setChangesRequired();
		const result = await run(values);
		expect(result).toMatchObject({
			outcome: "ChangesRequired",
			findings: [{ id: "r1:gap", reviewerId: reviewerModel, severity: "important" }],
		});
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "ChangesRequired" });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/design.json"), "utf8"));
		expect(artifact.approval.reviewSubjectDigest).toMatch(/^[0-9a-f]{64}$/);
		await expect(readdir(join(values.ref.directory, "artifacts/approved-designs"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("maps candidate, synthesis, and incomplete-panel failures truthfully", async () => {
		for (const [phase, status] of [
			["candidate", "blocked"],
			["candidate", "failed"],
			["synthesis", "blocked"],
			["synthesis", "failed"],
		] as const) {
			const values = await fixture();
			if (phase === "candidate") values.setCandidateStatus(status);
			else values.setSynthesisStatus(status);
			expect(await run(values)).toMatchObject({ outcome: status === "blocked" ? "Blocked" : "Failed" });
		}
		const incomplete = await fixture();
		incomplete.setPanelFailure();
		expect(await run(incomplete)).toMatchObject({ outcome: "Blocked", reason: expect.stringContaining("provider_failure") });
	});

	it("blocks a foreign approver capture before panel approval", async () => {
		const values = await fixture();
		values.useForeignApproverCapture();
		const result = await run(values);
		expect(result).toMatchObject({ outcome: "Blocked", reason: expect.stringContaining("subject_drift") });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
		await expect(readdir(join(values.ref.directory, "artifacts/approved-designs"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("blocks post-approval drift without referencing the orphaned approved record", async () => {
		const values = await fixture();
		values.driftAfterApprovedRecord();
		const result = await run(values);
		expect(result).toMatchObject({ outcome: "Blocked", reason: expect.stringContaining("drifted") });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/design.json"), "utf8"));
		expect(artifact).toMatchObject({ proposedOutcome: "Blocked", authoritative: false });
		expect(artifact.approvedDesignId).toBeUndefined();
	});

	it("lets Pause supersede an approved intermediate record", async () => {
		const values = await fixture();
		values.pauseAfterApprovedRecord();
		await expect(run(values)).rejects.toBeInstanceOf(ControlAcceptedError);
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Paused" });
		expect((await readdir(join(values.ref.directory, "artifacts/approved-designs"))).length).toBeGreaterThan(0);
	});

	it("settles Blocked before surfacing a diagnostic write failure", async () => {
		const values = await fixture();
		values.setPanelFailure();
		values.failOutputWrite();
		await expect(run(values)).rejects.toThrow("design output write failed");
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
	});
});
