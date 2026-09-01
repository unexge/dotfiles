import { createHash } from "node:crypto";
import type { AgentGateway } from "../agents/gateway.ts";
import type { UserOrigin } from "../application/user-origin.ts";
import { assertUserOrigin } from "../application/user-origin.ts";
import { ObservationSession } from "../application/observation-session.ts";
import {
	ControlAcceptedError,
	RunAuthorityClosedError,
	type RunAuthority,
} from "../application/run-authority.ts";
import { ObservedDiffPreconditionError, type BackendTreeService } from "../gates/tree-backend.ts";
import { canonicalJson } from "../policy/canonical-json.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { SubjectDriftError } from "../subject/drift.ts";

export type UnslopSource = { kind: "text"; text: string } | { kind: "diff"; base?: string };

export interface UnslopWorkflowResult {
	outcome: "UnslopReportProduced" | "Blocked" | "Failed";
	artifactPath: string;
	output?: string;
	reason?: string;
}

interface UnslopInput {
	source: UnslopSource;
	origin: UserOrigin;
	authority: RunAuthority;
	gateway: AgentGateway;
	trees: BackendTreeService;
	store: RunStore;
	ref: RunRef;
	completedAt: string;
}

export async function runUnslopWorkflow(input: UnslopInput): Promise<UnslopWorkflowResult> {
	const artifactPath = "outputs/unslop.json";
	try {
		assertUserOrigin(input.origin);
		if (input.source.kind === "text" && !input.source.text.trim()) {
			throw new UnslopPreconditionError("Text input cannot be empty");
		}
		// Phase 11 binds every read-only procedure, including text cleanup, to one serialized repository subject.
		const observed = await ObservationSession.begin(input.gateway, input.trees, input.authority);
		let editTask: string;
		let source: { kind: "text"; textDigest: string } | {
			kind: "diff";
			baseRevision: string;
			diffDigest: string;
			paths: string[];
		};
		if (input.source.kind === "diff") {
			const diff = await observed.renderDiff(input.source.base);
			if (!diff.patch.trim()) throw new UnslopPreconditionError("No diff to unslop");
			const exploration = await observed.run({
				kind: "explore",
				label: "inspect unslop diff",
				task: [
					"Inspect surrounding repository code for concrete slop in this exact observed diff. Do not modify files.",
					`Changed paths: ${diff.paths.join(", ")}`,
					`Diff digest: ${diff.diffDigest}`,
					"Exact diff:",
					diff.patch,
				].join("\n\n"),
			});
			if (exploration.report.value.status !== "ok") {
				throw new UnslopAgentStatusError("explorer", exploration.report.value.status);
			}
			editTask = [
				"Produce a concise audit of evidenced code slop and the smallest concrete corrections.",
				"Use only this exact diff and validated read-only exploration:",
				canonicalJson({ diff, exploration: exploration.report.value }),
			].join("\n\n");
			source = {
				kind: "diff",
				baseRevision: diff.baseRevision,
				diffDigest: diff.diffDigest,
				paths: diff.paths,
			};
		} else {
			editTask = `Rewrite this prose without changing facts or intent:\n\n${input.source.text}`;
			source = { kind: "text", textDigest: digest(input.source.text) };
		}
		const edited = await observed.run({
			kind: "edit",
			label: `unslop ${input.source.kind}`,
			task: editTask,
		});
		if (edited.report.value.status !== "ok") {
			throw new UnslopAgentStatusError("editor", edited.report.value.status);
		}
		await observed.assertCurrent();
		const artifact = {
			schemaVersion: 1,
			proposedOutcome: "UnslopReportProduced",
			authoritative: false,
			lifecycleAuthority: "state.json",
			subjectDigest: observed.subjectDigest,
			source,
			output: edited.report.value.output,
			citations: edited.report.value.citations,
		};
		await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact)));
		await observed.assertCurrent();
		await input.authority.complete("UnslopReportProduced", artifactPath, input.completedAt);
		return { outcome: "UnslopReportProduced", artifactPath, output: edited.report.value.output };
	} catch (error) {
		if (error instanceof ControlAcceptedError || error instanceof RunAuthorityClosedError) throw error;
		if (
			error instanceof UnslopAgentStatusError ||
			error instanceof ObservedDiffPreconditionError ||
			error instanceof UnslopPreconditionError
		) {
			const blocked = !(error instanceof UnslopAgentStatusError) || error.status === "blocked";
			// A control admitted during settlement intentionally supersedes this diagnostic and propagates.
			const outcome = blocked ? "Blocked" : "Failed";
			if (blocked) await input.authority.block(error.message, input.completedAt);
			else await input.authority.fail(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, outcome, error.message);
			return { outcome, artifactPath, reason: error.message };
		}
		if (error instanceof SubjectDriftError) {
			await input.authority.block(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Blocked", error.message, {
				beforeSubjectDigest: error.beforeDigest,
				afterSubjectDigest: error.afterDigest,
			});
			return { outcome: "Blocked", artifactPath, reason: error.message };
		}
		const reason = error instanceof Error ? error.message : String(error);
		let state = await input.store.load(input.ref);
		if (state.lifecycle === "Active") {
			await input.authority.fail(reason, input.completedAt);
			state = await input.store.load(input.ref);
		}
		if (state.lifecycle !== "Failed") throw error;
		await writeDiagnostic(input, artifactPath, "Failed", reason, { lifecycle: state.lifecycle });
		return { outcome: "Failed", artifactPath, reason };
	}
}

async function writeDiagnostic(
	input: UnslopInput,
	artifactPath: string,
	outcome: "Blocked" | "Failed",
	reason: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	await input.store.writeArtifact(
		input.ref,
		artifactPath,
		Buffer.from(
			canonicalJson({
				schemaVersion: 1,
				proposedOutcome: outcome,
				authoritative: false,
				lifecycleAuthority: "state.json",
				sourceKind: input.source.kind,
				reason,
				...extra,
			}),
		),
	);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

class UnslopPreconditionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnslopPreconditionError";
	}
}

class UnslopAgentStatusError extends Error {
	constructor(readonly role: string, readonly status: "blocked" | "failed") {
		super(`${role} returned ${status}`);
		this.name = "UnslopAgentStatusError";
	}
}
