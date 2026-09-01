import type { AttemptId, WorkflowOutcome } from "./types.ts";
import {
	blockRun,
	cancelRun,
	observeControl,
	completeRun,
	failRun,
	requireManualInspection,
	requestPause,
	resumeRun,
	settlePause,
	startRun,
} from "./lifecycle.ts";
import type { LeaseHandle, PortableLeaseManager } from "../lease/repository-lease.ts";
import type { DetectedRepository } from "../vcs/types.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import type { ActiveRun, QueuedRun, RecoverableRun, RunProjection } from "../store/schemas.ts";

export class RunAuthorityClosedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunAuthorityClosedError";
	}
}

export class ControlAcceptedError extends Error {
	constructor(readonly kind: "Pause" | "Cancel") {
		super(`${kind} control accepted`);
		this.name = "ControlAcceptedError";
	}
}

export class MutationRecoveryRequiredError extends Error {
	constructor(message: string, cause?: unknown, readonly controlKind?: "Pause" | "Cancel") {
		super(message, { cause });
		this.name = "MutationRecoveryRequiredError";
	}
}

export interface MutationEffectOptions {
	requiresManualInspection(): boolean;
	reason: string;
}

export interface PublicationOptions<T> {
	markerDigest: string;
	outcome: WorkflowOutcome;
	summaryArtifact: string;
	at: string;
	/** Local backend publication only. It must settle within 60s and must not call a controls-lock-guarded store method. */
	publish(marker: unknown): Promise<T>;
	/** Runs under the controls lock and must not re-enter a controls-lock-guarded store method. */
	abortPreparation(marker: unknown, kind: "Pause" | "Cancel"): Promise<void>;
	/** Runs outside the control lock while both run and repository leases remain held. */
	align(value: T): Promise<void>;
}

interface AuthorityOptions {
	store: RunStore;
	leases: PortableLeaseManager;
	ref: RunRef;
	repository: DetectedRepository;
	attemptId: AttemptId;
	phase: string;
	pollIntervalMs?: number;
}

export class RunAuthority {
	private projection: ActiveRun;
	private readonly runLease: LeaseHandle;
	private readonly repositoryLease: LeaseHandle;
	private readonly pollIntervalMs: number;
	private observedControlRevision = 0;
	private effectActive = false;
	private closed = false;

	private constructor(
		private readonly store: RunStore,
		private readonly ref: RunRef,
		projection: ActiveRun,
		runLease: LeaseHandle,
		repositoryLease: LeaseHandle,
		pollIntervalMs: number,
	) {
		this.projection = projection;
		this.runLease = runLease;
		this.repositoryLease = repositoryLease;
		this.pollIntervalMs = pollIntervalMs;
	}

	static async start(options: AuthorityOptions, queued: QueuedRun, at: string): Promise<RunAuthority> {
		return this.open(options, startRun(queued, options.attemptId, options.phase, at), "AttemptStarted", at, 0);
	}

	static async resume(options: AuthorityOptions, recoverable: RecoverableRun, at: string): Promise<RunAuthority> {
		return this.open(
			options,
			resumeRun(recoverable, options.attemptId, options.phase, at),
			"AttemptStarted",
			at,
			recoverable.observedControlRevision,
		);
	}

	private static async open(
		options: AuthorityOptions,
		active: ActiveRun,
		kind: "AttemptStarted",
		at: string,
		initialControlRevision: number,
	): Promise<RunAuthority> {
		const runLease = await options.leases.acquire({
			scope: "run",
			runId: options.ref.runId,
			attemptId: options.attemptId,
		});
		let repositoryLease: LeaseHandle | undefined;
		let authority: RunAuthority | undefined;
		try {
			repositoryLease = await options.leases.acquire({
				scope: "repository",
				repositoryId: options.repository.repositoryId,
				runId: options.ref.runId,
				attemptId: options.attemptId,
			});
			const projection = await options.store.appendTransition(options.ref, kind, active, at);
			if (projection.lifecycle !== "Active") throw new Error("Attempt start did not produce Active lifecycle");
			authority = new RunAuthority(
				options.store,
				options.ref,
				projection,
				runLease,
				repositoryLease,
				options.pollIntervalMs ?? 200,
			);
			authority.observedControlRevision = initialControlRevision;
			const pending = await authority.nextControl();
			if (pending) {
				await authority.acceptControl(pending.kind, `${pending.kind.toLowerCase()} before attempt`, pending.requestedAt);
				throw new ControlAcceptedError(pending.kind);
			}
			return authority;
		} catch (error) {
			if (authority && !authority.closed) {
				await authority.fail(error instanceof Error ? error.message : String(error), at).catch(() => undefined);
			} else if (!authority) {
				if (repositoryLease) await repositoryLease.release().catch(() => undefined);
				await runLease.release().catch(() => undefined);
			}
			throw error;
		}
	}

