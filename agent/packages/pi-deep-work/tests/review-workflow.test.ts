import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGateway, AgentSettlement } from "../src/agents/gateway.ts";
import type { ReviewReport } from "../src/agents/schemas.ts";
import { ControlAcceptedError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import {
	ObservedDiffPreconditionError,
	type BackendObservationSnapshot,
	type BackendTreeService,
} from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { ReviewPanel } from "../src/review/panel.ts";
import { RunStore } from "../src/store/run-store.ts";
import type { DetectedRepository } from "../src/vcs/types.ts";
import { runReviewWorkflow } from "../src/workflows/review.ts";

const temporary: string[] = [];
const reviewerModels = ["test/claude-opus-4.8", "test/claude-opus-5.0"];

function policy() {
	return resolvePolicy(
		decodeMachinePolicy({
			schemaVersion: 1,
			models: {
				gpt: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
				opusReviewers: reviewerModels.map((model) => ({
					provider: "test",
					id: model.slice("test/".length),
					thinkingLevel: "max",
				})),
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

function snapshot(kind: "git" | "jj", workingDigest = "c".repeat(64)): BackendObservationSnapshot {
	if (kind === "git") {
		return {
			kind: "git",
			treeId: "3".repeat(40),
			observation: {
				schemaVersion: 1,
				kind: "git",
				repositoryId: "a".repeat(64),
				root: "/repo",
				policyDigest: "b".repeat(64),
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
			policyDigest: "b".repeat(64),
			workingDigest,
			changedPathsDigest: "d".repeat(64),
			operationId: "op-1",
			workspaceId: "default",
			changeId: "4".repeat(32),
			commitId: "5".repeat(64),
			parentCommitIds: ["6".repeat(64)],
			conflicted: false,
		},
	};
}

function cleanReport(): ReviewReport {
	return { status: "ok", summary: "reviewed", citations: [], verdict: "approve", findings: [] };
}

function changesReport(id: string): ReviewReport {
	return {
		status: "ok",
		summary: "changes required",
		citations: [],
		verdict: "changes_required",
		findings: [
			{
				id,
				severity: "important",
				title: "Important issue",
				detail: "Concrete problem",
				path: "value.ts",
				line: 1,
				evidence: ["exact diff"],
				recommendation: "Fix it",
			},
		],
	};
}

async function fixture(kind: "git" | "jj" = "git") {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-review-"));
	temporary.push(root);
	const store = new RunStore(root);
	const leases = new PortableLeaseManager(root);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "review" as const,
		repositoryId: "a".repeat(64),
		policyDigest: "b".repeat(64),
		goal: "review intent",
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
			leases,
			ref,
			repository,
			attemptId: attemptId(randomUUID()),
			phase: "review",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	let panelInvoked = false;
	let capturesAfterPanelInvocation = 0;
	let driftStage: "next-panel-boundary" | "after-panel-boundary" | undefined;
	let renderError: Error | undefined;
	let patch = "diff --git a/value.ts b/value.ts\n+const value = true;\n";
	const trees = {
		captureObservation: async () => {
			// A complete panel uses capture 1 in its callback and capture 2 at the workflow boundary; an early incomplete panel skips the callback.
			if (panelInvoked) capturesAfterPanelInvocation++;
			const drifted =
				driftStage === "next-panel-boundary"
					? capturesAfterPanelInvocation >= 1
					: driftStage === "after-panel-boundary"
						? capturesAfterPanelInvocation >= 2
						: false;
			return drifted ? snapshot(kind, "f".repeat(64)) : snapshot(kind);
		},
		renderObservedDiff: async () => {
			if (renderError) throw renderError;
			return {
				kind,
				baseRevision: kind === "git" ? "1".repeat(40) : "6".repeat(64),
				patch,
				paths: patch ? ["value.ts"] : [],
				diffDigest: createHash("sha256").update(patch).digest("hex"),
			};
		},
	} as unknown as BackendTreeService;
	let plannerStatus: "ok" | "blocked" | "failed" = "ok";
	let plannerError: Error | undefined;
	let reports: readonly ReviewReport[] = [cleanReport(), cleanReport()];
	let panelFailure = false;
	let pauseWithPanelResult = false;
	let boundAuthority = authority;
	const reviewTasks: string[] = [];
	const gateway = {
		assertAuthority(value: RunAuthority) {
			if (value !== boundAuthority) throw new Error("AgentGateway is bound to another RunAuthority");
		},
		run: async () => {
			if (plannerError) throw plannerError;
			return {
				report: {
				value: {
					status: plannerStatus,
					summary: plannerStatus,
					citations: [],
					interpretation: "intent",
					successCriteria: ["correctness"],
					steps: ["review exact diff"],
				},
				},
			};
		},
		runManySettled: async (jobs: Array<{ task: string }>) => {
			panelInvoked = true;
			reviewTasks.push(...jobs.map((job) => job.task));
			if (pauseWithPanelResult) {
				pauseWithPanelResult = false;
				await store.appendControl(ref, "Pause", "2026-08-25T00:00:01.500Z");
			}
			if (panelFailure) return [{ ok: false, error: "reviewer unavailable" }];
			return reports.map((report, index) => ({
				ok: true,
				result: {
					kind: "review-code",
					role: "code-reviewer",
					model: reviewerModels[index],
					turns: 1,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
					report: { source: "untrusted-agent", value: report },
				},
			})) as AgentSettlement<"review-code">[];
		},
		runSettled: async () => ({ ok: false, error: "adjudication unavailable" }),
	} as unknown as AgentGateway;
	const panel = new ReviewPanel(gateway, store, ref, policy());
	const originalWriteArtifact = store.writeArtifact.bind(store);
	let pauseAfterWrite = false;
	let failOutputWrite = false;
	store.writeArtifact = async (...args) => {
		if (failOutputWrite && args[1] === "outputs/review.json") throw new Error("review diagnostic write failed");
		const result = await originalWriteArtifact(...args);
		if (pauseAfterWrite && args[1] === "outputs/review.json") {
			pauseAfterWrite = false;
			await store.appendControl(ref, "Pause", "2026-08-25T00:00:01.500Z");
		}
		return result;
	};
	return {
		root,
		store,
		ref,
		authority,
		gateway,
		trees,
		panel,
		reviewTasks,
		setReports(value: readonly ReviewReport[]) {
			reports = value;
		},
		setPanelFailure() {
			panelFailure = true;
		},
		setPlannerStatus(value: "ok" | "blocked" | "failed") {
			plannerStatus = value;
		},
		setPlannerError(error: Error) {
			plannerError = error;
		},
		setDriftStage(value: "next-panel-boundary" | "after-panel-boundary") {
			driftStage = value;
		},
		setRenderError(error: Error) {
			renderError = error;
		},
		setEmptyPatch() {
			patch = "";
		},
		bindForeignAuthority() {
			boundAuthority = {} as RunAuthority;
		},
		pauseAfterProvisionalWrite() {
			pauseAfterWrite = true;
		},
		pauseBeforeBlockedSettlement() {
			pauseWithPanelResult = true;
		},
		failReviewOutputWrite() {
			failOutputWrite = true;
		},
	};
}

async function run(values: Awaited<ReturnType<typeof fixture>>) {
	return runReviewWorkflow({
		origin: userOriginFromRegisteredCommand("Review for correctness"),
		authority: values.authority,
		gateway: values.gateway,
		trees: values.trees,
		panel: values.panel,
		store: values.store,
		ref: values.ref,
		completedAt: "2026-08-25T00:00:02.000Z",
	});
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("review workflow", () => {
	for (const kind of ["git", "jj"] as const) {
		it(`publishes a complete approved ${kind} review`, async () => {
			const values = await fixture(kind);
			const result = await run(values);
			expect(result).toMatchObject({ outcome: "ReviewApproved", findings: [] });
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "ReviewApproved" });
			const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/review.json"), "utf8"));
			expect(artifact).toMatchObject({
				proposedOutcome: "ReviewApproved",
				authoritative: false,
				lifecycleAuthority: "state.json",
				paths: ["value.ts"],
				panel: { recordPath: expect.stringContaining("reviews/"), artifactPath: expect.stringContaining("reviews/") },
			});
			expect(values.reviewTasks).toHaveLength(2);
			expect(
				values.reviewTasks.every(
					(task) =>
						task.includes("+const value = true;") &&
						task.includes("Review for correctness") &&
						task.includes('"interpretation":"intent"'),
				),
			).toBe(true);
		});
	}

	it("records a complete unapproved panel as ChangesRequired", async () => {
		const values = await fixture();
		values.setReports([changesReport("one"), cleanReport()]);
		const result = await run(values);
		expect(result).toMatchObject({
			outcome: "ChangesRequired",
			findings: [{ id: "r1:one", reviewerId: reviewerModels[0], severity: "important" }],
		});
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "ChangesRequired" });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/review.json"), "utf8"));
		expect(artifact.proposedOutcome).toBe("ChangesRequired");
	});

	it("blocks on an incomplete panel and preserves its diagnostics", async () => {
		const values = await fixture();
		values.setPanelFailure();
		const result = await run(values);
		expect(result).toMatchObject({ outcome: "Blocked", reason: expect.stringContaining("provider_failure") });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/review.json"), "utf8"));
		expect(artifact.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ cause: "provider_failure" })]));

		const raced = await fixture();
		raced.setPanelFailure();
		raced.setDriftStage("next-panel-boundary");
		expect(await run(raced)).toMatchObject({ outcome: "Blocked", reason: expect.stringContaining("subject_drift") });
		const racedArtifact = JSON.parse(
			await readFile(join(raced.ref.directory, "artifacts/outputs/review.json"), "utf8"),
		);
		expect(racedArtifact.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ cause: "provider_failure" }),
				expect.objectContaining({ cause: "subject_drift" }),
			]),
		);
		expect(racedArtifact.beforeSubjectDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(racedArtifact.afterSubjectDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("pins panel-time drift to incomplete and post-panel drift to typed Blocked evidence", async () => {
		const panelDrift = await fixture();
		panelDrift.setDriftStage("next-panel-boundary");
		expect(await run(panelDrift)).toMatchObject({ outcome: "Blocked", reason: "Review panel incomplete: subject_drift" });
		const panelArtifact = JSON.parse(
			await readFile(join(panelDrift.ref.directory, "artifacts/outputs/review.json"), "utf8"),
		);
		expect(panelArtifact.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ cause: "subject_drift" })]));

		const postPanelDrift = await fixture();
		postPanelDrift.setDriftStage("after-panel-boundary");
		expect(await run(postPanelDrift)).toMatchObject({ outcome: "Blocked", reason: expect.stringContaining("drifted") });
		const driftArtifact = JSON.parse(
			await readFile(join(postPanelDrift.ref.directory, "artifacts/outputs/review.json"), "utf8"),
		);
		expect(driftArtifact.beforeSubjectDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(driftArtifact.afterSubjectDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("maps preconditions and planner statuses truthfully", async () => {
		const precondition = await fixture();
		precondition.setRenderError(new ObservedDiffPreconditionError("explicit base required"));
		expect(await run(precondition)).toMatchObject({ outcome: "Blocked", reason: "explicit base required" });
		const empty = await fixture();
		empty.setEmptyPatch();
		expect(await run(empty)).toMatchObject({ outcome: "Blocked", reason: "No diff to review" });
		for (const status of ["blocked", "failed"] as const) {
			const values = await fixture();
			values.setPlannerStatus(status);
			expect(await run(values)).toMatchObject({ outcome: status === "blocked" ? "Blocked" : "Failed" });
		}
	});

	it("separately enforces gateway-to-authority binding", async () => {
		const values = await fixture();
		values.bindForeignAuthority();
		expect(await run(values)).toMatchObject({ outcome: "Failed", reason: "AgentGateway is bound to another RunAuthority" });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
	});

	it("propagates Pause after provisional publication", async () => {
		const values = await fixture();
		values.pauseAfterProvisionalWrite();
		await expect(run(values)).rejects.toBeInstanceOf(ControlAcceptedError);
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Paused" });
	});

	it("settles lifecycle before surfacing diagnostic write failures", async () => {
		const incomplete = await fixture();
		incomplete.setPanelFailure();
		incomplete.failReviewOutputWrite();
		await expect(run(incomplete)).rejects.toThrow("review diagnostic write failed");
		expect(await incomplete.store.load(incomplete.ref)).toMatchObject({ lifecycle: "Blocked" });

		const drift = await fixture();
		drift.setDriftStage("after-panel-boundary");
		drift.failReviewOutputWrite();
		await expect(run(drift)).rejects.toThrow("review diagnostic write failed");
		expect(await drift.store.load(drift.ref)).toMatchObject({ lifecycle: "Blocked" });

		const technical = await fixture();
		technical.setPlannerError(new Error("planner transport failed"));
		technical.failReviewOutputWrite();
		await expect(run(technical)).rejects.toThrow("review diagnostic write failed");
		expect(await technical.store.load(technical.ref)).toMatchObject({ lifecycle: "Failed" });
	});

	it("lets a Pause supersede incomplete-panel settlement", async () => {
		const values = await fixture();
		values.setPanelFailure();
		values.pauseBeforeBlockedSettlement();
		await expect(run(values)).rejects.toBeInstanceOf(ControlAcceptedError);
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Paused" });
	});
});
