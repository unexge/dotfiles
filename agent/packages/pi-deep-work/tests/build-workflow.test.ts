import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGateway } from "../src/agents/gateway.ts";
import { WritePreflight } from "../src/application/begin-write.ts";
import { ImplementationAgentStatusError } from "../src/application/implementation-agent.ts";
import { MutationRecoveryRequiredError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import { TrustedCommandCatalog } from "../src/gates/catalog.ts";
import type { BackendTreeService } from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { canonicalDigest } from "../src/policy/canonical-json.ts";
import { decodeMachinePolicy, decodeProjectPolicy } from "../src/policy/schemas.ts";
import { approvedDesignIdFor, type ApprovedDesignRecord } from "../src/review/design.ts";
import type { DesignHandoff } from "../src/review/design-handoff.ts";
import { noBehaviorContractDigest, reviewSubjectDigest } from "../src/review/subjects.ts";
import { RunStore } from "../src/store/run-store.ts";
import type { GitRepository } from "../src/vcs/types.ts";
import { observationSubjectDigest } from "../src/subject/content.ts";
import { runBuildWorkflow } from "../src/workflows/build.ts";

const temporary: string[] = [];

function policy() {
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
			minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			observations: [{ id: "behavior", claimKeys: ["behavior.ok"], argv: ["true"], timeoutMs: 1_000 }],
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

function designReport(status: "ok" | "blocked" | "failed" = "ok") {
	return {
		status,
		summary: "design",
		citations: [],
		usage: "caller usage",
		constraints: ["constraint"],
		decisions: [{ decision: "decision", rationale: "rationale" }],
		dataShape: "data shape",
		interfaces: ["interface"],
		modules: ["module"],
		invariants: ["invariant"],
		alternatives: [],
		tradeoffs: [],
		verification: ["verification"],
		openQuestions: [],
		testSelectors: [{ selectorId: "rust-path", value: "tests/behavior.rs" }],
	};
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-build-"));
	temporary.push(root);
	const resolved = policy();
	const store = new RunStore(root);
	const repository: GitRepository = {
		kind: "git",
		root,
		sharedRoot: join(root, ".git"),
		commonDir: join(root, ".git"),
		repositoryId: "a".repeat(64),
	};
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "build" as const,
		repositoryId: repository.repositoryId,
		policyDigest: resolved.digest,
		goal: "build",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create("git", initial);
	const authority = await RunAuthority.start(
		{
			store,
			leases: new PortableLeaseManager(root),
			ref,
			repository,
			attemptId: attemptId(randomUUID()),
			phase: "build",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	let dirty = false;
	const observation = () => ({
		schemaVersion: 1 as const,
		kind: "git" as const,
		repositoryId: repository.repositoryId,
		root,
		policyDigest: resolved.digest,
		workingDigest: dirty ? "f".repeat(64) : "c".repeat(64),
		changedPathsDigest: dirty ? "e".repeat(64) : "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
		headOid: "1".repeat(40),
		symbolicRef: "refs/heads/main",
		conflicted: false as const,
		indexTree: "2".repeat(40),
	});
	const snapshot = () => ({ kind: "git" as const, treeId: dirty ? "3".repeat(40) : "2".repeat(40), observation: observation() });
	const trees = {
		assertContext: vi.fn(),
		captureObservation: async () => snapshot(),
	} as unknown as BackendTreeService;
	const runner = async (_command: string, args: readonly string[]) => ({
		code: 0,
		stdout: args.some((arg) => arg.endsWith("^{tree}")) ? `${"2".repeat(40)}\n` : `${"1".repeat(40)}\n`,
		stderr: "",
	});
	const preflight = new WritePreflight(authority, trees, repository, resolved, runner);
	let frameStatus: "ok" | "blocked" | "failed" = "ok";
	let designStatus: "ok" | "blocked" | "failed" = "ok";
	const tasks: string[] = [];
	const gateway = {
		assertAuthority(value: RunAuthority) {
			if (value !== authority) throw new Error("wrong authority");
		},
		run: async (job: { kind: string; task: string }) => {
			tasks.push(job.task);
			return job.kind === "plan"
				? {
						report: {
							value: {
								status: frameStatus,
								summary: "frame",
								citations: [],
								interpretation: "goal",
								successCriteria: ["works"],
								steps: ["implement"],
							},
						},
					}
				: { report: { value: designReport(designStatus) } };
		},
	} as unknown as AgentGateway;
	const catalog = await TrustedCommandCatalog.build(resolved, root);
	let approvalMode: "approved" | "changes" | "blocked" = "approved";
	const approve = vi.fn(async (input: { design: string; sourceDesign?: { runId: string; approvedDesignId: string; artifactDigest: string } }) => {
		if (approvalMode === "blocked") {
			return { status: "Blocked" as const, diagnostics: [{ cause: "provider_failure" as const, retryable: true, detail: "down" }] };
		}
		const designDigest = createHash("sha256").update(input.design).digest("hex");
		const contractCore = {
			schemaVersion: 1 as const,
			selectors: [{ selectorId: "rust-path", value: "tests/behavior.rs", observationId: "behavior" }],
			observationIds: ["behavior"],
			claimKeys: ["behavior.ok"],
		};
		const contract = { ...contractCore, id: canonicalDigest(contractCore) };
		const reviewSubject = {
			schemaVersion: 1 as const,
			kind: "behavior-design" as const,
			observation: observation(),
			designDigest,
			behaviorContractDigest: contract.id,
		};
		if (approvalMode === "changes") {
			return {
				status: "ChangesRequired" as const,
				findings: [{ id: "r1:gap", reviewerId: "opus", severity: "important" as const, title: "Gap", detail: "Fix" }],
				reviewSubject,
				subjectDigest: reviewSubjectDigest(reviewSubject),
			};
		}
		const reviewDigest = reviewSubjectDigest(reviewSubject);
		const panelDigest = "e".repeat(64);
		return {
			status: "Approved" as const,
			findings: [],
			record: {
				schemaVersion: 1 as const,
				approvedDesignId: approvedDesignIdFor({
					reviewSubjectDigest: reviewDigest,
					panelArtifactDigest: panelDigest,
					designDigest,
					behaviorDigest: contract.id,
					...(input.sourceDesign ? { sourceDesignDigest: canonicalDigest(input.sourceDesign) } : {}),
				}),
				caller: "build" as const,
				reviewSubject,
				reviewSubjectDigest: reviewDigest,
				design: { artifactPath: "approved/design.json", artifactDigest: designDigest },
				behavior: { kind: "contract" as const, digest: contract.id, contract, artifactPath: "approved/behavior.json", artifactDigest: "c".repeat(64) },
				panel: { recordPath: "reviews/record", recordDigest: "d".repeat(64), artifactPath: "reviews/panel", artifactDigest: panelDigest },
				approvedAt: "2026-08-25T00:00:02.000Z",
				...(input.sourceDesign ? { sourceDesign: input.sourceDesign } : {}),
			},
		};
	});
	const approver = { assertRun: vi.fn(), approve } as unknown as import("../src/application/approve-design.ts").DesignApprover;
	let implementationMode: "ok" | "blocked" | "failed" | "manual" | "manual-generic" = "ok";
	const implementation = {
		assertRun: vi.fn(),
		implement: vi.fn(async () => {
			if (implementationMode === "manual" || implementationMode === "manual-generic") {
				await authority.manualInspection("partial implementation", "2026-08-25T00:00:03.000Z");
				if (implementationMode === "manual") throw new MutationRecoveryRequiredError("partial implementation");
				throw new Error("manual state persisted before an unrelated reporting error");
			}
			if (implementationMode === "blocked" || implementationMode === "failed") {
				throw new ImplementationAgentStatusError(implementationMode);
			}
			dirty = true;
			const state = await store.load(ref);
			if (state.lifecycle !== "Active") throw new Error("expected active");
			return {
				report: { status: "ok", summary: "implemented", citations: [], changes: [{ path: "value.rs", detail: "added" }], testSelectors: [] },
				checkpoint: {
					schemaVersion: 1,
					runId: ref.runId,
					attemptId: state.attemptId,
					sequence: 1,
					phase: "implement",
					policyDigest: resolved.digest,
					subjectDigest: observationSubjectDigest(observation()),
					eventRevision: state.lastEventRevision,
					controlRevision: 0,
					createdAt: "2026-08-25T00:00:03.000Z",
					mutation: {
						artifact: "mutations/implement.json",
						artifactDigest: "c".repeat(64),
						mutationDigest: "d".repeat(64),
						fileCount: 1,
					},
				},
			};
		}),
	} as unknown as import("../src/application/implementation-agent.ts").ImplementationAgent;
	let qualification: import("../src/application/qualify-and-commit.ts").QualificationResult = { status: "Committed", commitId: "f".repeat(40) };
	const qualifier = {
		assertRun: vi.fn(),
		run: vi.fn(async () => {
			if (qualification.status === "Committed") {
				await store.writeArtifact(ref, "transactions/fake/recorded.json", "{}");
				await authority.complete("LocalCommitCreated", "transactions/fake/recorded.json", "2026-08-25T00:00:04.000Z");
			}
			return qualification;
		}),
	} as unknown as Qualifier;
	return {
		root,
		resolved,
		store,
		ref,
		authority,
		gateway,
		trees,
		preflight,
		approver,
		implementation,
		qualifier,
		catalog,
		approve,
		tasks,
		setFrameStatus(value: typeof frameStatus) {
			frameStatus = value;
		},
		setDesignStatus(value: typeof designStatus) {
			designStatus = value;
		},
		setApprovalMode(value: typeof approvalMode) {
			approvalMode = value;
		},
		setImplementationMode(value: typeof implementationMode) {
			implementationMode = value;
		},
		setQualification(value: typeof qualification) {
			qualification = value;
		},
	};
}

type Qualifier = import("../src/application/qualify-and-commit.ts").QualifyAndCommit;

async function approvedSource(
	values: Awaited<ReturnType<typeof fixture>>,
	drift = false,
): Promise<DesignHandoff> {
	const sourceReport = designReport();
	const sourceDigest = createHash("sha256").update(JSON.stringify(sourceReport)).digest("hex");
	const current = (await values.trees.captureObservation()).observation;
	const sourceObservation = drift ? { ...current, workingDigest: "0".repeat(64) } : current;
	return {
		runId: randomUUID(),
		goal: "Build the feature",
		design: sourceReport,
		designDigest: sourceDigest,
		findings: [],
		approvedDesign: {
			schemaVersion: 1,
			approvedDesignId: "9".repeat(64),
			caller: "design",
			reviewSubject: {
				schemaVersion: 1,
				kind: "standalone-design",
				observation: sourceObservation,
				designDigest: sourceDigest,
				behaviorContractDigest: noBehaviorContractDigest,
			},
			reviewSubjectDigest: "8".repeat(64),
			design: { artifactPath: "approved/design.json", artifactDigest: sourceDigest },
			behavior: { kind: "none", digest: noBehaviorContractDigest },
			panel: {
				recordPath: "reviews/record.json",
				recordDigest: "7".repeat(64),
				artifactPath: "reviews/panel.json",
				artifactDigest: "6".repeat(64),
			},
			approvedAt: "2026-08-25T00:00:01.000Z",
		},
	};
}

async function run(
	values: Awaited<ReturnType<typeof fixture>>,
	options: {
		sourceDesign?: DesignHandoff;
		designFeedback?: string;
		resolutionSource?: {
			runId: string;
			artifactDigest: string;
			design: ReturnType<typeof designReport>;
			findings: readonly { id: string; reviewerId: string; severity: "blocker" | "important" | "suggestion"; title: string; detail: string }[];
			feedback: string;
		};
	} = {},
) {
	return runBuildWorkflow({
		origin: userOriginFromRegisteredCommand("Build the feature"),
		policy: values.resolved,
		catalog: values.catalog,
		authority: values.authority,
		gateway: values.gateway,
		trees: values.trees,
		preflight: values.preflight,
		approver: values.approver,
		implementation: values.implementation,
		qualifier: values.qualifier,
		store: values.store,
		ref: values.ref,
		repositoryKind: "git",
		approvedAt: "2026-08-25T00:00:02.000Z",
		checkpointedAt: "2026-08-25T00:00:03.000Z",
		authorizedAt: "2026-08-25T00:00:04.000Z",
		completedAt: "2026-08-25T00:00:05.000Z",
		...options,
	});
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("build workflow", () => {
	it("derives the build design from an approved standalone design", async () => {
		const values = await fixture();
		const source = await approvedSource(values);
		await run(values, { sourceDesign: source, designFeedback: "Keep the existing owner." });
		expect(values.tasks.join("\n")).toContain("Keep the existing owner.");
		expect(values.tasks.join("\n")).toContain("Preserve its accepted decisions");
		expect(values.approve).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceDesign: {
					runId: source.runId,
					approvedDesignId: source.approvedDesign!.approvedDesignId,
					artifactDigest: source.designDigest,
				},
			}),
		);
	});

	it("carries a resolved rejected design into a fresh build review", async () => {
		const values = await fixture();
		await run(values, {
			resolutionSource: {
				runId: randomUUID(),
				artifactDigest: "8".repeat(64),
				design: designReport(),
				findings: [{ id: "r1:gap", reviewerId: "opus", severity: "blocker", title: "Gap", detail: "Fix ownership" }],
				feedback: "Keep ownership in the existing service.",
			},
		});
		expect(values.tasks.join("\n")).toContain("Prior rejected design");
		expect(values.tasks.join("\n")).toContain("Keep ownership in the existing service.");
	});

	it("blocks a build when the approved design observation drifted", async () => {
		const values = await fixture();
		const result = await run(values, { sourceDesign: await approvedSource(values, true) });
		expect(result).toMatchObject({ status: "Blocked", reason: expect.stringContaining("drifted") });
		expect(values.implementation.implement).not.toHaveBeenCalled();
	});

	it("returns the backend-owned committed outcome without double completion", async () => {
		const values = await fixture();
		const result = await run(values);
		expect(result).toEqual({ status: "LocalCommitCreated", commitId: "f".repeat(40) });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
		await expect(readFile(join(values.ref.directory, "artifacts/outputs/build.json"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(values.approver.assertRun).toHaveBeenCalledTimes(1);
		expect(values.implementation.assertRun).toHaveBeenCalledTimes(1);
		expect(values.qualifier.assertRun).toHaveBeenCalledTimes(1);
		expect(values.qualifier.run).toHaveBeenCalledWith(expect.objectContaining({ checkpointSequence: 2 }));
		expect(values.approve.mock.calls[0][0]).not.toHaveProperty("selectorProposals");
	});

	for (const status of ["ChangesRequired", "NotVerified", "Inconclusive"] as const) {
		it(`completes the noncommit qualification outcome ${status}`, async () => {
			const values = await fixture();
			values.setQualification(status === "ChangesRequired" ? { status, findings: [] } : { status });
			const result = await run(values);
			expect(result.status).toBe(status);
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: status });
			const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/build.json"), "utf8"));
			expect(artifact).toMatchObject({
				proposedOutcome: status,
				authoritative: false,
				approvedDesignId: expect.stringMatching(/^[0-9a-f]{64}$/),
			});
		});
	}

	it("keeps behavior observation selection out of the build designer", async () => {
		const values = await fixture();

		await run(values);

		const designTask = values.tasks.find((task) => task.includes("Design the implementation"));
		expect(designTask).toContain("All configured behavior observations are coordinator-selected");
		expect(designTask).toContain("empty testSelectors array");
		expect(designTask).not.toContain('"selectorId"');
		expect(designTask).not.toContain('"observationId"');
		expect(designTask).not.toContain('"argv"');
	});

	it("completes design findings as ChangesRequired before mutation", async () => {
		const values = await fixture();
		values.setApprovalMode("changes");
		const result = await run(values);
		expect(result).toMatchObject({ status: "ChangesRequired", findings: [{ severity: "important" }] });
		expect(values.implementation.implement).not.toHaveBeenCalled();
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "ChangesRequired" });
		expect(await readFile(join(values.ref.directory, "artifacts/outputs/build.md"), "utf8")).toContain(
			`/deep resolve ${values.ref.runId.slice(0, 8)}`,
		);
	});

	it("maps frame, design, approval, implementation, and qualification failures", async () => {
		for (const [stage, status] of [
			["frame", "blocked"],
			["frame", "failed"],
			["design", "blocked"],
			["design", "failed"],
		] as const) {
			const values = await fixture();
			if (stage === "frame") values.setFrameStatus(status);
			else values.setDesignStatus(status);
			expect((await run(values)).status).toBe(status === "blocked" ? "Blocked" : "Failed");
		}
		const approval = await fixture();
		approval.setApprovalMode("blocked");
		expect((await run(approval)).status).toBe("Blocked");
		for (const status of ["blocked", "failed"] as const) {
			const values = await fixture();
			values.setImplementationMode(status);
			expect((await run(values)).status).toBe(status === "blocked" ? "Blocked" : "Failed");
		}
		const qualified = await fixture();
		qualified.setQualification({ status: "Blocked", reason: "quick gate failed" });
		expect(await run(qualified)).toMatchObject({ status: "Blocked", reason: "quick gate failed" });
	});

	it("preserves typed and generic already-settled manual-inspection outcomes", async () => {
		for (const mode of ["manual", "manual-generic"] as const) {
			const values = await fixture();
			values.setImplementationMode(mode);
			expect(await run(values)).toMatchObject({ status: "NeedsManualInspection" });
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "NeedsManualInspection" });
		}
	});
});
