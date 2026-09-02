import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGateway, AgentResult } from "../src/agents/gateway.ts";
import { DesignApprover } from "../src/application/approve-design.ts";
import { QualifyAndCommit } from "../src/application/qualify-and-commit.ts";
import { ControlAcceptedError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import {
	CommitAuthorization,
	assertCommitAuthorization,
	authorizeCommit,
	type AuthorizeCommitInput,
} from "../src/authorization/authorize.ts";
import { validateCommitMessage } from "../src/authorization/message.ts";
import { RedRegressionEvidence } from "../src/authorization/red-regression.ts";
import { TrustedCommandCatalog } from "../src/gates/catalog.ts";
import { GateExecutor } from "../src/gates/executor.ts";
import { GitTransactionService } from "../src/git/transaction.ts";
import { Normalizer } from "../src/gates/normalizer.ts";
import { BackendTreeService } from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { ReviewPanel } from "../src/review/panel.ts";
import { reviewSubjectDigest } from "../src/review/subjects.ts";
import { RunStore, type RunRef } from "../src/store/run-store.ts";
import { decode, VerificationRecordSchema } from "../src/store/schemas.ts";
import { evidenceSubjectDigest, observationSubjectDigest } from "../src/subject/content.ts";
import { captureGitObservation, gitStatus } from "../src/vcs/git-backend.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner } from "../src/vcs/types.ts";
import { createRepositoryFixture, isolatedVcsEnvironment } from "./helpers/repositories.ts";

const executeFile = promisify(execFile);
const temporary: string[] = [];
const now = "2026-08-25T00:00:01.000Z";

function policy() {
	return resolvePolicy(
		decodeMachinePolicy({
			schemaVersion: 2,
			models: {
				orchestrator: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
				reviewers: [{ provider: "test", id: "claude-opus-4.8", thinkingLevel: "max" }],
			},
			concurrency: 1,
			maxRepairRounds: 1,
			commandTimeoutMs: 10_000,
			minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: [process.execPath, "-e", "void 0"], timeoutMs: 2_000 }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: [process.execPath, "-e", "void 0"], timeoutMs: 2_000 }],
			observations: [
				{
					id: "behavior",
					claimKeys: ["behavior.ok"],
					argv: [process.execPath, "-e", "void 0"],
					timeoutMs: 2_000,
				},
			],
			verificationContracts: [],
			selectors: [
				{
					id: "behavior-path",
					language: "rust",
					observationId: "behavior",
					valuePattern: "[a-zA-Z0-9_./-]+\\.rs",
				},
			],
		}),
	);
}

function reviewAgent(kind: "review-design" | "review-code"): AgentResult<typeof kind> {
	return {
		kind,
		role: kind === "review-design" ? "design-reviewer" : "code-reviewer",
		model: "test/claude-opus-4.8",
		turns: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		report: {
			source: "untrusted-agent",
			value: { status: "ok", summary: "clean", citations: [], verdict: "approve", findings: [] },
		},
	};
}

