import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { UserOrigin } from "../application/user-origin.ts";
import { assertUserOrigin, userOriginForPersistedGoal } from "../application/user-origin.ts";
import type { RunProjection } from "../store/schemas.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import { decodeResolutionArtifact } from "../review/resolution.ts";
import { digestFrozenArtifact } from "../review/subjects.ts";
import type { RunRef } from "../store/run-store.ts";
import { captureGitObservation } from "../vcs/git-backend.ts";
import { captureJjObservation } from "../vcs/jj-backend.ts";
import { detectRepository } from "../vcs/detect.ts";
import { commandRunner } from "../vcs/runner.ts";
import { VcsDetectionError } from "../vcs/types.ts";
import { loadRunRecords } from "./records.ts";
import { readBuildContext, readFixContext } from "./write-context.ts";
import { WorkflowRuntime, type ResolutionSource, type StartRequest } from "./runtime.ts";
import type { ParsedCommand } from "./command.ts";
import {
	DeepWorkRunPresentation,
	deepWorkRunEntryType,
} from "./presentation.ts";

interface ActiveRun {
	ref: RunRef;
	promise: Promise<void>;
}

export class DeepWorkService {
	private readonly active = new Map<string, ActiveRun>();
	private readonly pendingOperations = new Set<Promise<void>>();
	private shuttingDown = false;

	constructor(
		private readonly pi: ExtensionAPI,
		readonly runtime = new WorkflowRuntime(),
	) {}

	async execute(command: ParsedCommand, origin: UserOrigin, ctx: ExtensionCommandContext): Promise<void> {
		assertUserOrigin(origin);
		switch (command.kind) {
			case "start":
				await this.start(command, origin, ctx);
				return;
			case "status":
				await this.status(command.runId, ctx);
				return;
			case "cancel":
				await this.control("Cancel", command.runId, ctx);
				return;
			case "resume":
				await this.resume(command.runId, origin, ctx);
				return;
			case "resolve":
				await this.resolve(command.runId, command.accept, origin, ctx);
				return;
			case "recover":
				await this.recover(command.runId, command.challenge, origin, ctx);
				return;
			case "help":
			case "config":
				throw new Error(`${command.kind} is handled by the registered command boundary`);
		}
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		const active = [...this.active.values()];
		await Promise.all(
			active.map(async ({ ref }) => {
				await this.runtime.store.appendControl(ref, "Pause", new Date().toISOString()).catch(() => undefined);
			}),
		);
		const settled = await Promise.race([
			Promise.allSettled([...this.pendingOperations, ...active.map((value) => value.promise)]).then(() => true),
			new Promise<false>((resolve) => {
				const timer = setTimeout(() => resolve(false), 60_000);
				timer.unref?.();
			}),
		]);
		if (!settled) {
			this.pi.sendMessage({
				customType: "deep-work-shutdown-warning",
				content: "Deep-work shutdown timed out; durable Pause requests remain pending for recovery.",
				display: true,
				details: { schemaVersion: 1, activeRunIds: active.map((value) => value.ref.runId) },
			});
		}
	}

	private async start(
		command: Extract<ParsedCommand, { kind: "start" }>,
		origin: UserOrigin,
		ctx: ExtensionCommandContext,
		requestOverride?: StartRequest,
	): Promise<void> {
		if (this.shuttingDown) throw new Error("Deep-work is shutting down and cannot start another run");
		const request: StartRequest = requestOverride ?? {
			workflow: command.workflow,
			origin,
			...(command.base ? { base: command.base } : {}),
			...(command.sourceDesignRunId ? { sourceDesignRunId: command.sourceDesignRunId } : {}),
			...(command.designFeedback ? { designFeedback: command.designFeedback } : {}),
			...(command.workflow === "unslop"
				? { unslopSource: command.unslopText ? { kind: "text", text: command.unslopText } : { kind: "diff", ...(command.base ? { base: command.base } : {}) } }
				: {}),
		};
		let ref: RunRef | undefined;
		let presentation: DeepWorkRunPresentation | undefined;
		let resolveCompletion!: () => void;
		let rejectCompletion!: (error: unknown) => void;
		const completion = new Promise<void>((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});
		this.pendingOperations.add(completion);
		const operation = (async () => {
			try {
				const result = await this.runtime.start(request, ctx, {
					onStarted: (startedRef) => {
						ref = startedRef;
						this.active.set(startedRef.runId, { ref: startedRef, promise: completion });
						presentation = this.renderActive(startedRef, ctx);
						if (this.shuttingDown) {
							void this.runtime.store.appendControl(startedRef, "Pause", new Date().toISOString()).catch(() => undefined);
						}
					},
					onProgress: (progress) => presentation?.handle(progress),
				});
				await this.publish(result.ref, result.state, ctx);
			} finally {
				if (ref) this.active.delete(ref.runId);
				presentation?.clear();
			}
		})();
		operation.then(resolveCompletion, rejectCompletion);
		try {
			await completion;
		} finally {
			this.pendingOperations.delete(completion);
		}
	}

