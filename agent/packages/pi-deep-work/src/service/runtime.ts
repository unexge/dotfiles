import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { AgentGateway, type AgentProgressListener } from "../agents/gateway.ts";
import type { DesignReport } from "../agents/schemas.ts";
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
import { ReviewPanel, type CanonicalFinding } from "../review/panel.ts";
import { decodeResolutionArtifact } from "../review/resolution.ts";
import { digestFrozenArtifact } from "../review/subjects.ts";
import {
	loadDesignHandoff,
	type DesignHandoff,
} from "../review/design-handoff.ts";
import { RunStore, type RunRef } from "../store/run-store.ts";
import { loadContinuationFeedback, loadWriteContinuation } from "./continuation.ts";
import { loadRunRecords, type RepositoryRecord } from "./records.ts";
import {
	restoreRedContextEvidence,
	type BuildWriteContext,
	type FixWriteContext,
} from "./write-context.ts";
import {
	resumeBuildFromContext,
	resumeFixFromContext,
} from "./write-resume.ts";
import {
	decodeRunProjection,
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

export interface ResolutionSource {
	runId: string;
	workflow: "build" | "fix";
	artifactDigest: string;
	findings: readonly CanonicalFinding[];
	feedback: string;
	design?: DesignReport;
	writeContext?: BuildWriteContext | FixWriteContext;
}

export interface StartRequest {
	workflow: WorkflowKind;
	origin: UserOrigin;
	base?: string;
	unslopSource?: UnslopSource;
	sourceDesignRunId?: string;
	designFeedback?: string;
	designSource?: DesignHandoff;
	resolutionSource?: ResolutionSource;
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
		const requestWithSource = await this.resolveDesignSource(request, repository.repositoryId);
		if (requestWithSource.resolutionSource) {
			const sourceRef = await this.store.find(requestWithSource.resolutionSource.runId);
			const sourceState = await this.store.load(sourceRef);
			if (sourceState.goal !== request.origin.goal || sourceState.policyDigest !== policy.digest || sourceRef.backend !== repository.kind) {
				throw new Error("Resolution source contradicts workflow goal, backend, or policy");
			}
			await this.prepareResolution(sourceRef, ctx);
		}
		if (requestWithSource.workflow === "build" || requestWithSource.workflow === "fix") {
			const catalog = await TrustedCommandCatalog.build(policy, repository.root);
			catalog.assertWriteReady(requestWithSource.workflow);
		}
		const models = this.modelResolver(ctx.modelRegistry, policy.machine);
		const queued = this.queued(requestWithSource, repository, policy.digest);
		const ref = await this.store.create(repository.kind, queued);
		const created = await this.store.load(ref);
		if (created.lifecycle !== "Queued") throw new Error("New run did not remain Queued after creation");
		const currentAttemptId = attemptId(randomUUID());
		try {
			await this.persistRequest(ref, requestWithSource, repository);
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
					phase: requestWithSource.workflow,
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
			await this.dispatch(requestWithSource, ctx, repository, policy, models, ref, authority, hooks.onProgress);
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
		if (state.workflow === "build" || state.workflow === "fix") {
			const catalog = await TrustedCommandCatalog.build(policy, repository.root);
			catalog.assertWriteReady(state.workflow);
		}
		const models = this.modelResolver(ctx.modelRegistry, policy.machine);
		const origin = userOriginForPersistedGoal(commandOrigin, state.goal);
		const resolutionFields = [
			records.request.resolutionSourceRunId,
			records.request.resolutionArtifactDigest,
			records.request.resolutionFeedback,
		];
		if (resolutionFields.some(Boolean) && !resolutionFields.every(Boolean)) {
			throw new Error("Persisted resolution lineage is incomplete");
		}
		const resolutionSource = records.request.resolutionSourceRunId
			? await this.loadResolutionSource(
					records.request.resolutionSourceRunId,
					repository.repositoryId,
					records.request.resolutionArtifactDigest!,
					records.request.resolutionFeedback!,
				)
			: undefined;
		if (state.workflow === "fix" || state.workflow === "build") {
			if (await loadWriteContinuation(this.store, ref)) return this.resumeWrite(ref, state, origin, ctx, repository, policy, models, hooks);
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
		const request = await this.resolveDesignSource(
			{
				workflow: state.workflow,
				origin,
				...(records.request.base ? { base: records.request.base } : {}),
				...(records.request.unslopSource ? { unslopSource: records.request.unslopSource } : {}),
				...(records.request.sourceDesignRunId ? { sourceDesignRunId: records.request.sourceDesignRunId } : {}),
				...(records.request.designFeedback ? { designFeedback: records.request.designFeedback } : {}),
				...(resolutionSource ? { resolutionSource } : {}),
			},
			repository.repositoryId,
		);
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
		const continuation = await loadWriteContinuation(this.store, ref);
		if (!continuation) throw new Error("Write resume has no durable workflow context");
		const { context, checkpoint, evidenceRef } = continuation;
		const records = await loadRunRecords(this.store, ref);
		const resolution = records.request.resolutionSourceRunId
			? await this.loadResolutionSource(records.request.resolutionSourceRunId, ref.repositoryId, records.request.resolutionArtifactDigest!, records.request.resolutionFeedback!)
			: undefined;
		const observation =
			repository.kind === "git"
				? await captureGitObservation(repository, policy.digest, this.runner)
				: await captureJjObservation(repository, policy.digest, this.runner);
		if (observationSubjectDigest(observation) !== continuation.observationDigest) {
			throw new Error("Write resume checkout differs from the latest safe workflow checkpoint");
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
			const lockedContinuation = await loadWriteContinuation(this.store, ref);
			if (canonicalJson(lockedContinuation) !== canonicalJson(continuation)) throw new Error("Write continuation changed under lease");
			const expectedDigest = continuation.observationDigest;
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
			const implementation = new ImplementationAgent(authority, gateway, boundary, trees, this.store, ref);
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
			const repair = new RepairAgent(authority, gateway, boundary, trees, this.store, ref);
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
			const active = await this.store.load(ref);
			if (active.lifecycle !== "Active") throw new Error("Write continuation requires an Active run");
			const resolutionInputs = {
				resolutionFeedback: await loadContinuationFeedback(this.store, ref),
				...(resolution?.design ? { resolutionDesign: resolution.design } : {}),
			};
			if (context.workflow === "build") {
				await resumeBuildFromContext({
					context: { ...context, attemptId: active.attemptId },
					...resolutionInputs,
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
			} else {
				await resumeFixFromContext({
					context: { ...context, attemptId: active.attemptId },
					...resolutionInputs,
					evidenceRef,
					maxRevisionRounds: policy.machine.maxRepairRounds,
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

	async prepareResolution(ref: RunRef, ctx: ExtensionCommandContext): Promise<ResolutionSource> {
		const records = await loadRunRecords(this.store, ref);
		const repository = await detectRepository(ctx.cwd, this.runner);
		if (!sameRepository(repository, records.repository) || repository.kind !== ref.backend) {
			throw new Error("Resolution source belongs to another repository or checkout");
		}
		const state = await this.store.load(ref);
		if (state.lifecycle !== "Completed" || state.outcome !== "ChangesRequired") throw new Error("Resolution source is not completed with ChangesRequired");
		const policy = await loadResolvedPolicy(ctx, {
			machine: join(this.agentDir, "pi-deep-work", "config.json"), canonicalRoot: repository.root,
		});
		if (policy.digest !== state.policyDigest) throw new Error("Resolution policy digest changed");
		const source = await this.loadResolutionSource(ref.runId, ref.repositoryId,
			digestFrozenArtifact(await this.store.readArtifact(ref, state.summaryArtifact)), "pending operator feedback");
		if (state.workflow !== "build" && state.workflow !== "fix") throw new Error("Resolution source is not a write workflow");
		const catalog = await TrustedCommandCatalog.build(policy, repository.root);
		catalog.assertWriteReady(state.workflow);
		const continuation = await loadWriteContinuation(this.store, ref);
		if (continuation?.context.workflow === "fix") {
			restoreRedContextEvidence(continuation.context, catalog);
		}
		const expected = continuation?.observationDigest;
		const observation = repository.kind === "git"
			? await captureGitObservation(repository, policy.digest, this.runner)
			: await captureJjObservation(repository, policy.digest, this.runner);
		if (expected ? observationSubjectDigest(observation) !== expected : observation.conflicted || observation.changedPathsDigest !== changedPathsDigest([])) {
			throw new Error("Resolution checkout differs from the latest workflow checkpoint");
		}
		return source;
	}

	private async loadResolutionSource(
		sourceRunId: string,
		repositoryId: string,
		expectedArtifactDigest: string,
		feedback: string,
	): Promise<ResolutionSource> {
		const ref = await this.store.find(sourceRunId);
		if (ref.repositoryId !== repositoryId) throw new Error("Resolution source belongs to another repository");
		const state = await this.store.load(ref);
		if (
			(state.workflow !== "build" && state.workflow !== "fix") ||
			state.lifecycle !== "Completed" ||
			state.outcome !== "ChangesRequired"
		) {
			throw new Error("Resolution source is not a completed ChangesRequired write workflow");
		}
		const bytes = await this.store.readArtifact(ref, state.summaryArtifact);
		if (digestFrozenArtifact(bytes) !== expectedArtifactDigest) {
			throw new Error("Resolution source artifact digest changed");
		}
		const summary: unknown = JSON.parse(bytes.toString("utf8"));
		const artifact = decodeResolutionArtifact(summary);
		const metadata = summary as Record<string, unknown>;
		if (metadata.goal !== state.goal || metadata.proposedOutcome !== state.outcome) {
			throw new Error("Resolution summary contradicts run metadata");
		}
		if (artifact.design && metadata.designDigest !== digestFrozenArtifact(canonicalJson(artifact.design))) {
			throw new Error("Latest rejected design digest mismatch");
		}
		const continuation = await loadWriteContinuation(this.store, ref);
		const writeContext = continuation?.context;
		if (writeContext?.stage === "red" && !artifact.design) {
			throw new Error("Latest rejected fix design bytes are missing; cannot substitute an ancestor design");
		}
		if (!artifact.design && !writeContext) throw new Error("Resolution source has no design or write context");
		return {
			runId: ref.runId,
			workflow: state.workflow,
			artifactDigest: expectedArtifactDigest,
			...(artifact.design ? { design: artifact.design } : {}),
			...(writeContext ? { writeContext } : {}),
			findings: artifact.findings,
			feedback,
		};
	}

	private async resolveDesignSource(request: StartRequest, repositoryId: string): Promise<StartRequest> {
		if (request.resolutionSource) {
			if (
				(request.workflow !== "build" && request.workflow !== "fix") ||
				request.workflow !== request.resolutionSource.workflow ||
				request.sourceDesignRunId ||
				request.designSource ||
				request.designFeedback
			) {
				throw new Error("A resolution source must match its write workflow without another design source");
			}
			const loaded = await this.loadResolutionSource(
				request.resolutionSource.runId,
				repositoryId,
				request.resolutionSource.artifactDigest,
				request.resolutionSource.feedback,
			);
			if (canonicalJson(loaded) !== canonicalJson(request.resolutionSource)) {
				throw new Error("Resolution source contradicts its durable artifact");
			}
			return { ...request, resolutionSource: loaded };
		}
		if (!request.sourceDesignRunId) {
			if (request.designFeedback || request.designSource) throw new Error("Design feedback requires a source design run");
			return request;
		}
		if (request.workflow !== "design" && request.workflow !== "build") {
			throw new Error("Only design and build workflows accept a source design");
		}
		const source = await loadDesignHandoff(this.store, request.sourceDesignRunId, repositoryId);
		if (request.workflow === "design" && !request.designFeedback) {
			throw new Error("Design revision requires operator feedback");
		}
		if (request.workflow === "build" && !source.approvedDesign) {
			throw new Error("Build requires a DesignApproved source run");
		}
		return {
			...request,
			origin: userOriginForPersistedGoal(request.origin, source.goal),
			sourceDesignRunId: source.runId,
			designSource: source,
		};
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
					...(request.sourceDesignRunId ? { sourceDesignRunId: request.sourceDesignRunId } : {}),
					...(request.designFeedback ? { designFeedback: request.designFeedback } : {}),
					...(request.resolutionSource
						? {
								resolutionSourceRunId: request.resolutionSource.runId,
								resolutionArtifactDigest: request.resolutionSource.artifactDigest,
								resolutionFeedback: request.resolutionSource.feedback,
							}
						: {}),
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
					maxRevisionRounds: policy.machine.maxRepairRounds,
					...(request.designSource ? { source: request.designSource, feedback: request.designFeedback! } : {}),
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
		if (request.resolutionSource) await this.resolveDesignSource(request, repository.repositoryId);
		const preflight = new WritePreflight(authority, trees, repository, policy, this.runner);
		const approver = new DesignApprover(panel, catalog, this.store, ref, async () => (await trees.captureObservation()).observation);
		const implementation = new ImplementationAgent(authority, gateway, boundary, trees, this.store, ref);
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
		const repair = new RepairAgent(authority, gateway, boundary, trees, this.store, ref);
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
		if (request.resolutionSource?.writeContext) {
			const continuation = await loadWriteContinuation(this.store, ref);
			if (!continuation) throw new Error("Resolution has no durable write context");
			const current = await trees.captureObservation();
			if (observationSubjectDigest(current.observation) !== continuation.observationDigest) {
				await authority.manualInspection("Resolution checkout differs from the latest workflow checkpoint", new Date().toISOString());
				return;
			}
			const active = await this.store.load(ref);
			if (active.lifecycle !== "Active") throw new Error("Resolution requires an Active run");
			const context = { ...continuation.context, attemptId: active.attemptId };
			const common = {
				origin: request.origin, authority, gateway, trees, implementation, qualifier,
				store: this.store, ref,
				checkpoint: continuation.checkpoint,
				completedAt: () => new Date().toISOString(),
				resolutionFeedback: await loadContinuationFeedback(this.store, ref),
			};
			if (context.workflow === "build") {
				await resumeBuildFromContext({ ...common, context });
			} else {
				await resumeFixFromContext({
					...common, context, approver, catalog, gates,
					evidenceRef: continuation.evidenceRef,
					maxRevisionRounds: policy.machine.maxRepairRounds,
					...(request.resolutionSource.design ? { resolutionDesign: request.resolutionSource.design } : {}),
				});
			}
			return;
		}
		if (request.workflow === "build") {
			await runBuildWorkflow({
				origin: request.origin,
				...(request.designSource ? { sourceDesign: request.designSource, designFeedback: request.designFeedback } : {}),
				...(request.resolutionSource?.design
					? {
							resolutionSource: {
								runId: request.resolutionSource.runId,
								artifactDigest: request.resolutionSource.artifactDigest,
								design: request.resolutionSource.design,
								findings: request.resolutionSource.findings,
								feedback: await loadContinuationFeedback(this.store, ref),
							},
						}
					: {}),
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
