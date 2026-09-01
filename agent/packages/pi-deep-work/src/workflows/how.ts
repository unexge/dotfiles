import type { AgentGateway } from "../agents/gateway.ts";
import type { UserOrigin } from "../application/user-origin.ts";
import { assertUserOrigin } from "../application/user-origin.ts";
import { ObservationSession, SubjectDriftError } from "../application/observation-session.ts";
import {
	ControlAcceptedError,
	RunAuthorityClosedError,
	type RunAuthority,
} from "../application/run-authority.ts";
import type { BackendTreeService } from "../gates/tree-backend.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";

export interface HowWorkflowResult {
	outcome: "ExplanationProduced" | "Blocked" | "Failed";
	artifactPath: string;
	output?: string;
}

export async function runHowWorkflow(input: {
	origin: UserOrigin;
	authority: RunAuthority;
	gateway: AgentGateway;
	trees: BackendTreeService;
	store: RunStore;
	ref: RunRef;
	concurrency: number;
	completedAt: string;
}): Promise<HowWorkflowResult> {
	const artifactPath = "outputs/how.json";
	try {
		assertUserOrigin(input.origin);
		const observed = await ObservationSession.begin(input.gateway, input.trees, input.authority);
		const plan = await observed.run({
			kind: "plan",
			label: "frame explanation",
			task: `Frame a repository-grounded explanation for the original operator question:\n\n${input.origin.goal}`,
		});
		if (plan.report.value.status !== "ok") {
			throw new WorkflowAgentStatusError("planner", plan.report.value.status);
		}
		const slices = plan.report.value.steps.slice(0, 4);
		const explorations = await observed.runMany(
			slices.map((step, index) => ({
				kind: "explore" as const,
				label: `explanation slice ${index + 1}`,
				task: [
					`Operator question: ${input.origin.goal}`,
					`Assigned slice: ${step}`,
					`Success criteria: ${plan.report.value.successCriteria.join("; ")}`,
				].join("\n\n"),
			})),
			input.concurrency,
		);
		const incompleteExploration = explorations.find((result) => result.report.value.status !== "ok");
		if (incompleteExploration) {
			throw new WorkflowAgentStatusError("explorer", incompleteExploration.report.value.status as "blocked" | "failed");
		}
		const edited = await observed.run({
			kind: "edit",
			label: "synthesize explanation",
			task: [
				`Answer the operator question: ${input.origin.goal}`,
				"Use only this validated planner/explorer evidence:",
				canonicalJson({ plan: plan.report.value, explorations: explorations.map((result) => result.report.value) }),
			].join("\n\n"),
		});
		if (edited.report.value.status !== "ok") {
			throw new WorkflowAgentStatusError("editor", edited.report.value.status);
		}
		await observed.assertCurrent();
		const artifact = {
			schemaVersion: 1,
			proposedOutcome: "ExplanationProduced",
			authoritative: false,
			lifecycleAuthority: "state.json",
			subjectDigest: observed.subjectDigest,
			question: input.origin.goal,
			output: edited.report.value.output,
			citations: edited.report.value.citations,
		};
		// The lifecycle transition is authoritative. This provisional atomic artifact stays replaceable until completion succeeds.
		await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact)));
		await observed.assertCurrent();
		await input.authority.complete("ExplanationProduced", artifactPath, input.completedAt);
		return { outcome: "ExplanationProduced", artifactPath, output: edited.report.value.output };
	} catch (error) {
		if (error instanceof ControlAcceptedError || error instanceof RunAuthorityClosedError) throw error;
		if (error instanceof WorkflowAgentStatusError) {
			// Error diagnostics are best-effort after lifecycle settlement; success output must exist before completion.
			const artifact = {
				schemaVersion: 1,
				proposedOutcome: error.status === "blocked" ? "Blocked" : "Failed",
				authoritative: false,
				lifecycleAuthority: "state.json",
				question: input.origin.goal,
				reason: error.message,
			};
			// A queued durable control intentionally supersedes this lifecycle decision and propagates its ControlAcceptedError.
			if (error.status === "blocked") {
				await input.authority.block(error.message, input.completedAt);
				await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact))).catch(() => undefined);
				return { outcome: "Blocked", artifactPath };
			}
			await input.authority.fail(error.message, input.completedAt);
			await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact))).catch(() => undefined);
			return { outcome: "Failed", artifactPath };
		}
		if (!(error instanceof SubjectDriftError)) {
			const reason = error instanceof Error ? error.message : String(error);
			let state = await input.store.load(input.ref);
			// A control admitted during fail() intentionally supersedes this technical failure and propagates.
			if (state.lifecycle === "Active") {
				await input.authority.fail(reason, input.completedAt);
				state = await input.store.load(input.ref);
			}
			const outcome =
				state.lifecycle === "Failed"
					? "Failed"
					: state.lifecycle === "Blocked" || state.lifecycle === "NeedsManualInspection"
						? "Blocked"
						: undefined;
			if (!outcome) throw error;
			await input.store
				.writeArtifact(
					input.ref,
					artifactPath,
					Buffer.from(
						canonicalJson({
							schemaVersion: 1,
							proposedOutcome: outcome,
							authoritative: false,
							lifecycleAuthority: "state.json",
							question: input.origin.goal,
							reason,
						}),
					),
				)
				.catch(() => undefined);
			return { outcome, artifactPath };
		}
		const artifact = {
			schemaVersion: 1,
			proposedOutcome: "Blocked",
			authoritative: false,
			lifecycleAuthority: "state.json",
			question: input.origin.goal,
			reason: error.message,
			beforeSubjectDigest: error.beforeDigest,
			afterSubjectDigest: error.afterDigest,
		};
		await input.authority.block(error.message, input.completedAt);
		await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact))).catch(() => undefined);
		return { outcome: "Blocked", artifactPath };
	}
}

class WorkflowAgentStatusError extends Error {
	constructor(readonly role: string, readonly status: "blocked" | "failed") {
		super(`${role} returned ${status}`);
		this.name = "WorkflowAgentStatusError";
	}
}