	private async resolve(
		runId: string,
		accept: boolean,
		commandOrigin: UserOrigin,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (!accept && !ctx.hasUI) throw new Error("/deep resolve requires interactive or RPC UI mode");
		const ref = await this.runtime.store.find(runId);
		const state = await this.runtime.store.load(ref);
		if (state.lifecycle !== "Completed" || state.outcome !== "ChangesRequired") {
			throw new Error(`run ${ref.runId.slice(0, 8)} is not completed with ChangesRequired`);
		}
		if (state.workflow !== "design" && state.workflow !== "build" && state.workflow !== "fix") {
			throw new Error(`/deep resolve does not support ${state.workflow} runs`);
		}
		const bytes = await this.runtime.store.readArtifact(ref, state.summaryArtifact);
		const artifact = decodeResolutionArtifact(JSON.parse(bytes.toString("utf8")));
		let feedback: string;
		if (accept) {
			if (state.workflow !== "design") {
				throw new Error("/deep resolve --accept supports only design runs");
			}
			feedback = artifact.findings.map((finding) => [
				`## ${finding.severity}: ${finding.title}`,
				finding.detail,
				"Decision: Accepted as a known limitation. Proceed without addressing this finding.",
			].join("\n")).join("\n\n");
		} else {
			const mode = await ctx.ui.select("Resolve remaining review findings", [
				"Answer one by one",
				"Edit all at once",
				"Cancel",
			]);
			if (!mode || mode === "Cancel") {
				ctx.ui.notify("Resolution cancelled; no linked workflow was started.", "info");
				return;
			}
			if (mode === "Edit all at once") {
				const template = [
					`Resolve deep-work ${state.workflow} run ${ref.runId.slice(0, 8)}.`,
					"",
					...artifact.findings.flatMap((finding) => [
						`## ${finding.severity}: ${finding.title}`,
						finding.detail,
						"Decision: <enter decision>",
						"",
					]),
				].join("\n");
				feedback = (await ctx.ui.editor("Resolve all remaining review findings", template))?.trim() ?? "";
			} else {
				const decisions: string[] = [];
				for (const [index, finding] of artifact.findings.entries()) {
					const template = [finding.detail, "", "Decision: <enter decision>"].join("\n");
					const decision = (await ctx.ui.editor(
						`Finding ${index + 1}/${artifact.findings.length}: ${finding.title}`,
						template,
					))?.trim();
					if (!decision) {
						ctx.ui.notify("Resolution cancelled; no linked workflow was started.", "info");
						return;
					}
					decisions.push([`## ${finding.severity}: ${finding.title}`, decision].join("\n"));
				}
				feedback = decisions.join("\n\n");
			}
		}
		if (!feedback) {
			ctx.ui.notify("Resolution cancelled; no linked workflow was started.", "info");
			return;
		}
		if (feedback.includes("<enter decision>")) {
			throw new Error("Every review finding requires an operator decision before starting the linked workflow");
		}
		const summary = `Collected ${artifact.findings.length} decision${artifact.findings.length === 1 ? "" : "s"} for ${state.workflow} run ${ref.runId.slice(0, 8)}.`;
		if (!accept && !(await ctx.ui.confirm("Start linked deep-work workflow?", summary))) {
			ctx.ui.notify("Resolution cancelled; no linked workflow was started.", "info");
			return;
		}
		const origin = userOriginForPersistedGoal(commandOrigin, state.goal);
		if (state.workflow === "design") {
			await this.start(
				{
					kind: "start",
					workflow: "design",
					goal: state.goal,
					sourceDesignRunId: ref.runId,
					designFeedback: feedback,
				},
				origin,
				ctx,
			);
			return;
		}
		const writeContext = state.workflow === "build"
			? await readBuildContext(this.runtime.store, ref)
			: await readFixContext(this.runtime.store, ref);
		if (!writeContext && !artifact.design) {
			throw new Error("ChangesRequired artifact has no revisable design or durable write context");
		}
		const resolutionSource: ResolutionSource = {
			runId: ref.runId,
			workflow: state.workflow,
			artifactDigest: digestFrozenArtifact(bytes),
			...(artifact.design ? { design: artifact.design } : {}),
			...(writeContext ? { writeContext } : {}),
			findings: artifact.findings,
			feedback,
		};
		await this.start(
			{ kind: "start", workflow: state.workflow, goal: state.goal },
			origin,
			ctx,
			{ workflow: state.workflow, origin, resolutionSource },
		);
	}

