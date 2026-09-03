import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { AgentGateway, type AgentProgressListener } from "../agents/gateway.ts";
import { DesignApprover } from "../application/approve-design.ts";
import { WritePreflight } from "../application/begin-write.ts";
import { ImplementationAgent } from "../application/implementation-agent.ts";
import { blockRun, failQueuedRun, failRun } from "../application/lifecycle.ts";
import { QualifyAndCommit } from "../application/qualify-and-commit.ts";
import { RegressionAgent } from "../application/regression-agent.ts";
import {
	ControlAcceptedError,
	MutationRecoveryRequiredError,
	RunAuthority,
	RunAuthorityClosedError,
} from "../application/run-authority.ts";
import { attemptId, runId, type WorkflowKind } from "../application/types.ts";
import type { UserOrigin } from "../application/user-origin.ts";
import { assertUserOrigin, userOriginForPersistedGoal } from "../application/user-origin.ts";
import { RepairAgent } from "../application/repair-agent.ts";
import { TrustedCommandCatalog } from "../gates/catalog.ts";
import { GateExecutor } from "../gates/executor.ts";
import { Normalizer } from "../gates/normalizer.ts";
import { BackendTreeService } from "../gates/tree-backend.ts";
import { GitTransactionService } from "../git/transaction.ts";
import { JjTransactionService } from "../jj/transaction.ts";
import { PortableLeaseManager } from "../lease/repository-lease.ts";
import { loadResolvedPolicy } from "../policy/resolver.ts";
import { resolveModels } from "../policy/models.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import { ReviewPanel } from "../review/panel.ts";
import type { ApprovedDesignRecord } from "../review/design.ts";
import { RunStore, type RunRef } from "../store/run-store.ts";
import { loadRunRecords, type RepositoryRecord } from "./records.ts";
import { readBuildContext, readFixContext } from "./write-context.ts";
import {
	checkpointMatchesObservation,
	resumeBuildFromContext,
	resumeFixFromContext,
} from "./write-resume.ts";
import {
	decodeRunProjection,
	type MutationPhaseCheckpoint,
	type QueuedRun,
	type RecoverableRun,
	type RunProjection,
} from "../store/schemas.ts";
import { captureGitObservation } from "../vcs/git-backend.ts";
import { captureJjObservation } from "../vcs/jj-backend.ts";
import { detectRepository } from "../vcs/detect.ts";
import { commandRunner } from "../vcs/runner.ts";
import type { CommandRunner, DetectedRepository } from "../vcs/types.ts";
import { changedPathsDigest, observationSubjectDigest } from "../subject/content.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";
import { MutationPhase } from "../workspace/mutation-phase.ts";
import { createWorkspaceTools } from "../workspace/tools.ts";
import { runBuildWorkflow } from "../workflows/build.ts";
import { runDesignWorkflow } from "../workflows/design.ts";
import { runFixWorkflow } from "../workflows/fix.ts";
import { runHowWorkflow } from "../workflows/how.ts";
import { runReviewWorkflow } from "../workflows/review.ts";
import { runUnslopWorkflow, type UnslopSource } from "../workflows/unslop.ts";
import { runVerifyWorkflow } from "../workflows/verify.ts";

const runtimeTimestamps = new WeakMap<object, Map<string, string>>();

function runtimeTimestamp(target: object, key: string): string {
	let values = runtimeTimestamps.get(target);
	if (!values) {
		values = new Map();
		runtimeTimestamps.set(target, values);
	}
	let value = values.get(key);
	if (!value) {
		value = new Date().toISOString();
		values.set(key, value);
	}
	return value;
}

export interface StartRequest {
	workflow: WorkflowKind;
	origin: UserOrigin;
	base?: string;
	unslopSource?: UnslopSource;
}

export interface StartHooks {
	onStarted?(ref: RunRef): void;
	onProgress?: AgentProgressListener;
}

export interface RecoveryResult {
	ref: RunRef;
	state: RunProjection;
	status: "None" | "Aborted" | "Committed";
	commitId?: string;
}

export interface RunResult {
	ref: RunRef;
	state: RunProjection;
}

