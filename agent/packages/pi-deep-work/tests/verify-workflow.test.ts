import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGateway } from "../src/agents/gateway.ts";
import { ControlAcceptedError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import { TrustedCommandCatalog } from "../src/gates/catalog.ts";
import { GateExecutor } from "../src/gates/executor.ts";
import type { BackendObservationSnapshot, BackendTreeService } from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy, type ResolvedPolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { RunStore } from "../src/store/run-store.ts";
import type { ObservationSubject } from "../src/subject/types.ts";
import type { DetectedRepository } from "../src/vcs/types.ts";
import { runVerifyWorkflow } from "../src/workflows/verify.ts";

const temporary: string[] = [];
type CommandOutcome = "pass" | "fail" | "timeout";

function policyFor(outcomes: readonly CommandOutcome[]): ResolvedPolicy {
	const observations = outcomes.map((outcome, index) => ({
		id: `observation-${index + 1}`,
		claimKeys: [`claim.${index + 1}`],
		argv:
			outcome === "pass"
				? [process.execPath, "-e", "process.exit(0)"]
				: outcome === "fail"
					? [process.execPath, "-e", "process.exit(1)"]
					: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
		timeoutMs: outcome === "timeout" ? 1_000 : 2_000,
	}));
	return resolvePolicy(
		decodeMachinePolicy({
			schemaVersion: 2,
			models: {
				orchestrator: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
				reviewers: [{ provider: "test", id: "claude-opus-4-8", thinkingLevel: "max" }],
			},
			concurrency: 1,
			maxRepairRounds: 0,
			commandTimeoutMs: 2_000,
			minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			observations,
			verificationContracts: [
				{
					id: "feature-works",
					claim: "feature works",
					requiredClaimKeys: observations.map((observation) => observation.claimKeys[0]),
					observationIds: observations.map((observation) => observation.id),
				},
			],
			selectors: [],
		}),
	);
}

function snapshot(
	kind: "git" | "jj",
	root: string,
	policyDigest: string,
	workingDigest = "c".repeat(64),
	conflicted = false,
): BackendObservationSnapshot {
	if (kind === "git") {
		const common = {
			schemaVersion: 1 as const,
			kind: "git" as const,
			repositoryId: "a".repeat(64),
			root,
			policyDigest,
			workingDigest,
			changedPathsDigest: "d".repeat(64),
			headOid: "1".repeat(40),
			symbolicRef: "refs/heads/main",
		};
		return conflicted
			? { kind: "git", treeId: null, observation: { ...common, conflicted: true, indexEntriesDigest: "2".repeat(64) } }
			: { kind: "git", treeId: "3".repeat(40), observation: { ...common, conflicted: false, indexTree: "2".repeat(40) } };
	}
	return {
		kind: "jj",
		treeDigest: "3".repeat(64),
		observation: {
			schemaVersion: 1,
			kind: "jj",
			repositoryId: "a".repeat(64),
			root,
			policyDigest,
			workingDigest,
			changedPathsDigest: "d".repeat(64),
			operationId: workingDigest === "c".repeat(64) ? "op-1" : "op-2",
			workspaceId: "default",
			changeId: "4".repeat(32),
			commitId: workingDigest === "c".repeat(64) ? "5".repeat(64) : "7".repeat(64),
			parentCommitIds: ["6".repeat(64)],
			conflicted,
		},
	};
}

async function fixture(options: {
	kind?: "git" | "jj";
	outcomes?: readonly CommandOutcome[];
	driftAfterFirst?: boolean;
	foreignAtCommandStart?: boolean;
	conflicted?: boolean;
	cancelAfterReceipt?: boolean;
	cancelAfterOutput?: boolean;
} = {}) {
	const kind = options.kind ?? "git";
	const outcomes = options.outcomes ?? ["pass"];
	const root = await mkdtemp(join(tmpdir(), "pi-deep-verify-"));
	temporary.push(root);
	const policy = policyFor(outcomes);
	const store = new RunStore(root);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "verify" as const,
		repositoryId: "a".repeat(64),
		policyDigest: policy.digest,
		goal: "feature works",
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
					root,
					sharedRoot: join(root, ".git"),
					commonDir: join(root, ".git"),
					repositoryId: initial.repositoryId,
				}
			: {
					kind: "jj",
					root,
					sharedRoot: join(root, ".jj/repo"),
					gitStore: join(root, ".jj/repo/store/git"),
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
			phase: "verify",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	const initialSnapshot = snapshot(kind, root, policy.digest, "c".repeat(64), options.conflicted);
	const changedSnapshot = snapshot(kind, root, policy.digest, "f".repeat(64), options.conflicted);
	const trees = { captureObservation: async () => initialSnapshot } as unknown as BackendTreeService;
	let rawCaptureCount = 0;
	const captureSubject = async (): Promise<ObservationSubject> => {
		rawCaptureCount++;
		return options.foreignAtCommandStart || (options.driftAfterFirst && rawCaptureCount >= 2)
			? changedSnapshot.observation
			: initialSnapshot.observation;
	};
	const executor = new GateExecutor(authority, store, ref, kind, captureSubject);
	const catalog = await TrustedCommandCatalog.build(policy, root);
	let modelCalls = 0;
	const gateway = {
		assertAuthority(value: RunAuthority) {
			if (value !== authority) throw new Error("wrong authority");
		},
		run: async () => {
			modelCalls++;
			throw new Error("verify must not invoke a model");
		},
	} as unknown as AgentGateway;
	if (options.cancelAfterReceipt) {
		const original = store.writeImmutableArtifact.bind(store);
		let requested = false;
		store.writeImmutableArtifact = async (...args) => {
			const result = await original(...args);
			if (!requested && args[1].startsWith("receipts/")) {
				requested = true;
				await store.appendControl(ref, "Cancel", "2026-08-25T00:00:01.500Z");
			}
			return result;
		};
	}
	let failOutputWrite = false;
	let outputCancelRequested = false;
	const originalWrite = store.writeArtifact.bind(store);
	store.writeArtifact = async (...args) => {
		if (failOutputWrite && args[1] === "outputs/verify.json") throw new Error("verify output write failed");
		const result = await originalWrite(...args);
		if (options.cancelAfterOutput && !outputCancelRequested && args[1] === "outputs/verify.json") {
			outputCancelRequested = true;
			await store.appendControl(ref, "Cancel", "2026-08-25T00:00:01.750Z");
		}
		return result;
	};
	return {
		root,
		policy,
		store,
		ref,
		authority,
		gateway,
		trees,
		executor,
		catalog,
		modelCalls: () => modelCalls,
		failOutputWrite() {
			failOutputWrite = true;
		},
	};
}

async function run(values: Awaited<ReturnType<typeof fixture>>, claim = "  feature   works ") {
	return runVerifyWorkflow({
		origin: userOriginFromRegisteredCommand(claim),
		policy: values.policy,
		catalog: values.catalog,
		authority: values.authority,
		gateway: values.gateway,
		trees: values.trees,
		executor: values.executor,
		store: values.store,
		ref: values.ref,
		repositoryKind: values.ref.backend,
		completedAt: "2026-08-25T00:00:02.000Z",
	});
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("standalone verify workflow", () => {
	for (const [kind, conflicted] of [
		["git", false],
		["jj", false],
		["git", true],
	] as const) {
		it(`verifies a ${conflicted ? "conflicted " : ""}${kind} observation without invoking a model`, async () => {
			const values = await fixture({ kind, conflicted });
			const result = await run(values);
			expect(result.outcome).toBe("Verified");
			expect(values.modelCalls()).toBe(0);
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "Verified" });
			const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/verify.json"), "utf8"));
			expect(artifact).toMatchObject({
				proposedOutcome: "Verified",
				authoritative: false,
				assertionScope: "observed-subject",
				approvedDesignSeal: false,
				normalizedClaim: "feature works",
				policyDigest: values.policy.digest,
				contract: { kind: "standalone-verification-contract", observationIds: ["observation-1"] },
				record: { verdict: "Verified", receiptRefs: [expect.objectContaining({ receiptId: expect.any(String) })] },
			});
		});
	}

	it("runs the complete contract and gives failure precedence over passing evidence", async () => {
		const values = await fixture({ outcomes: ["fail", "pass"] });
		const result = await run(values);
		expect(result.outcome).toBe("NotVerified");
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/verify.json"), "utf8"));
		expect(artifact.executions).toMatchObject([
			{ commandId: "observation-1", outcome: "failed" },
			{ commandId: "observation-2", outcome: "passed" },
		]);
		expect(artifact.record).toMatchObject({ verdict: "NotVerified", coveredClaimKeys: ["claim.2"] });
	});

	it("returns Inconclusive for a timed-out trusted observation", async () => {
		const values = await fixture({ outcomes: ["timeout"] });
		expect(await run(values)).toMatchObject({ outcome: "Inconclusive" });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "Inconclusive" });
	});

	it("stops after subject drift and blocks with exact digests", async () => {
		const values = await fixture({ outcomes: ["pass", "pass"], driftAfterFirst: true });
		const result = await run(values);
		expect(result).toMatchObject({ outcome: "Blocked", reason: expect.stringContaining("drifted") });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/verify.json"), "utf8"));
		expect(artifact.beforeSubjectDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(artifact.afterSubjectDigest).toMatch(/^[0-9a-f]{64}$/);
		const commandDirectories = await readdir(join(values.ref.directory, "artifacts/commands"));
		expect(commandDirectories).toHaveLength(1);
	});

	it("blocks when the command starts from a subject foreign to the initial observation", async () => {
		const values = await fixture({ foreignAtCommandStart: true });
		const result = await run(values);
		expect(result).toMatchObject({ outcome: "Blocked", reason: expect.stringContaining("drifted") });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/verify.json"), "utf8"));
		expect(artifact.beforeSubjectDigest).not.toBe(artifact.afterSubjectDigest);
	});

	it("blocks when the exact normalized claim has no trusted contract", async () => {
		const values = await fixture();
		expect(await run(values, "another claim")).toMatchObject({
			outcome: "Blocked",
			reason: "No trusted verification contract matches the exact claim",
		});
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
	});

	it("leaves an early receipt inert when a later Cancel prevents a run-level verdict", async () => {
		const values = await fixture({ outcomes: ["pass", "pass"], cancelAfterReceipt: true });
		await expect(run(values)).rejects.toBeInstanceOf(ControlAcceptedError);
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Cancelled" });
		expect(await readdir(join(values.ref.directory, "artifacts/receipts"))).toHaveLength(1);
		await expect(readFile(join(values.ref.directory, "artifacts/outputs/verify.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps a last-moment Verified proposal non-authoritative when Cancel wins", async () => {
		const values = await fixture({ cancelAfterOutput: true });
		await expect(run(values)).rejects.toBeInstanceOf(ControlAcceptedError);
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Cancelled" });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/verify.json"), "utf8"));
		expect(artifact).toMatchObject({ proposedOutcome: "Verified", authoritative: false, lifecycleAuthority: "state.json" });
	});

	it("settles Blocked before surfacing a diagnostic write failure", async () => {
		const values = await fixture();
		values.failOutputWrite();
		await expect(run(values, "another claim")).rejects.toThrow("verify output write failed");
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
	});
});