	private async resume(runId: string, origin: UserOrigin, ctx: ExtensionCommandContext): Promise<void> {
		if (this.shuttingDown) throw new Error("Deep-work is shutting down and cannot resume a run");
		const ref = await this.runtime.store.find(runId);
		if (this.active.has(ref.runId)) throw new Error(`run ${ref.runId.slice(0, 8)} is already active`);
		let presentation: DeepWorkRunPresentation | undefined;
		let resolveCompletion!: () => void;
		let rejectCompletion!: (error: unknown) => void;
		const completion = new Promise<void>((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});
		this.pendingOperations.add(completion);
		const operation = (async () => {
			try {
				const result = await this.runtime.resume(ref, origin, ctx, {
					onStarted: (startedRef) => {
						this.active.set(startedRef.runId, { ref: startedRef, promise: completion });
						presentation = this.renderActive(startedRef, ctx);
						if (this.shuttingDown) {
							void this.runtime.store.appendControl(startedRef, "Pause", new Date().toISOString()).catch(() => undefined);
						}
					},
					onProgress: (progress) => presentation?.handle(progress),
				});
				await this.publish(result.ref, result.state, ctx);
			} finally {
				this.active.delete(ref.runId);
				presentation?.clear();
			}
		})();
		operation.then(resolveCompletion, rejectCompletion);
		try {
			await completion;
		} finally {
			this.pendingOperations.delete(completion);
		}
	}

	private async recover(runId: string, challenge: string, origin: UserOrigin, ctx: ExtensionCommandContext): Promise<void> {
		if (this.shuttingDown) throw new Error("Deep-work is shutting down and cannot recover a run");
		const ref = await this.runtime.store.find(runId);
		if (this.active.has(ref.runId)) throw new Error("Cannot recover an active in-process run");
		const operation = (async () => {
			const audit = await this.recoverLeases(ref, challenge);
			const result = await this.runtime.recover(ref, origin);
			await this.runtime.store.writeImmutableArtifact(
				ref,
				`recovery/completed-${audit.id}.json`,
				Buffer.from(canonicalJson({ schemaVersion: 1, requestId: audit.id, status: result.status, ...(result.commitId ? { commitId: result.commitId } : {}) })),
			);
			ctx.ui.notify(
				`Recovery ${result.status.toLowerCase()} for ${ref.runId.slice(0, 8)}${result.commitId ? ` at ${result.commitId}` : ""}`,
				"info",
			);
			await this.publish(ref, result.state, ctx);
		})();
		this.pendingOperations.add(operation);
		try {
			await operation;
		} finally {
			this.pendingOperations.delete(operation);
		}
	}