function sameRepository(live: DetectedRepository, recorded: RepositoryRecord): boolean {
	if (
		live.kind !== recorded.kind ||
		live.repositoryId !== recorded.repositoryId ||
		live.root !== recorded.root ||
		live.sharedRoot !== recorded.sharedRoot
	) {
		return false;
	}
	return live.kind === "git"
		? recorded.kind === "git" && live.commonDir === recorded.commonDir
		: recorded.kind === "jj" && live.gitStore === recorded.gitStore && live.workspaceId === recorded.workspaceId;
}

export class WorkflowRuntime {
	readonly agentDir: string;
	readonly store: RunStore;
	readonly leases: PortableLeaseManager;

	constructor(
		agentDir = getAgentDir(),
		private readonly runner: CommandRunner = commandRunner,
		private readonly modelResolver: typeof resolveModels = resolveModels,
	) {
		this.agentDir = agentDir;
		this.store = new RunStore(agentDir);
		this.leases = new PortableLeaseManager(agentDir);
	}

	async start(request: StartRequest, ctx: ExtensionCommandContext, hooks: StartHooks = {}): Promise<RunResult> {
		assertUserOrigin(request.origin);
		const repository = await detectRepository(ctx.cwd, this.runner);
		const policy = await loadResolvedPolicy(ctx, {
			machine: join(this.agentDir, "pi-deep-work", "config.json"),
			canonicalRoot: repository.root,
		});
		const models = this.modelResolver(ctx.modelRegistry, policy.machine);
		const queued = this.queued(request, repository, policy.digest);
		const ref = await this.store.create(repository.kind, queued);
		const created = await this.store.load(ref);
		if (created.lifecycle !== "Queued") throw new Error("New run did not remain Queued after creation");
		const currentAttemptId = attemptId(randomUUID());
		try {
			await this.persistRequest(ref, request, repository);
		} catch (error) {
			await this.failQueuedIfNeeded(ref, currentAttemptId, error);
			throw error;
		}
		let authority: RunAuthority;
		try {
			authority = await RunAuthority.start(
				{
					store: this.store,
					leases: this.leases,
					ref,
					repository,
					attemptId: currentAttemptId,
					phase: request.workflow,
					pollIntervalMs: 100,
				},
				created,
				new Date().toISOString(),
			);
		} catch (error) {
			// RunAuthority.start releases every acquired lease before rejection; the runtime failure test wraps the exact handle.
			await this.failQueuedIfNeeded(ref, currentAttemptId, error);
			throw error;
		}
		try {
			hooks.onStarted?.(ref);
			await this.dispatch(request, ctx, repository, policy, models, ref, authority, hooks.onProgress);
		} catch (error) {
			if (error instanceof ControlAcceptedError || error instanceof RunAuthorityClosedError) {
				return { ref, state: await this.store.load(ref) };
			}
			const state = await this.store.load(ref);
			if (state.lifecycle === "Active") {
				try {
					await authority.fail(error instanceof Error ? error.message : String(error), new Date().toISOString());
				} catch (stopError) {
					throw new AggregateError([error, stopError], "Workflow failed and its authority could not stop cleanly");
				}
			}
			throw error;
		}
		const state = await this.store.load(ref);
		if (state.lifecycle === "Active") {
			await authority.fail("Workflow returned without a durable outcome", new Date().toISOString());
			throw new Error("Workflow returned without a durable outcome");
		}
		return { ref, state };
	}

	private async failQueuedIfNeeded(
		ref: RunRef,
		currentAttemptId: ReturnType<typeof attemptId>,
		error: unknown,
	): Promise<void> {
		const current = await this.store.load(ref);
		const at = new Date().toISOString();
		const reason = error instanceof Error ? error.message || error.name : String(error) || "run startup failed";
		if (current.lifecycle === "Queued") {
			await this.store.appendTransition(ref, "RunFailed", failQueuedRun(current, currentAttemptId, reason, at), at);
			return;
		}
		if (current.lifecycle === "Active" && current.attemptId === currentAttemptId) {
			await this.store.appendTransition(ref, "AttemptStopped", failRun(current, reason, at), at);
		}
	}

