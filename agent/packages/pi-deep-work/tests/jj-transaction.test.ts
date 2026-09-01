import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGateway, AgentResult } from "../src/agents/gateway.ts";
import { DesignApprover } from "../src/application/approve-design.ts";
import { QualifyAndCommit } from "../src/application/qualify-and-commit.ts";
import { RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import { authorizeCommit } from "../src/authorization/authorize.ts";
import { TrustedCommandCatalog } from "../src/gates/catalog.ts";
import { GateExecutor } from "../src/gates/executor.ts";
import { Normalizer } from "../src/gates/normalizer.ts";
import { BackendTreeService } from "../src/gates/tree-backend.ts";
import { JjTransactionService } from "../src/jj/transaction.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { ReviewPanel } from "../src/review/panel.ts";
import { reviewSubjectDigest } from "../src/review/subjects.ts";
import { RunStore } from "../src/store/run-store.ts";
import { VerificationRecordSchema, decode } from "../src/store/schemas.ts";
import { evidenceSubjectDigest, observationSubjectDigest } from "../src/subject/content.ts";
import { captureJjObservation, jjStatus } from "../src/vcs/jj-backend.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner } from "../src/vcs/types.ts";
import {
	createRepositoryFixture,
	detectJjAvailability,
	isolatedVcsEnvironment,
	type RepositoryFixtureKind,
} from "./helpers/repositories.ts";

const executeFile = promisify(execFile);
const temporary: string[] = [];
const availability = await detectJjAvailability();
const now = "2026-08-25T00:00:01.000Z";

function policy() {
	return resolvePolicy(
		decodeMachinePolicy({
			schemaVersion: 1,
			models: {
				gpt: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
				opusReviewers: [{ provider: "test", id: "claude-opus-4.8", thinkingLevel: "max" }],
			},
			concurrency: 1,
			maxRepairRounds: 1,
			commandTimeoutMs: 10_000,
			minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: [process.execPath, "-e", "void 0"], timeoutMs: 2_000 }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: [process.execPath, "-e", "void 0"], timeoutMs: 2_000 }],
			observations: [
				{ id: "behavior", claimKeys: ["behavior.ok"], argv: [process.execPath, "-e", "void 0"], timeoutMs: 2_000 },
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

async function setup(kind: Extract<RepositoryFixtureKind, "jj-native" | "jj-colocated">) {
	const fixture = await createRepositoryFixture(kind);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-jj-transaction-"));
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
	if (repository.kind !== "jj") throw new Error("expected Jujutsu");
	const resolved = policy();
	const store = new RunStore(agentDir);
	const leases = new PortableLeaseManager(agentDir);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "build" as const,
		repositoryId: repository.repositoryId,
		policyDigest: resolved.digest,
		goal: "authorize jj",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create("jj", initial);
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
	const capture = () => captureJjObservation(repository, resolved.digest, runner);
	const catalog = await TrustedCommandCatalog.build(resolved, repository.root);
	const gateway = {
		runManySettled: vi.fn().mockImplementation(async (jobs: Array<{ kind: "review-design" | "review-code" }>) => [
			{ ok: true, result: reviewAgent(jobs[0].kind) },
		]),
		runSettled: vi.fn().mockResolvedValue({ ok: false, error: "use deterministic message fallback" }),
	} as unknown as AgentGateway;
	const panel = new ReviewPanel(gateway, store, ref, resolved);
	const approved = await new DesignApprover(panel, catalog, store, ref, capture).approve({
		caller: "build",
		design: "approved jj design",
		userOrigin: userOriginFromRegisteredCommand("build behavior"),
		expectedObservationDigest: observationSubjectDigest(await capture()),
		selectorProposals: [{ selectorId: "behavior-path", value: "tests/behavior.rs" }],
		approvedAt: now,
	});
	if (approved.status !== "Approved") throw new Error("expected design approval");
	await fixture.write("implementation.rs", "fn implemented() {}\n");
	const trees = new BackendTreeService(authority, repository, resolved.digest, runner, join(agentDir, "scratch"));
	const normalizer = new Normalizer(authority, resolved, trees);
	const normalization = await normalizer.runExactlyTwoPasses();
	const candidate = await trees.sealCandidate({
		normalization,
		approvedDesignId: approved.record.approvedDesignId,
		behaviorContractId: approved.record.behavior.digest,
	});
	if (candidate.kind !== "jj") throw new Error("expected Jujutsu candidate");
	const executor = new GateExecutor(authority, store, ref, "jj", capture);
	const quickCommand = catalog.gate("quick", "quick");
	const fullCommand = catalog.gate("full", "full");
	const behaviorCommand = catalog.observation("behavior");
	const quick = { command: quickCommand, execution: await executor.run(quickCommand, candidate) };
	const full = { command: fullCommand, execution: await executor.run(fullCommand, candidate) };
	const behavior = { command: behaviorCommand, execution: await executor.run(behaviorCommand, candidate) };
	if (!behavior.execution.receipt || !behavior.execution.receiptArtifact) throw new Error("expected behavior receipt");
	const patch = (
		await fixture.run("jj", [
			"--ignore-working-copy",
			"--color",
			"never",
			"--no-pager",
			"diff",
			"--git",
			"--context=3",
			"--from",
			candidate.parentCommitIds[0],
			"--to",
			candidate.commitId,
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
	const changedPaths = (await jjStatus(repository, runner)).changedPaths;
	const input = {
		workflow: "build" as const,
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
	};
	return {
		fixture,
		agentDir,
		commands,
		runner,
		repository,
		store,
		leases,
		ref,
		authority,
		trees,
		input,
		resolved,
		catalog,
		gateway,
		panel,
		executor,
		normalizer,
		approvedDesign: approved.record,
		setCommandInterceptor(value: typeof commandInterceptor) {
			commandInterceptor = value;
		},
	};
}

async function recoveryGuard(values: Awaited<ReturnType<typeof setup>>) {
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

const jjIt = availability.available ? it : it.skip;

describe("Jujutsu commit transaction", () => {
	for (const kind of ["jj-native", "jj-colocated"] as const) {
		jjIt(`publishes one complete ${kind} candidate (${availability.diagnostic})`, async () => {
			const values = await setup(kind);
			const service = new JjTransactionService(
				values.authority,
				values.store,
				values.ref,
				values.repository,
				values.runner,
				values.trees,
			);
			const bytesBefore = await readFile(join(values.fixture.root, "implementation.rs"));
			const gitHeadBefore = kind === "jj-colocated" ? (await readFile(join(values.fixture.root, ".git", "HEAD"), "utf8")).trim() : undefined;
			values.commands.length = 0;
			try {
				const prepared = await service.prepare(authorizeCommit(values.input));
				const recorded = await service.publish(prepared);
				expect(recorded).toMatchObject({ backend: "jj", transactionId: prepared.record.transactionId });
				const status = await values.fixture.run("jj", ["status", "--no-pager"]);
				expect(status.stdout).toContain("The working copy has no changes");
				expect(await readFile(join(values.fixture.root, "implementation.rs"))).toEqual(bytesBefore);
				expect(values.commands.every((entry) => entry.command === "jj")).toBe(true);
				expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
				expect(await values.store.readPublicationMarker(values.ref)).toBeUndefined();
				if (gitHeadBefore !== undefined) {
					const gitHeadAfter = (await readFile(join(values.fixture.root, ".git", "HEAD"), "utf8")).trim();
					expect(gitHeadAfter).not.toBe(gitHeadBefore);
					expect(gitHeadAfter).toBe(recorded.commitId);
				}
			} finally {
				await values.fixture.cleanup();
			}
		}, 45_000);
	}

	jjIt(`runs shared qualification through one native Jujutsu commit (${availability.diagnostic})`, async () => {
		const values = await setup("jj-native");
		const transaction = new JjTransactionService(
			values.authority,
			values.store,
			values.ref,
			values.repository,
			values.runner,
			values.trees,
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
			{ kind: "jj", service: transaction },
			null,
		);
		try {
			const result = await qualifier.run({
				workflow: "build",
				approvedDesign: values.approvedDesign,
				userOrigin: userOriginFromRegisteredCommand("build behavior"),
				checkpointSequence: 1,
				authorizedAt: "2026-08-25T00:00:02.000Z",
			});
			expect(result.status).toBe("Committed");
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed" });
		} finally {
			await values.fixture.cleanup();
		}
	}, 60_000);

	jjIt(`recovers native Jujutsu publication boundaries (${availability.diagnostic})`, async () => {
		const markerless = await setup("jj-native");
		try {
			const service = new JjTransactionService(
				markerless.authority,
				markerless.store,
				markerless.ref,
				markerless.repository,
				markerless.runner,
				markerless.trees,
			);
			const prepared = await service.prepare(authorizeCommit(markerless.input));
			await mkdir(join(markerless.ref.directory, "artifacts", "transactions", "jj", "partial-directory"), {
				recursive: true,
			});
			await markerless.store.clearPreparedPublicationMarker(markerless.ref, prepared.markerDigest);
			expect(await service.recover(await recoveryGuard(markerless))).toMatchObject({ status: "Aborted" });
			expect(await markerless.store.load(markerless.ref)).toMatchObject({ lifecycle: "Active" });
		} finally {
			await markerless.fixture.cleanup();
		}

		const preOperation = await setup("jj-native");
		try {
			const service = new JjTransactionService(
				preOperation.authority,
				preOperation.store,
				preOperation.ref,
				preOperation.repository,
				preOperation.runner,
				preOperation.trees,
			);
			const prepared = await service.prepare(authorizeCommit(preOperation.input));
			preOperation.setCommandInterceptor(async (command, args) => {
				if (command === "jj" && args.includes("commit")) {
					preOperation.setCommandInterceptor(undefined);
					throw new Error("injected before jj commit");
				}
			});
			await expect(service.publish(prepared)).rejects.toThrow("injected before jj commit");
			expect(await service.recover(await recoveryGuard(preOperation))).toMatchObject({ status: "Aborted" });
			expect(await preOperation.store.load(preOperation.ref)).toMatchObject({ lifecycle: "Active" });
		} finally {
			await preOperation.fixture.cleanup();
		}

		const divergent = await setup("jj-native");
		try {
			const service = new JjTransactionService(
				divergent.authority,
				divergent.store,
				divergent.ref,
				divergent.repository,
				divergent.runner,
				divergent.trees,
			);
			const prepared = await service.prepare(authorizeCommit(divergent.input));
			divergent.setCommandInterceptor(async (command, args) => {
				if (command === "jj" && args.includes("commit")) {
					divergent.setCommandInterceptor(undefined);
					throw new Error("injected before divergent operation");
				}
			});
			await expect(service.publish(prepared)).rejects.toThrow("injected before divergent operation");
			await divergent.fixture.run("jj", ["describe", "-m", "external divergence"]);
			await expect(service.recover(await recoveryGuard(divergent))).rejects.toThrow();
			const released = await divergent.leases.acquire({
				scope: "repository",
				repositoryId: divergent.repository.repositoryId,
				runId: randomUUID(),
				attemptId: randomUUID(),
			});
			await released.release();
			expect((await divergent.store.readPublicationMarker(divergent.ref))?.phase).toBe("publishing");
		} finally {
			await divergent.fixture.cleanup();
		}
	}, 90_000);

	jjIt(`reconstructs native Jujutsu state after operation success (${availability.diagnostic})`, async () => {
		const values = await setup("jj-native");
		try {
			const service = new JjTransactionService(
				values.authority,
				values.store,
				values.ref,
				values.repository,
				values.runner,
				values.trees,
			);
			const prepared = await service.prepare(authorizeCommit(values.input));
			const original = values.store.writeImmutableArtifact.bind(values.store);
			let injected = false;
			values.store.writeImmutableArtifact = async (...args) => {
				if (!injected && args[1].endsWith("/recorded.json")) {
					injected = true;
					throw new Error("injected after jj operation");
				}
				return original(...args);
			};
			await expect(service.publish(prepared)).rejects.toThrow("injected after jj operation");
			values.store.writeImmutableArtifact = original;
			expect((await values.store.readPublicationMarker(values.ref))?.phase).toBe("publishing");
			expect(await service.recover(await recoveryGuard(values))).toMatchObject({ status: "Committed" });
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
			expect(await values.store.readPublicationMarker(values.ref)).toBeUndefined();
		} finally {
			await values.fixture.cleanup();
		}
	}, 60_000);

	jjIt(`recovers native Jujutsu alignment without creating another operation (${availability.diagnostic})`, async () => {
		const values = await setup("jj-native");
		try {
			const service = new JjTransactionService(
				values.authority,
				values.store,
				values.ref,
				values.repository,
				values.runner,
				values.trees,
			);
			const prepared = await service.prepare(authorizeCommit(values.input));
			values.setCommandInterceptor(async (command, args) => {
				if (command === "jj" && args.at(-1) === "status" && !args.includes("--ignore-working-copy")) {
					values.setCommandInterceptor(undefined);
					throw new Error("injected jj status failure");
				}
			});
			await expect(service.publish(prepared)).rejects.toThrow("injected jj status failure");
			const marker = await values.store.readPublicationMarker(values.ref);
			expect(marker?.phase).toBe("aligning");
			const operationBefore = (await values.fixture.run("jj", ["op", "log", "-n", "1", "--no-graph", "-T", "id"])).stdout;
			expect(await service.recover(await recoveryGuard(values))).toMatchObject({ status: "Committed" });
			const operationAfter = (await values.fixture.run("jj", ["op", "log", "-n", "1", "--no-graph", "-T", "id"])).stdout;
			expect(operationAfter).toBe(operationBefore);
		} finally {
			await values.fixture.cleanup();
		}
	}, 60_000);
});