	private async recoverLeases(ref: RunRef, challenge: string): Promise<{ id: string }> {
		const attempt = randomUUID();
		const requests = [
			{ scope: "run" as const, runId: ref.runId, attemptId: attempt },
			{
				scope: "repository" as const,
				repositoryId: ref.repositoryId,
				runId: ref.runId,
				attemptId: attempt,
			},
		];
		const inspections = await Promise.all(
			requests.map(async (request) => {
				const path = this.runtime.leases.pathFor(request);
				return { request, path, inspection: await this.runtime.leases.inspect(path) };
			}),
		);
		const id = randomUUID();
		await this.runtime.store.writeImmutableArtifact(
			ref,
			`recovery/requested-${id}.json`,
			Buffer.from(
				canonicalJson({
					schemaVersion: 1,
					requestId: id,
					challenge,
					requestedAt: new Date().toISOString(),
					leases: inspections.map((value) => ({
						path: value.path,
						status: value.inspection.status,
						...(value.inspection.owner ? { owner: value.inspection.owner } : {}),
						...(value.inspection.raw ? { raw: value.inspection.raw } : {}),
					})),
				}),
			),
		);
		const allAvailable = inspections.every((value) => value.inspection.status === "available");
		if (allAvailable) {
			if (challenge !== this.availableRecoveryChallenge(ref)) throw new Error("Available-lease recovery challenge mismatch");
			return { id };
		}
		let recovered = 0;
		for (const value of inspections) {
			const inspection = value.inspection;
			const leaseId = value.request.scope === "run" ? ref.runId : ref.repositoryId;
			if (inspection.status === "dead" && inspection.owner && this.runtime.leases.challenge(inspection.owner) === challenge) {
				await this.runtime.leases.recover(value.path, challenge);
				recovered++;
			} else if (
				inspection.status === "malformed" &&
				this.runtime.leases.malformedChallenge(leaseId) === challenge
			) {
				await this.runtime.leases.recoverMalformed(value.path, leaseId, challenge);
				recovered++;
			}
		}
		if (recovered === 0) throw new Error("Recovery challenge does not match a positively dead or malformed lease");
		const remaining = await Promise.all(inspections.map((value) => this.runtime.leases.inspect(value.path)));
		if (remaining.some((inspection) => inspection.status !== "available")) {
			throw new Error("Additional lease recovery challenge is required before transaction recovery");
		}
		return { id };
	}

	private availableRecoveryChallenge(ref: RunRef): string {
		return `available/${ref.runId.slice(0, 8)}`;
	}

	private renderActive(ref: RunRef, ctx: ExtensionCommandContext): DeepWorkRunPresentation {
		const presentation = new DeepWorkRunPresentation(this.pi, ref, ctx);
		this.pi.appendEntry(deepWorkRunEntryType, { schemaVersion: 1, runId: ref.runId, backend: ref.backend });
		return presentation;
	}

	private async control(kind: "Pause" | "Cancel", runId: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		const ref = await this.resolveControlTarget(runId);
		const request = await this.runtime.store.appendControl(ref, kind, new Date().toISOString());
		ctx.ui.notify(`${kind} requested for ${ref.runId.slice(0, 8)} at control revision ${request.revision}`, "info");
	}

	private async resolveControlTarget(runId: string | undefined): Promise<RunRef> {
		if (runId) return this.runtime.store.find(runId);
		if (this.active.size === 0) throw new Error("No active deep-work run");
		if (this.active.size > 1) throw new Error("Multiple runs are active; pass a run ID");
		return [...this.active.values()][0].ref;
	}

	private async status(runId: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		if (runId) {
			const ref = await this.runtime.store.find(runId);
			ctx.ui.notify(await this.statusText(ref), "info");
			return;
		}
		let repository;
		try {
			repository = await detectRepository(ctx.cwd, commandRunner);
		} catch (error) {
			if (error instanceof VcsDetectionError && error.code === "not_repository") {
				ctx.ui.notify("No repository detected from this directory; pass an explicit run ID to inspect another run.", "info");
				return;
			}
			throw error;
		}
		const values = (await this.runtime.store.list(repository.repositoryId)).slice(0, 10);
		ctx.ui.notify(
			values.length > 0
				? (await Promise.all(values.map((value) => this.statusText(value.ref, value.state)))).join("\n\n")
				: "No deep-work runs",
			"info",
		);
	}