	async resume(
		ref: RunRef,
		commandOrigin: UserOrigin,
		ctx: ExtensionCommandContext,
		hooks: StartHooks = {},
	): Promise<RunResult> {
		assertUserOrigin(commandOrigin);
		const state = await this.store.load(ref);
		if (
			state.lifecycle !== "Paused" &&
			state.lifecycle !== "Blocked" &&
			state.lifecycle !== "NeedsManualInspection"
		) {
			throw new Error(`run ${ref.runId} is not resumable from ${state.lifecycle}`);
		}
		await this.store.assertNoPublicationMarker(ref);
		const records = await loadRunRecords(this.store, ref);
		if (records.request.workflow !== state.workflow || records.request.goal !== state.goal) {
			throw new Error("Persisted request contradicts run state");
		}
		const repository = await detectRepository(records.repository.root, this.runner);
		if (!sameRepository(repository, records.repository) || repository.repositoryId !== ref.repositoryId) {
			throw new Error("Persisted repository identity no longer matches the live checkout");
		}
		const policy = await loadResolvedPolicy(ctx, {
			machine: join(this.agentDir, "pi-deep-work", "config.json"),
			canonicalRoot: repository.root,
		});
		if (policy.digest !== state.policyDigest) throw new Error("resume policy digest changed");
		const models = this.modelResolver(ctx.modelRegistry, policy.machine);
		const origin = userOriginForPersistedGoal(commandOrigin, state.goal);
		if (state.workflow === "fix" || state.workflow === "build") {
			const context =
				state.workflow === "build" ? await readBuildContext(this.store, ref) : await readFixContext(this.store, ref);
			if (context) return this.resumeWrite(ref, state, origin, ctx, repository, policy, models, hooks);
			const observation =
				repository.kind === "git"
					? await captureGitObservation(repository, policy.digest, this.runner)
					: await captureJjObservation(repository, policy.digest, this.runner);
			if (observation.conflicted || observation.changedPathsDigest !== changedPathsDigest([])) {
				let inspectionAuthority: RunAuthority;
				try {
					inspectionAuthority = await RunAuthority.resume(
						{
							store: this.store,
							leases: this.leases,
							ref,
							repository,
							attemptId: attemptId(randomUUID()),
							phase: state.workflow,
							pollIntervalMs: 100,
						},
						state,
						new Date().toISOString(),
					);
				} catch (error) {
					if (error instanceof ControlAcceptedError) return { ref, state: await this.store.load(ref) };
					throw error;
				}
				await inspectionAuthority.manualInspection(
					"Write resume has no durable context and the checkout is not clean",
					new Date().toISOString(),
				);
				return { ref, state: await this.store.load(ref) };
			}
		}
		const request: StartRequest = {
			workflow: state.workflow,
			origin,
			...(records.request.base ? { base: records.request.base } : {}),
			...(records.request.unslopSource ? { unslopSource: records.request.unslopSource } : {}),
		};
		let authority: RunAuthority;
		try {
			authority = await RunAuthority.resume(
				{
					store: this.store,
					leases: this.leases,
					ref,
					repository,
					attemptId: attemptId(randomUUID()),
					phase: state.workflow,
					pollIntervalMs: 100,
				},
				state,
				new Date().toISOString(),
			);
		} catch (error) {
			if (error instanceof ControlAcceptedError) return { ref, state: await this.store.load(ref) };
			throw error;
		}
		try {
			hooks.onStarted?.(ref);
			await this.dispatch(request, ctx, repository, policy, models, ref, authority, hooks.onProgress);
		} catch (error) {
			if (error instanceof ControlAcceptedError || error instanceof RunAuthorityClosedError) {
				return { ref, state: await this.store.load(ref) };
			}
			const current = await this.store.load(ref);
			if (current.lifecycle === "Active") {
				try {
					await authority.fail(error instanceof Error ? error.message : String(error), new Date().toISOString());
				} catch (stopError) {
					throw new AggregateError([error, stopError], "Resumed workflow failed and could not stop cleanly");
				}
			}
			throw error;
		}
		const current = await this.store.load(ref);
		if (current.lifecycle === "Active") {
			await authority.fail("Resumed workflow returned without a durable outcome", new Date().toISOString());
			throw new Error("Resumed workflow returned without a durable outcome");
		}
		return { ref, state: current };
	}