async function setup() {
	const fixture = await createRepositoryFixture("git");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-authorization-"));
	temporary.push(agentDir);
	const commands: Array<{ command: string; args: readonly string[] }> = [];
	let commandInterceptor: ((command: string, args: readonly string[]) => Promise<void>) | undefined;
	const runner: CommandRunner = async (command, args, options) => {
		commands.push({ command, args });
		await commandInterceptor?.(command, args);
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
	if (repository.kind !== "git") throw new Error("expected Git");
	const resolved = policy();
	const store = new RunStore(agentDir);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "build" as const,
		repositoryId: repository.repositoryId,
		policyDigest: resolved.digest,
		goal: "authorize",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create("git", initial);
	const leases = new PortableLeaseManager(agentDir);
	const authority = await RunAuthority.start(
		{
			store,
			leases,
			ref,
			repository,
			attemptId: attemptId(randomUUID()),
			phase: "qualify",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		now,
	);
	const capture = () => captureGitObservation(repository, resolved.digest, runner);
	const catalog = await TrustedCommandCatalog.build(resolved, repository.root);
	const gateway = {
		runManySettled: vi.fn().mockImplementation(async (jobs: Array<{ kind: "review-design" | "review-code" }>) => [
			{ ok: true, result: reviewAgent(jobs[0].kind) },
		]),
		runSettled: vi.fn().mockResolvedValue({ ok: false, error: "use deterministic message fallback" }),
	} as unknown as AgentGateway;
	const panel = new ReviewPanel(gateway, store, ref, resolved);
	const approver = new DesignApprover(panel, catalog, store, ref, capture);
	const approved = await approver.approve({
		caller: "build",
		design: "approved design",
		userOrigin: userOriginFromRegisteredCommand("build behavior"),
		expectedObservationDigest: observationSubjectDigest(await capture()),
		selectorProposals: [{ selectorId: "behavior-path", value: "tests/behavior.rs" }],
		approvedAt: now,
	});
	if (approved.status !== "Approved") throw new Error("expected approved design");
	await fixture.write("implementation.rs", "fn implemented() {}\n");
	const trees = new BackendTreeService(authority, repository, resolved.digest, runner, join(agentDir, "scratch"));
	const normalization = await new Normalizer(authority, resolved, trees).runExactlyTwoPasses();
	const candidate = await trees.sealCandidate({
		normalization,
		approvedDesignId: approved.record.approvedDesignId,
		behaviorContractId: approved.record.behavior.digest,
	});
	if (candidate.kind !== "git") throw new Error("expected Git candidate");
	const executor = new GateExecutor(authority, store, ref, "git", capture);
	const quick = { command: catalog.gate("quick", "quick"), execution: await executor.run(catalog.gate("quick", "quick"), candidate) };
	const full = { command: catalog.gate("full", "full"), execution: await executor.run(catalog.gate("full", "full"), candidate) };
	const behaviorCommand = catalog.observation("behavior");
	const behavior = { command: behaviorCommand, execution: await executor.run(behaviorCommand, candidate) };
	if (!behavior.execution.receipt || !behavior.execution.receiptArtifact) throw new Error("expected behavior receipt");
	const patch = (
		await fixture.run("git", [
			"-c",
			"diff.algorithm=myers",
			"-c",
			"core.quotePath=false",
			"diff",
			"--binary",
			"--full-index",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--unified=3",
			candidate.observation.headOid,
			candidate.treeOid,
			"--",
		])
	).stdout;
	const codeSubject = { schemaVersion: 1 as const, kind: "candidate-code" as const, candidate };
	const codePanel = await panel.review({
		subject: codeSubject,
		frozenArtifact: patch,
		task: "Review candidate",
		recaptureSubjectDigest: async () => reviewSubjectDigest(codeSubject),
	});
	if (!codePanel.complete) throw new Error("expected code review");
	const receiptRef = {
		receiptId: behavior.execution.receipt.receiptId,
		artifactDigest: behavior.execution.receiptArtifact.digest,
	};
	const verification = decode(VerificationRecordSchema, {
		schemaVersion: 1,
		subjectDigest: evidenceSubjectDigest(candidate),
		contractId: approved.record.behavior.digest,
		coveredClaimKeys: ["behavior.ok"],
		verdict: "Verified",
		receiptRefs: [receiptRef],
	});
	const changedPaths = (await gitStatus(repository, runner)).changedPaths;
	return {
		input: {
			workflow: "build",
			candidate,
			candidateChangedPaths: changedPaths,
			approvedDesign: approved.record,
			quick: [quick],
			full: [full],
			behavior: [behavior],
			codeReview: { subject: codeSubject, panel: codePanel },
			verification,
			message: "Implement behavior\n\nAdd the approved implementation.",
			authorizedAt: "2026-08-25T00:00:02.000Z",
			catalog,
			policy: resolved,
		} satisfies AuthorizeCommitInput,
		authority,
		ref,
		store,
		leases,
		resolved,
		catalog,
		gateway,
		panel,
		approver,
		executor,
		normalizer: new Normalizer(authority, resolved, trees),
		repository,
		runner,
		trees,
		agentDir,
		fixture,
		commands,
		setCommandInterceptor(value: typeof commandInterceptor) {
			commandInterceptor = value;
		},
		cleanup: fixture.cleanup,
	};
}

async function acquireRecoveryGuard(values: Awaited<ReturnType<typeof setup>>) {
	await values.authority.abandonForRecovery().catch(() => undefined);
	return values.leases.acquireRecoveryGuard({
		repositoryId: values.repository.repositoryId,
		runId: values.ref.runId,
		attemptId: randomUUID(),
	});
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("commit authorization", () => {
	it("mints an immutable authorization from every same-candidate prerequisite", async () => {
		const values = await setup();
		try {
			const authorization = authorizeCommit(values.input);
			expect(() => assertCommitAuthorization(authorization)).not.toThrow();
			expect(authorization).toMatchObject({ workflow: "build", candidateDigest: evidenceSubjectDigest(values.input.candidate) });
			expect(() => assertCommitAuthorization({ ...authorization } as CommitAuthorization)).toThrow("not minted");
		} finally {
			await values.authority.cancel("done", "2026-08-25T00:00:03.000Z");
			await values.cleanup();
		}
	}, 60_000);

	it("rejects missing, foreign, unverified, unreviewed, and invalid-message prerequisites", async () => {
		const values = await setup();
		try {
			const quick = values.input.quick[0];
			const observationDigest = observationSubjectDigest(values.input.candidate.observation);
			for (const input of [
				{ ...values.input, quick: [] },
				{
					...values.input,
					quick: [
						{
							...quick,
							execution: {
								...quick.execution,
								record: { ...quick.execution.record, subject: values.input.candidate.observation, subjectDigest: observationDigest },
								receipt: quick.execution.receipt
									? { ...quick.execution.receipt, subject: values.input.candidate.observation, subjectDigest: observationDigest }
									: undefined,
							},
						},
					],
				},
				{
					...values.input,
					verification: {
						...values.input.verification,
						receiptRefs: [
							...values.input.verification.receiptRefs,
							{ receiptId: randomUUID(), artifactDigest: "f".repeat(64) },
						],
					},
				},
				{ ...values.input, verification: { ...values.input.verification, verdict: "NotVerified" } },
				{
					...values.input,
					codeReview: {
						...values.input.codeReview,
						panel: {
							...values.input.codeReview.panel,
							record: { ...values.input.codeReview.panel.record, approved: false },
						},
					},
				},
				{ ...values.input, message: "Bad\tmessage" },
			]) {
				expect(() => authorizeCommit(input as AuthorizeCommitInput)).toThrow();
			}
			const fixInput = {
				...values.input,
				workflow: "fix" as const,
				approvedDesign: { ...values.input.approvedDesign, caller: "fix" as const },
			};
			expect(() => authorizeCommit(fixInput)).toThrow("red-regression proof");
			expect(() => authorizeCommit({ ...values.input, redProof: {} as never })).toThrow("forbids");
		} finally {
			await values.authority.cancel("done", "2026-08-25T00:00:03.000Z");
			await values.cleanup();
		}
	}, 60_000);

	it("rejects direct construction and detects authorization mutation", async () => {
		expect(
			() =>
				new RedRegressionEvidence(
					Symbol("foreign") as never,
					{} as never,
					"a".repeat(64),
					[],
					"b".repeat(64),
					"observation",
					"c".repeat(64),
					[],
					{} as never,
				),
		).toThrow("lacks package authority");
		expect(
			() =>
				new CommitAuthorization(
					Symbol("fake") as never,
					"build",
					{} as never,
					"a".repeat(64),
					[],
					"b".repeat(64),
					"c".repeat(64),
					validateCommitMessage("Header"),
					[],
					[],
					[],
					"d".repeat(64),
					"e".repeat(64),
					null,
					now,
				),
		).toThrow("package authority");
	});
});

describe("shared qualifyAndCommit", () => {
	it("runs the fixed qualification order through one real Git commit", async () => {
		const values = await setup();
		const transaction = new GitTransactionService(
			values.authority,
			values.store,
			values.ref,
			values.repository,
			values.runner,
			join(values.agentDir, "git-qualify"),
		);
		const qualifier = new QualifyAndCommit(
			values.resolved,
			values.catalog,
			values.normalizer,
			values.trees,
			values.executor,
			values.panel,
			values.gateway,
			values.store,
			values.ref,
			{ kind: "git", service: transaction },
			null,
		);
		try {
			const result = await qualifier.run({
				workflow: "build",
				approvedDesign: values.input.approvedDesign,
				userOrigin: userOriginFromRegisteredCommand("build behavior"),
				checkpointSequence: 1,
				authorizedAt: "2026-08-25T00:00:02.000Z",
			});
			expect(result.status).toBe("Committed");
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
		} finally {
			await values.cleanup();
		}
	}, 45_000);

	it("blocks same-attempt restart when repair was interrupted before checkpoint", async () => {
		const values = await setup();
		const transaction = new GitTransactionService(
			values.authority,
			values.store,
			values.ref,
			values.repository,
			values.runner,
			join(values.agentDir, "git-qualify-interrupted"),
		);
		const qualifier = new QualifyAndCommit(
			values.resolved,
			values.catalog,
			values.normalizer,
			values.trees,
			values.executor,
			values.panel,
			values.gateway,
			values.store,
			values.ref,
			{ kind: "git", service: transaction },
			null,
		);
		try {
			const state = await values.store.load(values.ref);
			if (state.lifecycle !== "Active") throw new Error("expected Active run");
			await values.store.writeArtifact(
				values.ref,
				`qualification/${state.attemptId}.json`,
				JSON.stringify({ schemaVersion: 1, attemptId: state.attemptId, baseSequence: 1, phase: "repairing", round: 0 }),
			);
			const result = await qualifier.run({
				workflow: "build",
				approvedDesign: values.input.approvedDesign,
				userOrigin: userOriginFromRegisteredCommand("build behavior"),
				checkpointSequence: 1,
				authorizedAt: "2026-08-25T00:00:02.000Z",
			});
			expect(result).toMatchObject({ status: "Blocked", reason: expect.stringContaining("manual inspection") });
			expect(QualifyAndCommit.checkpointSpan(values.resolved.machine.maxRepairRounds)).toBe(3);
			await values.authority.block("manual inspection", "2026-08-25T00:00:03.000Z");
		} finally {
			await values.cleanup();
		}
	}, 60_000);
});

describe("Git commit transaction", () => {
	it("publishes one hook-free local commit and aligns only index metadata", async () => {
		const values = await setup();
		const authorization = authorizeCommit(values.input);
		const hooks = join(values.repository.commonDir, "hooks");
		const referenceMarker = join(values.agentDir, "reference-hook-ran");
		const fsmonitorMarker = join(values.agentDir, "fsmonitor-ran");
		await writeFile(join(hooks, "reference-transaction"), `#!/bin/sh\ntouch ${referenceMarker}\n`, "utf8");
		await chmod(join(hooks, "reference-transaction"), 0o755);
		await writeFile(join(values.agentDir, "fsmonitor"), `#!/bin/sh\ntouch ${fsmonitorMarker}\n`, "utf8");
		await chmod(join(values.agentDir, "fsmonitor"), 0o755);
		const headBefore = (await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim();
		const indexBefore = (await values.fixture.run("git", ["write-tree"])).stdout.trim();
		const bytesBefore = await readFile(join(values.fixture.root, "implementation.rs"));
		await values.fixture.run("git", ["config", "core.fsmonitor", join(values.agentDir, "fsmonitor")]);
		const service = new GitTransactionService(
			values.authority,
			values.store,
			values.ref,
			values.repository,
			values.runner,
			join(values.agentDir, "git-transaction"),
		);
		try {
			const prepared = await service.prepare(authorization);
			expect(prepared.record).toMatchObject({ expectedHead: headBefore, expectedIndexTree: indexBefore });
			expect((await values.store.readPublicationMarker(values.ref))?.phase).toBe("prepared");
			const recorded = await service.publish(prepared);
			expect((await values.fixture.run("git", ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"])).stdout.trim()).toBe(
				recorded.commitId,
			);
			expect((await values.fixture.run("git", ["-c", "core.fsmonitor=false", "write-tree"])).stdout.trim()).toBe(
				values.input.candidate.treeOid,
			);
			expect(
				(await values.fixture.run("git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"]))
					.stdout,
			).toBe("");
			expect(await readFile(join(values.fixture.root, "implementation.rs"))).toEqual(bytesBefore);
			await expect(access(referenceMarker)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(access(fsmonitorMarker)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
			expect(await values.store.readPublicationMarker(values.ref)).toBeUndefined();
			const forbidden = /(?:^|\s)(?:push|fetch|merge|checkout|reset|switch|branch|worktree\s+(?:add|move|remove|lock|unlock))(?=\s|$)/;
			expect(values.commands.some((entry) => forbidden.test(entry.args.join(" ")))).toBe(false);
		} finally {
			await values.cleanup();
		}
	}, 60_000);

	it("recovers a markerless prepared record as an aborted pre-CAS transaction", async () => {
		const values = await setup();
		const service = new GitTransactionService(
			values.authority,
			values.store,
			values.ref,
			values.repository,
			values.runner,
			join(values.agentDir, "git-transaction-markerless"),
		);
		try {
			const wrongRunId = randomUUID();
			const wrongGuard = await values.leases.acquireRecoveryGuard({
				repositoryId: "f".repeat(64),
				runId: wrongRunId,
				attemptId: randomUUID(),
			});
			await expect(service.recover(wrongGuard)).rejects.toThrow("another run/repository");
			const released = await values.leases.acquire({ scope: "run", runId: wrongRunId, attemptId: randomUUID() });
			await released.release();
			const prepared = await service.prepare(authorizeCommit(values.input));
			await values.store.clearPreparedPublicationMarker(values.ref, prepared.markerDigest);
			expect(await service.recover(await acquireRecoveryGuard(values))).toMatchObject({ status: "Aborted" });
			expect((await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).toBe(prepared.record.expectedHead);
		} finally {
			await values.cleanup();
		}
	}, 60_000);

	it("lets a durable cancel admitted before publication prevent ref CAS", async () => {
		const values = await setup();
		const authorization = authorizeCommit(values.input);
		const service = new GitTransactionService(
			values.authority,
			values.store,
			values.ref,
			values.repository,
			values.runner,
			join(values.agentDir, "git-transaction-cancel"),
		);
		try {
			const prepared = await service.prepare(authorization);
			await values.store.appendControl(values.ref, "Cancel", "2026-08-25T00:00:03.000Z");
			await expect(service.publish(prepared)).rejects.toBeInstanceOf(ControlAcceptedError);
			expect((await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).toBe(
				prepared.record.expectedHead,
			);
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Cancelled" });
			expect(await values.store.readPublicationMarker(values.ref)).toBeUndefined();
		} finally {
			await values.cleanup();
		}
	}, 60_000);

	it("recovers an uncertain pre-CAS publishing marker when the ref never moved", async () => {
		const values = await setup();
		const service = new GitTransactionService(
			values.authority,
			values.store,
			values.ref,
			values.repository,
			values.runner,
			join(values.agentDir, "git-transaction-pre-cas"),
		);
		try {
			const prepared = await service.prepare(authorizeCommit(values.input));
			values.setCommandInterceptor(async (command, args) => {
				if (command === "git" && args.includes("update-ref")) {
					values.setCommandInterceptor(undefined);
					throw new Error("injected before CAS");
				}
			});
			await expect(service.publish(prepared)).rejects.toThrow("injected before CAS");
			expect((await values.store.readPublicationMarker(values.ref))?.phase).toBe("publishing");
			expect(await service.recover(await acquireRecoveryGuard(values))).toMatchObject({ status: "Aborted" });
			expect(await values.store.readPublicationMarker(values.ref)).toBeUndefined();
		} finally {
			await values.cleanup();
		}
	}, 60_000);

	it("leaves Git index and working bytes untouched when expected-old CAS loses a ref race", async () => {
		const values = await setup();
		const authorization = authorizeCommit(values.input);
		const service = new GitTransactionService(
			values.authority,
			values.store,
			values.ref,
			values.repository,
			values.runner,
			join(values.agentDir, "git-transaction-race"),
		);
		try {
			const prepared = await service.prepare(authorization);
			const indexBefore = (await values.fixture.run("git", ["write-tree"])).stdout.trim();
			const bytesBefore = await readFile(join(values.fixture.root, "implementation.rs"));
			const competing = (
				await values.fixture.run("git", [
					"commit-tree",
					prepared.record.treeOid,
					"-p",
					prepared.record.expectedHead,
					"-m",
					"competing",
				])
			).stdout.trim();
			values.setCommandInterceptor(async (command, args) => {
				if (command !== "git" || !args.includes("update-ref")) return;
				values.setCommandInterceptor(undefined);
				await values.fixture.run("git", [
					"update-ref",
					prepared.record.expectedRef,
					competing,
					prepared.record.expectedHead,
				]);
			});
			await expect(service.publish(prepared)).rejects.toThrow();
			expect((await values.fixture.run("git", ["rev-parse", prepared.record.expectedRef])).stdout.trim()).toBe(competing);
			expect((await values.fixture.run("git", ["write-tree"])).stdout.trim()).toBe(indexBefore);
			expect(await readFile(join(values.fixture.root, "implementation.rs"))).toEqual(bytesBefore);
			expect((await values.store.readPublicationMarker(values.ref))?.phase).toBe("publishing");
			await expect(service.recover(await acquireRecoveryGuard(values))).rejects.toThrow("diverged");
			const marker = await values.store.readPublicationMarker(values.ref);
			await values.store.withPublicationControl(values.ref, marker!.digest, async (context) => context.clearMarker());

		} finally {
			await values.cleanup();
		}
	}, 60_000);

	it("reconstructs CommitRecorded and terminal state after a crash immediately after CAS", async () => {
		const values = await setup();
		const service = new GitTransactionService(
			values.authority,
			values.store,
			values.ref,
			values.repository,
			values.runner,
			join(values.agentDir, "git-transaction-post-cas"),
		);
		try {
			const prepared = await service.prepare(authorizeCommit(values.input));
			const original = values.store.writeImmutableArtifact.bind(values.store);
			let injected = false;
			values.store.writeImmutableArtifact = async (...args) => {
				if (!injected && args[1].endsWith("/recorded.json")) {
					injected = true;
					throw new Error("injected after CAS");
				}
				return original(...args);
			};
			await expect(service.publish(prepared)).rejects.toThrow("injected after CAS");
			values.store.writeImmutableArtifact = original;
			expect((await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).toBe(
				prepared.record.proposedCommitId,
			);
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Active" });
			expect((await values.store.readPublicationMarker(values.ref))?.phase).toBe("publishing");
			expect(await service.recover(await acquireRecoveryGuard(values))).toMatchObject({
				status: "Committed",
				commitId: prepared.record.proposedCommitId,
			});
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
			expect(await values.store.readPublicationMarker(values.ref)).toBeUndefined();
			expect((await values.fixture.run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout).toBe("");
		} finally {
			await values.cleanup();
		}
	}, 60_000);

	it("leaves an aligning marker when CAS succeeds but index alignment fails", async () => {
		const values = await setup();
		const authorization = authorizeCommit(values.input);
		const service = new GitTransactionService(
			values.authority,
			values.store,
			values.ref,
			values.repository,
			values.runner,
			join(values.agentDir, "git-transaction-align"),
		);
		try {
			const prepared = await service.prepare(authorization);
			values.setCommandInterceptor(async (command, args) => {
				if (command === "git" && args.includes("read-tree")) {
					values.setCommandInterceptor(undefined);
					throw new Error("injected read-tree failure");
				}
			});
			await expect(service.publish(prepared)).rejects.toThrow("injected read-tree failure");
			expect((await values.fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).toBe(
				prepared.record.proposedCommitId,
			);
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed" });
			const marker = await values.store.readPublicationMarker(values.ref);
			expect(marker?.phase).toBe("aligning");
			expect(await service.recover(await acquireRecoveryGuard(values))).toMatchObject({
				status: "Committed",
				commitId: prepared.record.proposedCommitId,
			});
			expect(await values.store.readPublicationMarker(values.ref)).toBeUndefined();
			expect((await values.fixture.run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout).toBe("");
		} finally {
			await values.cleanup();
		}
	}, 60_000);
});

describe("commit message", () => {
	it("accepts exact bounded header/body bytes", () => {
		expect(validateCommitMessage("Header\n\nBody line\n\nSecond paragraph").digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("rejects malformed separators, controls, trailing LF/space, and byte limits", () => {
		for (const message of [
			"",
			"Header\n",
			"Header\n\n",
			"Header\n\n\nBody",
			"Header\tbad",
			"Header ",
			"x".repeat(73),
			`Header\n\n${"x".repeat(101)}`,
		]) {
			expect(() => validateCommitMessage(message)).toThrow();
		}
	});
});