	private async statusText(ref: RunRef, loaded?: RunProjection): Promise<string> {
		const state = loaded ?? (await this.runtime.store.load(ref));
		const records = await loadRunRecords(this.runtime.store, ref);
		const lines = [
			`${state.runId.slice(0, 8)}  ${state.workflow}  ${state.lifecycle}  ${ref.backend}`,
			`goal: ${state.goal}`,
			`repository: ${records.repository.root}`,
			`repository-id: ${state.repositoryId}`,
			`policy: ${state.policyDigest}`,
			`updated: ${state.updatedAt}`,
		];
		if (records.request.sourceDesignRunId) lines.push(`source-design-run: ${records.request.sourceDesignRunId}`);
		if (records.request.designFeedback) lines.push(`design-feedback: ${records.request.designFeedback}`);
		if (state.lifecycle === "Completed") lines.push(`outcome: ${state.outcome}`, `summary: ${state.summaryArtifact}`);
		if ("reason" in state) lines.push(`reason: ${state.reason}`);
		for (const request of [
			{ scope: "run" as const, runId: ref.runId, attemptId: ref.runId },
			{
				scope: "repository" as const,
				repositoryId: ref.repositoryId,
				runId: ref.runId,
				attemptId: ref.runId,
			},
		]) {
			const path = this.runtime.leases.pathFor(request);
			const inspection = await this.runtime.leases.inspect(path);
			const leaseId = request.scope === "run" ? ref.runId : ref.repositoryId;
			const challenge = inspection.status === "dead" && inspection.owner
				? this.runtime.leases.challenge(inspection.owner)
				: inspection.status === "malformed"
					? this.runtime.leases.malformedChallenge(leaseId)
					: inspection.status === "available"
						? this.availableRecoveryChallenge(ref)
						: "unavailable";
			lines.push(
				`${request.scope}-lease: ${inspection.status} ${path}`,
				`${request.scope}-recovery-challenge: ${challenge}`,
			);
		}
		try {
			const observation =
				records.repository.kind === "git"
					? await captureGitObservation(records.repository, state.policyDigest, commandRunner)
					: await captureJjObservation(records.repository, state.policyDigest, commandRunner);
			if (observation.kind === "git") {
				lines.push(`head: ${observation.headOid}`, `ref: ${observation.symbolicRef}`, `conflicted: ${observation.conflicted}`);
				if (!observation.conflicted) lines.push(`index-tree: ${observation.indexTree}`);
			} else {
				lines.push(
					`operation: ${observation.operationId}`,
					`workspace: ${observation.workspaceId}`,
					`change: ${observation.changeId}`,
					`commit: ${observation.commitId}`,
					`parents: ${observation.parentCommitIds.join(",")}`,
					`conflicted: ${observation.conflicted}`,
				);
			}
		} catch (error) {
			lines.push(`live-observation: unavailable (${error instanceof Error ? error.message : String(error)})`);
		}
		return lines.join("\n");
	}

	private async publish(ref: RunRef, state: RunProjection, ctx: ExtensionCommandContext): Promise<void> {
		let content = `${state.workflow} ${state.lifecycle}`;
		if (state.lifecycle === "Completed") {
			try {
				const value = JSON.parse((await this.runtime.store.readArtifact(ref, state.summaryArtifact)).toString("utf8"));
				content = typeof value.output === "string" ? value.output : `${state.workflow}: ${state.outcome}`;
			} catch {
				content = `${state.workflow}: ${state.outcome}`;
			}
		} else if ("reason" in state) {
			content = `${state.workflow} ${state.lifecycle}: ${state.reason}`;
		}
		this.pi.sendMessage({
			customType: "deep-work-result",
			content,
			display: true,
			details: { schemaVersion: 1, runId: ref.runId, backend: ref.backend, lifecycle: state.lifecycle },
		});
		ctx.ui.notify(`Deep-work run ${ref.runId.slice(0, 8)} finished: ${state.lifecycle}`, "info");
	}
}