	private async resumeWrite(
		ref: RunRef,
		state: RecoverableRun,
		origin: UserOrigin,
		_ctx: ExtensionCommandContext,
		repository: DetectedRepository,
		policy: Awaited<ReturnType<typeof loadResolvedPolicy>>,
		models: ReturnType<typeof resolveModels>,
		hooks: StartHooks,
	): Promise<RunResult> {
		const buildContext = state.workflow === "build" ? await readBuildContext(this.store, ref) : undefined;
		const fixContext = state.workflow === "fix" ? await readFixContext(this.store, ref) : undefined;
		const context = buildContext ?? fixContext;
		if (!context) throw new Error("Write resume has no durable workflow context");
		if (fixContext) await this.assertDurableCheckpoint(ref, fixContext.regressionCheckpoint);
		if (context.stage !== "red") await this.assertApprovedDesign(ref, context.approvedDesign);
		if (context.stage === "implemented") await this.assertDurableCheckpoint(ref, context.implementationCheckpoint);
		let checkpoint = context.stage === "implemented" ? context.implementationCheckpoint : undefined;
		if (!checkpoint && context.stage === "approved" && context.attemptId === state.lastAttemptId) {
			const persisted = await this.store.readCheckpoint(
				ref,
				state.lastAttemptId,
				state.workflow === "build" ? 1 : 2,
				"implement",
			);
			if (persisted && !("mutation" in persisted)) throw new Error("Write resume implementation checkpoint is incomplete");
			checkpoint = persisted;
		}
		const observation =
			repository.kind === "git"
				? await captureGitObservation(repository, policy.digest, this.runner)
				: await captureJjObservation(repository, policy.digest, this.runner);
		const observationDigest = observationSubjectDigest(observation);
		if (checkpoint) {
			if (!checkpointMatchesObservation(checkpoint, observationDigest, policy.digest)) {
				throw new Error("Write resume checkout differs from the implementation checkpoint");
			}
		} else {
			const expectedDigest =
				context.workflow === "build"
					? observationSubjectDigest(context.approvedDesign.reviewSubject.observation)
					: context.regressionCheckpoint.subjectDigest;
			if (observationDigest !== expectedDigest) {
				throw new Error("Write resume checkout differs from the last safe workflow context");
			}
		}
		let authority: RunAuthority;
		try {
			authority = await RunAuthority.resume(
				{
					store: this.store,
					leases: this.leases,
					ref,
					repository,
					attemptId: attemptId(randomUUID()),
					phase: state.workflow,
					pollIntervalMs: 100,
				},
				state,
				new Date().toISOString(),
			);
		} catch (error) {
			if (error instanceof ControlAcceptedError) return { ref, state: await this.store.load(ref) };
			throw error;
		}
		try {
			hooks.onStarted?.(ref);
			const boundary = await WorkspaceBoundary.open(repository, this.runner);
			const gateway = this.createGateway(
				authority,
				repository,
				models,
				createWorkspaceTools(boundary, new MutationPhase("read-only-tools")),
				hooks.onProgress,
			);
			const trees = new BackendTreeService(
				authority,
				repository,
				policy.digest,
				this.runner,
				join(ref.directory, "scratch", "resume-trees"),
			);
			const lockedObservation = await trees.captureObservation();
			const lockedDigest = observationSubjectDigest(lockedObservation.observation);
			const expectedDigest = checkpoint
				? checkpoint.subjectDigest
				: context.workflow === "build"
					? observationSubjectDigest(context.approvedDesign.reviewSubject.observation)
					: context.regressionCheckpoint.subjectDigest;
			if (lockedDigest !== expectedDigest) {
				await authority.manualInspection("Write resume checkout changed after repository lease acquisition", new Date().toISOString());
				return { ref, state: await this.store.load(ref) };
			}
			const catalog = await TrustedCommandCatalog.build(policy, repository.root);
			const panel = new ReviewPanel(gateway, this.store, ref, policy);
			const capture = () =>
				repository.kind === "git"
					? captureGitObservation(repository, policy.digest, this.runner)
					: captureJjObservation(repository, policy.digest, this.runner);
			const gates = new GateExecutor(authority, this.store, ref, repository.kind, capture);
			const approver = new DesignApprover(panel, catalog, this.store, ref, async () =>
				(await trees.captureObservation()).observation,
			);
			const implementation = new ImplementationAgent(authority, gateway, boundary, catalog, trees, this.store, ref);
			const normalizer = new Normalizer(authority, policy, trees);
			const backend =
				repository.kind === "git"
					? {
							kind: "git" as const,
							service: new GitTransactionService(
								authority,
								this.store,
								ref,
								repository,
								this.runner,
								join(ref.directory, "scratch", "resume-git-transaction"),
							),
						}
					: { kind: "jj" as const, service: new JjTransactionService(authority, this.store, ref, repository, this.runner, trees) };
			const repair = new RepairAgent(authority, gateway, boundary, catalog, trees, this.store, ref);
			const qualifier = new QualifyAndCommit(
				policy,
				catalog,
				normalizer,
				trees,
				gates,
				panel,
				gateway,
				this.store,
				ref,
				backend,
				repair,
			);
			const completedAt = () => new Date().toISOString();
			if (buildContext) {
				await resumeBuildFromContext({
					context: buildContext,
					...(checkpoint ? { checkpoint } : {}),
					origin,
					authority,
					gateway,
					trees,
					implementation,
					qualifier,
					store: this.store,
					ref,
					completedAt,
				});
			} else if (fixContext) {
				await resumeFixFromContext({
					context: fixContext,
					...(checkpoint ? { checkpoint } : {}),
					origin,
					authority,
					gateway,
					trees,
					implementation,
					qualifier,
					store: this.store,
					ref,
					completedAt,
					approver,
					catalog,
					gates,
				});
			}
		} catch (error) {
			if (
				error instanceof ControlAcceptedError ||
				error instanceof RunAuthorityClosedError ||
				error instanceof MutationRecoveryRequiredError
			) {
				return { ref, state: await this.store.load(ref) };
			}
			const current = await this.store.load(ref);
			if (current.lifecycle === "Active") await authority.fail(error instanceof Error ? error.message : String(error), new Date().toISOString());
			throw error;
		}
		return { ref, state: await this.store.load(ref) };
	}