	state(): ActiveRun {
		if (this.closed) throw new RunAuthorityClosedError("Run authority is closed");
		return this.projection;
	}

	async abandonForRecovery(): Promise<void> {
		this.assertIdle();
		this.closed = true;
		await this.releaseLeases();
	}

	async requestControl(kind: "Pause" | "Cancel", at: string): Promise<void> {
		await this.store.appendControl(this.ref, kind, at);
	}

	async publish<T>(options: PublicationOptions<T>): Promise<T> {
		this.assertIdle();
		this.effectActive = true;
		let terminal = false;
		try {
			const transaction = await this.store.withPublicationControl(this.ref, options.markerDigest, async (context) => {
				if (
					context.state.lifecycle !== "Active" ||
					context.state.attemptId !== this.projection.attemptId ||
					context.state.lastEventRevision !== this.projection.lastEventRevision
				) {
					throw new Error("Publication state no longer matches RunAuthority");
				}
				const unseen = context.controls.requests.filter(
					(request) => request.revision > this.observedControlRevision,
				);
				this.observedControlRevision = context.controls.revision;
				const control = unseen.findLast((request) => request.kind === "Cancel") ?? unseen[0];
				if (control) {
					await options.abortPreparation(context.marker, control.kind);
					await context.clearMarker();
					return { kind: "control" as const, control };
				}
				await context.markPublishing();
				const value = await options.publish(context.marker);
				const completed = completeRun(this.projection, options.outcome, options.summaryArtifact, options.at);
				await this.store.appendTransition(this.ref, "OutcomeRecorded", completed, options.at);
				terminal = true;
				const alignmentMarkerDigest = await context.markAligning();
				return { kind: "published" as const, value, alignmentMarkerDigest };
			});
			this.effectActive = false;
			if (transaction.kind === "control") {
				await this.acceptControl(
					transaction.control.kind,
					`${transaction.control.kind.toLowerCase()} before publication`,
					transaction.control.requestedAt,
				);
				throw new ControlAcceptedError(transaction.control.kind);
			}
			const completionErrors: unknown[] = [];
			try {
				await options.align(transaction.value);
			} catch (error) {
				completionErrors.push(error);
			}
			if (completionErrors.length === 0) {
				try {
					await this.store.clearAligningPublicationMarker(this.ref, transaction.alignmentMarkerDigest);
				} catch (error) {
					completionErrors.push(error);
				}
			}
			this.closed = true;
			try {
				await this.releaseLeases();
			} catch (error) {
				completionErrors.push(error);
			}
			if (completionErrors.length > 0) {
				throw new AggregateError(
					completionErrors,
					`Publication completed but cleanup failed: ${completionErrors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
				);
			}
			return transaction.value;
		} catch (error) {
			this.effectActive = false;
			if (terminal && !this.closed) {
				this.closed = true;
				await this.releaseLeases().catch(() => undefined);
			}
			throw error;
		}
	}

	async runEffect<T>(name: string, effect: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return this.runEffectInternal(name, effect);
	}

	async runMutationEffect<T>(
		name: string,
		effect: (signal: AbortSignal) => Promise<T>,
		options: MutationEffectOptions,
	): Promise<T> {
		return this.runEffectInternal(name, effect, options);
	}

	private async runEffectInternal<T>(
		name: string,
		effect: (signal: AbortSignal) => Promise<T>,
		mutation?: MutationEffectOptions,
	): Promise<T> {
		this.assertOpen();
		if (this.effectActive) throw new Error(`Effect already active while starting ${name}`);
		this.effectActive = true;
		let before: { kind: "Pause" | "Cancel"; requestedAt: string } | undefined;
		try {
			before = await this.nextControl();
		} catch (error) {
			this.effectActive = false;
			if (mutation && this.mutationRequiresInspection(mutation)) {
				return this.stopForMutationInspection(mutation, error);
			}
			return this.failForCause(error, new Date().toISOString());
		}
		if (before) {
			this.effectActive = false;
			if (mutation && this.mutationRequiresInspection(mutation)) {
				return this.stopForMutationInspection(mutation, undefined, before.kind);
			}
			await this.acceptControl(before.kind, `${before.kind.toLowerCase()} before ${name}`, before.requestedAt);
			throw new ControlAcceptedError(before.kind);
		}

		const controller = new AbortController();
		let stopPolling = false;
		let wakePolling: (() => void) | undefined;
		let accepted: { kind: "Pause" | "Cancel"; requestedAt: string } | undefined;
		let pollingError: unknown;
		const poller = (async () => {
			try {
				while (!stopPolling && !accepted) {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, this.pollIntervalMs);
						timer.unref?.();
						wakePolling = () => {
							clearTimeout(timer);
							resolve();
						};
					});
					wakePolling = undefined;
					if (stopPolling) break;
					accepted = await this.nextControl();
					if (accepted) controller.abort(new ControlAcceptedError(accepted.kind));
				}
			} catch (error) {
				pollingError = error;
				controller.abort(error);
			}
		})();

		let result: T | undefined;
		let effectError: unknown;
		try {
			result = await effect(controller.signal);
		} catch (error) {
			effectError = error;
		}
		stopPolling = true;
		wakePolling?.();
		await poller;
		if (!pollingError && !accepted) {
			try {
				accepted = await this.nextControl();
			} catch (error) {
				pollingError = error;
			}
		}
		this.effectActive = false;

		if (pollingError) {
			if (mutation && this.mutationRequiresInspection(mutation)) {
				return this.stopForMutationInspection(mutation, pollingError);
			}
			return this.failForCause(pollingError, new Date().toISOString());
		}
		if (accepted) {
			if (mutation && this.mutationRequiresInspection(mutation)) {
				return this.stopForMutationInspection(mutation, effectError, accepted.kind);
			}
			const interruptedByControl = effectError === controller.signal.reason || effectError instanceof ControlAcceptedError;
			if (effectError && !interruptedByControl) return this.failForCause(effectError, new Date().toISOString());
			await this.acceptControl(accepted.kind, `${accepted.kind.toLowerCase()} during ${name}`, accepted.requestedAt);
			throw new ControlAcceptedError(accepted.kind);
		}
		if (effectError) {
			if (mutation && this.mutationRequiresInspection(mutation)) {
				return this.stopForMutationInspection(mutation, effectError);
			}
			return this.failForCause(effectError, new Date().toISOString());
		}
		return result as T;
	}

	async pause(reason: string, at: string): Promise<RunProjection> {
		this.assertIdle();
		await this.store.assertNoPublicationMarker(this.ref);
		const pausing = requestPause(this.projection, at);
		this.projection = (await this.store.appendTransition(this.ref, "ControlObserved", pausing, at)) as ActiveRun;
		const paused = settlePause(this.projection, reason, at, this.observedControlRevision);
		return this.stop(paused, at);
	}

	/** Checkout safety state always supersedes controls; all callers use this only after observed or possible mutation. */
	async manualInspection(reason: string, at: string): Promise<RunProjection> {
		this.assertIdle();
		// Checkout safety supersedes Pause/Cancel; any control not yet observed remains eligible on resume.
		return this.stop(requireManualInspection(this.projection, reason, at, this.observedControlRevision), at);
	}

	async block(reason: string, at: string): Promise<RunProjection> {
		this.assertIdle();
		await this.honorPendingControl("block", at);
		return this.stop(blockRun(this.projection, reason, at, this.observedControlRevision), at);
	}

	async cancel(reason: string, at: string): Promise<RunProjection> {
		this.assertIdle();
		await this.store.assertNoPublicationMarker(this.ref);
		this.projection = (await this.store.appendTransition(
			this.ref,
			"ControlObserved",
			observeControl(this.projection, at),
			at,
		)) as ActiveRun;
		return this.stop(cancelRun(this.projection, reason, at), at);
	}

	async fail(reason: string, at: string): Promise<RunProjection> {
		this.assertIdle();
		return this.stop(failRun(this.projection, reason, at), at);
	}

	async complete(outcome: WorkflowOutcome, summaryArtifact: string, at: string): Promise<RunProjection> {
		this.assertIdle();
		await this.honorPendingControl("completion", at);
		return this.stop(completeRun(this.projection, outcome, summaryArtifact, at), at, "OutcomeRecorded");
	}

	private async honorPendingControl(context: string, at: string): Promise<void> {
		let pending: { kind: "Pause" | "Cancel"; requestedAt: string } | undefined;
		try {
			pending = await this.nextControl();
		} catch (error) {
			return this.failForCause(error, at);
		}
		if (pending) {
			await this.acceptControl(pending.kind, `${pending.kind.toLowerCase()} before ${context}`, pending.requestedAt);
			throw new ControlAcceptedError(pending.kind);
		}
	}

	private mutationRequiresInspection(options: MutationEffectOptions): boolean {
		try {
			return options.requiresManualInspection();
		} catch {
			return true;
		}
	}

	private async stopForMutationInspection(
		options: MutationEffectOptions,
		cause: unknown,
		controlKind?: "Pause" | "Cancel",
	): Promise<never> {
		const at = new Date().toISOString();
		await this.stop(requireManualInspection(this.projection, options.reason, at, this.observedControlRevision), at);
		throw new MutationRecoveryRequiredError(options.reason, cause, controlKind);
	}

	private async failForCause(error: unknown, at: string): Promise<never> {
		try {
			await this.fail(error instanceof Error ? error.message : String(error), at);
		} catch (stopError) {
			throw new AggregateError([error, stopError], "Effect failed and RunAuthority could not stop cleanly");
		}
		throw error;
	}

	private async acceptControl(kind: "Pause" | "Cancel", reason: string, at: string): Promise<void> {
		if (kind === "Pause") await this.pause(reason, at);
		else await this.cancel(reason, at);
	}

	private async nextControl(): Promise<{ kind: "Pause" | "Cancel"; requestedAt: string } | undefined> {
		const controls = await this.store.controls(this.ref);
		const unseen = controls.requests.filter((request) => request.revision > this.observedControlRevision);
		this.observedControlRevision = controls.revision;
		return unseen.findLast((request) => request.kind === "Cancel") ?? unseen[0];
	}

	private async stop(
		projection: RunProjection,
		at: string,
		kind: "AttemptStopped" | "OutcomeRecorded" = "AttemptStopped",
	): Promise<RunProjection> {
		await this.store.assertNoPublicationMarker(this.ref);
		let stopped: RunProjection | undefined;
		let transitionError: unknown;
		try {
			stopped = await this.store.appendTransition(this.ref, kind, projection, at);
		} catch (error) {
			transitionError = error;
		}
		this.closed = true;
		let releaseError: unknown;
		try {
			await this.releaseLeases();
		} catch (error) {
			releaseError = error;
		}
		if (transitionError || releaseError) {
			throw new AggregateError(
				[transitionError, releaseError].filter((error) => error !== undefined),
				"RunAuthority stop did not complete cleanly",
			);
		}
		return stopped!;
	}

	private async releaseLeases(): Promise<void> {
		const errors: unknown[] = [];
		try {
			await this.repositoryLease.release();
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.runLease.release();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, "Failed to release all run authority leases");
	}

	private assertOpen(): void {
		if (this.closed) throw new RunAuthorityClosedError("Run authority is closed");
	}

	private assertIdle(): void {
		this.assertOpen();
		if (this.effectActive) throw new Error("Cannot transition lifecycle while an effect is active");
	}
}