	private async assertApprovedDesign(ref: RunRef, record: ApprovedDesignRecord): Promise<void> {
		const durable = await this.store.readArtifact(ref, `approved-designs/${record.approvedDesignId}/record.json`);
		if (durable.toString("utf8") !== canonicalJson(record)) {
			throw new Error("Write context approved design contradicts immutable approved-design record");
		}
	}

	private async assertDurableCheckpoint(ref: RunRef, checkpoint: MutationPhaseCheckpoint): Promise<void> {
		const durable = await this.store.readCheckpoint(
			ref,
			checkpoint.attemptId,
			checkpoint.sequence,
			checkpoint.phase,
		);
		if (!durable || !("mutation" in durable) || canonicalJson(durable) !== canonicalJson(checkpoint)) {
			throw new Error(`Write context checkpoint is missing or contradicts durable store: ${checkpoint.phase}`);
		}
	}

	async recover(ref: RunRef, commandOrigin: UserOrigin): Promise<RecoveryResult> {
		assertUserOrigin(commandOrigin);
		// Mechanical transaction recovery is bound to durable repository/authorization evidence, not current policy.
		const records = await loadRunRecords(this.store, ref);
		const repository = await detectRepository(records.repository.root, this.runner);
		if (!sameRepository(repository, records.repository) || repository.repositoryId !== ref.repositoryId) {
			throw new Error("Persisted repository identity no longer matches recovery checkout");
		}
		// The transaction recover method owns and releases this guard on every success/error path.
		// RecoveryGuard acquires the same run/repository lease identities as RunAuthority, fencing live attempts.
		const guard = await this.leases.acquireRecoveryGuard({
			repositoryId: ref.repositoryId,
			runId: ref.runId,
			attemptId: attemptId(randomUUID()),
		});
		const recovered =
			repository.kind === "git"
				? await GitTransactionService.forRecovery(
						this.store,
						ref,
						repository,
						this.runner,
						join(ref.directory, "scratch", "git-recovery"),
					).recover(guard)
				: await JjTransactionService.forRecovery(this.store, ref, repository, this.runner).recover(guard);
		let state = await this.store.load(ref);
		if (state.lifecycle === "Active") {
			const settleGuard = await this.leases.acquireRecoveryGuard({
				repositoryId: ref.repositoryId,
				runId: ref.runId,
				attemptId: attemptId(randomUUID()),
			});
			try {
				state = await this.store.load(ref);
				if (state.lifecycle === "Active") {
					const observedControlRevision = await this.store.latestObservedControlRevision(ref);
					const at = new Date().toISOString();
					state = await this.store.appendTransition(
						ref,
						"AttemptStopped",
						blockRun(state, "Publication recovery completed; resume explicitly", at, observedControlRevision),
						at,
					);
				}
			} finally {
				await settleGuard.release();
			}
		}
		return { ref, state, ...recovered };
	}

	private queued(request: StartRequest, repository: DetectedRepository, policyDigest: string): QueuedRun {
		const now = new Date().toISOString();
		return decodeRunProjection({
			schemaVersion: 1,
			runId: runId(randomUUID()),
			workflow: request.workflow,
			repositoryId: repository.repositoryId,
			policyDigest,
			goal: request.origin.goal,
			createdAt: now,
			updatedAt: now,
			lastEventRevision: 0,
			lifecycle: "Queued",
		}) as QueuedRun;
	}

	private async persistRequest(ref: RunRef, request: StartRequest, repository: DetectedRepository): Promise<void> {
		await this.store.writeImmutableArtifact(
			ref,
			"run/request.json",
			Buffer.from(
				canonicalJson({
					schemaVersion: 1,
					workflow: request.workflow,
					goal: request.origin.goal,
					...(request.base ? { base: request.base } : {}),
					...(request.unslopSource ? { unslopSource: request.unslopSource } : {}),
				}),
			),
		);
		await this.store.writeImmutableArtifact(
			ref,
			"run/repository.json",
			Buffer.from(canonicalJson({ schemaVersion: 1, ...repository })),
		);
	}

	protected createGateway(
		authority: RunAuthority,
		repository: DetectedRepository,
		models: ReturnType<typeof resolveModels>,
		tools: ReturnType<typeof createWorkspaceTools>,
		onProgress?: AgentProgressListener,
	): AgentGateway {
		return new AgentGateway(authority, repository.root, models, tools, this.agentDir, undefined, onProgress);
	}

	protected async dispatch(
		request: StartRequest,
		ctx: ExtensionCommandContext,
		repository: DetectedRepository,
		policy: Awaited<ReturnType<typeof loadResolvedPolicy>>,
		models: ReturnType<typeof resolveModels>,
		ref: RunRef,
		authority: RunAuthority,
		onProgress?: AgentProgressListener,
	): Promise<void> {
		const boundary = await WorkspaceBoundary.open(repository, this.runner);
		const baseTools = createWorkspaceTools(boundary, new MutationPhase("read-only-tools"));
		const gateway = this.createGateway(authority, repository, models, baseTools, onProgress);
		const trees = new BackendTreeService(authority, repository, policy.digest, this.runner, join(ref.directory, "scratch", "trees"));
		const catalog = await TrustedCommandCatalog.build(policy, repository.root);
		const panel = new ReviewPanel(gateway, this.store, ref, policy);
		const capture = () =>
			repository.kind === "git"
				? captureGitObservation(repository, policy.digest, this.runner)
				: captureJjObservation(repository, policy.digest, this.runner);
		const gates = new GateExecutor(authority, this.store, ref, repository.kind, capture);

		switch (request.workflow) {
			case "how":
				await runHowWorkflow({
					origin: request.origin,
					authority,
					gateway,
					trees,
					store: this.store,
					ref,
					concurrency: policy.machine.concurrency,
					get completedAt() {
						return runtimeTimestamp(this, "completedAt");
					},
				});
				return;
			case "unslop":
				await runUnslopWorkflow({
					source: request.unslopSource ?? { kind: "diff", ...(request.base ? { base: request.base } : {}) },
					origin: request.origin,
					authority,
					gateway,
					trees,
					store: this.store,
					ref,
					get completedAt() {
						return runtimeTimestamp(this, "completedAt");
					},
				});
				return;
			case "review":
				await runReviewWorkflow({
					origin: request.origin,
					...(request.base ? { base: request.base } : {}),
					authority,
					gateway,
					trees,
					panel,
					store: this.store,
					ref,
					get completedAt() {
						return runtimeTimestamp(this, "completedAt");
					},
				});
				return;
			case "verify":
				await runVerifyWorkflow({
					origin: request.origin,
					policy,
					catalog,
					authority,
					gateway,
					trees,
					executor: gates,
					store: this.store,
					ref,
					repositoryKind: repository.kind,
					get completedAt() {
						return runtimeTimestamp(this, "completedAt");
					},
				});
				return;
			case "design": {
				const approver = new DesignApprover(panel, catalog, this.store, ref, async () => (await trees.captureObservation()).observation);
				await runDesignWorkflow({
					origin: request.origin,
					authority,
					gateway,
					trees,
					approver,
					store: this.store,
					ref,
					concurrency: policy.machine.concurrency,
					get approvedAt() {
						return runtimeTimestamp(this, "approvedAt");
					},
					get completedAt() {
						return runtimeTimestamp(this, "completedAt");
					},
				});
				return;
			}
			case "build":
			case "fix":
				await this.dispatchWrite(request, repository, policy, authority, ref, boundary, gateway, trees, catalog, panel, gates);
				return;
		}
	}

	private async dispatchWrite(
		request: StartRequest,
		repository: DetectedRepository,
		policy: Awaited<ReturnType<typeof loadResolvedPolicy>>,
		authority: RunAuthority,
		ref: RunRef,
		boundary: WorkspaceBoundary,
		gateway: AgentGateway,
		trees: BackendTreeService,
		catalog: TrustedCommandCatalog,
		panel: ReviewPanel,
		gates: GateExecutor,
	): Promise<void> {
		const preflight = new WritePreflight(authority, trees, repository, policy, this.runner);
		const approver = new DesignApprover(panel, catalog, this.store, ref, async () => (await trees.captureObservation()).observation);
		const implementation = new ImplementationAgent(authority, gateway, boundary, catalog, trees, this.store, ref);
		const normalizer = new Normalizer(authority, policy, trees);
		const backend =
			repository.kind === "git"
				? {
						kind: "git" as const,
						service: new GitTransactionService(
							authority,
							this.store,
							ref,
							repository,
							this.runner,
							join(ref.directory, "scratch", "git-transaction"),
						),
					}
				: { kind: "jj" as const, service: new JjTransactionService(authority, this.store, ref, repository, this.runner, trees) };
		const repair = new RepairAgent(authority, gateway, boundary, catalog, trees, this.store, ref);
		const qualifier = new QualifyAndCommit(
			policy,
			catalog,
			normalizer,
			trees,
			gates,
			panel,
			gateway,
			this.store,
			ref,
			backend,
			repair,
		);
		if (request.workflow === "build") {
			await runBuildWorkflow({
				origin: request.origin,
				policy,
				catalog,
				authority,
				gateway,
				trees,
				preflight,
				approver,
				implementation,
				qualifier,
				store: this.store,
				ref,
				repositoryKind: repository.kind,
				get approvedAt() {
					return runtimeTimestamp(this, "approvedAt");
				},
				get checkpointedAt() {
					return runtimeTimestamp(this, "checkpointedAt");
				},
				get authorizedAt() {
					return runtimeTimestamp(this, "authorizedAt");
				},
				get completedAt() {
					return runtimeTimestamp(this, "completedAt");
				},
			});
			return;
		}
		const regression = new RegressionAgent(authority, gateway, boundary, catalog, trees, gates, this.store, ref);
		await runFixWorkflow({
			origin: request.origin,
			policy,
			catalog,
			authority,
			gateway,
			trees,
			gates,
			boundary,
			preflight,
			regression,
			approver,
			implementation,
			qualifier,
			store: this.store,
			ref,
			repositoryKind: repository.kind,
			get regressionCheckpointedAt() {
				return runtimeTimestamp(this, "regressionCheckpointedAt");
			},
			get approvedAt() {
				return runtimeTimestamp(this, "approvedAt");
			},
			get implementationCheckpointedAt() {
				return runtimeTimestamp(this, "implementationCheckpointedAt");
			},
			get authorizedAt() {
				return runtimeTimestamp(this, "authorizedAt");
			},
			get completedAt() {
				return runtimeTimestamp(this, "completedAt");
			},
		});
	}
}
