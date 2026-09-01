import { createHash, randomUUID } from "node:crypto";
import type { AgentGateway, AgentResult, AgentSettlement } from "../agents/gateway.ts";
import { decodeAgentReport, type ReviewReport } from "../agents/schemas.ts";
import { canonicalDigest, canonicalJson } from "../policy/canonical-json.ts";
import type { ResolvedPolicy } from "../policy/catalog.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { ReviewRecordSchema, decode, type ReviewRecord } from "../store/schemas.ts";
import {
	decodeReviewSubject,
	digestFrozenArtifact,
	reviewJobKind,
	reviewSubjectDigest,
	reviewedArtifactDigest,
	type ReviewSubject,
} from "./subjects.ts";

export type PanelDiagnosticCause =
	| "provider_failure"
	| "malformed_output"
	| "model_mismatch"
	| "contradictory_report"
	| "subject_drift"
	| "persistence_failure";

export interface PanelDiagnostic {
	cause: PanelDiagnosticCause;
	retryable: boolean;
	detail: string;
	reviewerId?: string;
}

export interface PanelNotice {
	kind: "adjudication_dropped";
	detail: string;
}

export interface CanonicalFinding {
	id: string;
	reviewerId: string;
	severity: "blocker" | "important" | "suggestion";
	title: string;
	detail: string;
}

const completePanelResults = new WeakMap<object, string>();

export type PanelResult =
	| {
			complete: false;
			subjectDigest: string;
			diagnostics: readonly PanelDiagnostic[];
	  }
	| {
			complete: true;
			subjectDigest: string;
			record: ReviewRecord;
			findings: readonly CanonicalFinding[];
			notices: readonly PanelNotice[];
			panelArtifact: { path: string; digest: string };
			recordArtifact: { path: string; digest: string };
	  };

export function assertCompletePanelResult(result: Extract<PanelResult, { complete: true }>): void {
	if (completePanelResults.get(result) !== completePanelResultDigest(result)) {
		throw new Error("Complete panel result was not minted by ReviewPanel or was modified");
	}
}

interface PanelInput {
	subject: ReviewSubject;
	frozenArtifact: string | Buffer;
	task: string;
	recaptureSubjectDigest: () => Promise<string>;
}

interface ValidatedReview {
	reviewerId: string;
	model: string;
	report: ReviewReport;
	findings: CanonicalFinding[];
}

export class ReviewPanel {
	private readonly reviewers: readonly { id: string; model: string; index: number }[];
	private readonly gptModel: string;

	constructor(
		private readonly gateway: AgentGateway,
		private readonly store: RunStore,
		private readonly ref: RunRef,
		policy: ResolvedPolicy,
	) {
		this.gptModel = `${policy.machine.models.gpt.provider}/${policy.machine.models.gpt.id}`;
		this.reviewers = Object.freeze(
			policy.machine.models.opusReviewers.map((reviewer, index) => ({
				id: `${reviewer.provider}/${reviewer.id}`,
				model: `${reviewer.provider}/${reviewer.id}`,
				index,
			})),
		);
		if (new Set(this.reviewers.map((reviewer) => reviewer.id)).size !== this.reviewers.length) {
			throw new Error("Review panel has duplicate configured reviewers");
		}
		this.concurrency = policy.machine.concurrency;
	}

	private readonly concurrency: number;

	assertGateway(gateway: AgentGateway): void {
		if (this.gateway !== gateway) throw new Error("ReviewPanel is bound to another AgentGateway");
	}

	assertRun(store: RunStore, ref: RunRef): void {
		if (
			this.store !== store ||
			this.ref.directory !== ref.directory ||
			this.ref.runId !== ref.runId ||
			this.ref.repositoryId !== ref.repositoryId ||
			this.ref.backend !== ref.backend
		) {
			throw new Error("ReviewPanel is bound to another run store or reference");
		}
	}

	/** Durable pause/cancel rejects with RunAuthority's control error; controls are never incomplete panel diagnostics. */
	async review(input: PanelInput): Promise<PanelResult> {
		const subject = decodeReviewSubject(input.subject);
		const subjectDigest = reviewSubjectDigest(subject);
		if (digestFrozenArtifact(input.frozenArtifact) !== reviewedArtifactDigest(subject)) {
			return this.incomplete(subject, subjectDigest, [
				{ cause: "malformed_output", retryable: false, detail: "Frozen review artifact does not match its subject digest" },
			]);
		}
		const existing = await this.loadExisting(subject, subjectDigest, input.recaptureSubjectDigest);
		if (existing) return existing;
		const kind = reviewJobKind(subject);
		const artifactText = typeof input.frozenArtifact === "string" ? input.frozenArtifact : input.frozenArtifact.toString("utf8");
		const task = [
			input.task,
			`Review subject digest: ${subjectDigest}`,
			`Review subject: ${canonicalJson(subject)}`,
			"Exact frozen artifact:",
			artifactText,
		].join("\n\n");
		const settlements =
			kind === "review-design"
				? await this.gateway.runManySettled(
						this.reviewers.map((reviewer) => ({
							kind: "review-design" as const,
							label: `design review ${reviewer.index + 1}`,
							task,
							reviewerIndex: reviewer.index,
						})),
						this.concurrency,
					)
				: await this.gateway.runManySettled(
						this.reviewers.map((reviewer) => ({
							kind: "review-code" as const,
							label: `code review ${reviewer.index + 1}`,
							task,
							reviewerIndex: reviewer.index,
						})),
						this.concurrency,
					);
		const diagnostics: PanelDiagnostic[] = [];
		const reviews: ValidatedReview[] = [];
		if (settlements.length !== this.reviewers.length) {
			diagnostics.push({
				cause: "provider_failure",
				retryable: true,
				detail: `Expected ${this.reviewers.length} reviewer settlements, got ${settlements.length}`,
			});
		}
		for (let index = 0; index < this.reviewers.length; index++) {
			const reviewer = this.reviewers[index];
			const settlement = settlements[index] as AgentSettlement<typeof kind> | undefined;
			if (!settlement || !settlement.ok) {
				diagnostics.push({
					cause: "provider_failure",
					retryable: true,
					detail: settlement && !settlement.ok ? settlement.error : "Reviewer result is missing",
					reviewerId: reviewer.id,
				});
				continue;
			}
			const validated = this.validateReview(reviewer, kind, settlement.result, diagnostics);
			if (validated) reviews.push(validated);
		}
		if (diagnostics.length > 0 || reviews.length !== this.reviewers.length) {
			return this.incomplete(subject, subjectDigest, diagnostics);
		}
		const findings = reviews.flatMap((review) => review.findings);
		const approved = findings.every((finding) => finding.severity === "suggestion");
		const notices: PanelNotice[] = [];
		let adjudication: unknown = null;
		if (findings.length > 0) {
			const settlement = await this.gateway.runSettled({
				kind: "adjudicate",
				label: "review adjudication",
				task: `Explain these validated Opus findings without changing approval or severity:\n${canonicalJson(findings)}`,
			});
			if (settlement.ok && this.validAdjudication(settlement.result, findings)) {
				adjudication = settlement.result.report.value;
			} else {
				notices.push({
					kind: "adjudication_dropped",
					detail: settlement.ok ? "Adjudication did not cover every canonical finding exactly" : settlement.error,
				});
			}
		}
		if ((await input.recaptureSubjectDigest()) !== subjectDigest) {
			return this.incomplete(subject, subjectDigest, [
				{ cause: "subject_drift", retryable: true, detail: "Review subject changed before publication" },
			]);
		}
		const panelId = randomUUID();
		const panelPath = `reviews/${subjectDigest}/${panelId}-panel.json`;
		const panel = {
			schemaVersion: 1,
			panelId,
			subject,
			subjectDigest,
			frozenArtifactDigest: reviewedArtifactDigest(subject),
			reviewerIds: this.reviewers.map((reviewer) => reviewer.id),
			reviews,
			findings,
			approved,
			adjudication,
			notices,
		};
		try {
			const panelBytes = Buffer.from(canonicalJson(panel));
			const panelArtifact = await this.store.writeImmutableArtifact(this.ref, panelPath, panelBytes);
			const record = decode(ReviewRecordSchema, {
				schemaVersion: 1,
				subjectDigest,
				reviewerIds: this.reviewers.map((reviewer) => reviewer.id),
				complete: true,
				completedReviewerIds: reviews.map((review) => review.reviewerId),
				findingSeverities: findings.map((finding) => finding.severity),
				approved,
				artifactPath: panelPath,
				artifactDigest: panelArtifact.digest,
			});
			const recordPath = `reviews/${subjectDigest}/record.json`;
			const recordBytes = Buffer.from(canonicalJson(record));
			const recordArtifact = await this.store.writeImmutableArtifact(this.ref, recordPath, recordBytes);
			return mintCompletePanelResult({
				complete: true,
				subjectDigest,
				record,
				findings: Object.freeze(findings),
				notices: Object.freeze(notices),
				panelArtifact: { path: panelPath, digest: panelArtifact.digest },
				recordArtifact: { path: recordPath, digest: recordArtifact.digest },
			});
		} catch (error) {
			return this.incomplete(subject, subjectDigest, [
				{
					cause: "persistence_failure",
					retryable: false,
					detail: error instanceof Error ? error.message : String(error),
				},
			]);
		}
	}

	private validateReview(
		reviewer: { id: string; model: string; index: number },
		kind: "review-design" | "review-code",
		result: AgentResult<typeof kind>,
		diagnostics: PanelDiagnostic[],
	): ValidatedReview | undefined {
		const expectedRole = kind === "review-design" ? "design-reviewer" : "code-reviewer";
		if (result.model !== reviewer.model || result.kind !== kind || result.role !== expectedRole) {
			diagnostics.push({
				cause: "model_mismatch",
				retryable: false,
				detail: `Expected ${reviewer.model}/${kind}/${expectedRole}, got ${result.model}/${result.kind}/${result.role}`,
				reviewerId: reviewer.id,
			});
			return undefined;
		}
		let report: ReviewReport;
		try {
			report = decodeAgentReport(kind, result.report.value);
		} catch (error) {
			diagnostics.push({
				cause: "malformed_output",
				retryable: false,
				detail: error instanceof Error ? error.message : String(error),
				reviewerId: reviewer.id,
			});
			return undefined;
		}
		if (report.status !== "ok") {
			diagnostics.push({
				cause: "malformed_output",
				retryable: false,
				detail: `Reviewer returned status ${report.status}`,
				reviewerId: reviewer.id,
			});
			return undefined;
		}
		const ids = report.findings.map((finding) => finding.id);
		const substantive = report.findings.some((finding) => finding.severity !== "suggestion");
		if (
			new Set(ids).size !== ids.length ||
			(report.verdict === "approve" && substantive) ||
			(report.verdict === "changes_required" && !substantive)
		) {
			diagnostics.push({
				cause: "contradictory_report",
				retryable: false,
				detail: "Reviewer verdict contradicts findings or contains duplicate finding IDs",
				reviewerId: reviewer.id,
			});
			return undefined;
		}
		return {
			reviewerId: reviewer.id,
			model: result.model,
			report,
			findings: report.findings.map((finding) => ({
				id: this.canonicalFindingId(reviewer.index, finding.id),
				reviewerId: reviewer.id,
				severity: finding.severity,
				title: finding.title,
				detail: finding.detail,
			})),
		};
	}

	private async loadExisting(
		subject: ReviewSubject,
		subjectDigest: string,
		recaptureSubjectDigest: () => Promise<string>,
	): Promise<Extract<PanelResult, { complete: true }> | Extract<PanelResult, { complete: false }> | undefined> {
		const recordPath = `reviews/${subjectDigest}/record.json`;
		let recordBytes: Buffer;
		try {
			recordBytes = await this.store.readArtifact(this.ref, recordPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const record = decode(ReviewRecordSchema, JSON.parse(recordBytes.toString("utf8")));
		if (record.subjectDigest !== subjectDigest) throw new Error("Stored review record names a foreign subject");
		const expectedReviewers = this.reviewers.map((reviewer) => reviewer.id);
		if (
			record.reviewerIds.join("\0") !== expectedReviewers.join("\0") ||
			record.completedReviewerIds.join("\0") !== expectedReviewers.join("\0")
		) {
			throw new Error("Stored review record does not contain the configured complete reviewer set");
		}
		const panelBytes = await this.store.readArtifact(this.ref, record.artifactPath);
		const panelDigest = createHash("sha256").update(panelBytes).digest("hex");
		if (panelDigest !== record.artifactDigest) throw new Error("Stored review panel artifact digest mismatch");
		const panel = JSON.parse(panelBytes.toString("utf8")) as Record<string, unknown>;
		const storedSubject = decodeReviewSubject(panel.subject);
		if (
			reviewSubjectDigest(storedSubject) !== subjectDigest ||
			canonicalJson(storedSubject) !== canonicalJson(subject) ||
			panel.subjectDigest !== subjectDigest ||
			panel.frozenArtifactDigest !== reviewedArtifactDigest(subject) ||
			!Array.isArray(panel.reviewerIds) ||
			panel.reviewerIds.join("\0") !== expectedReviewers.join("\0") ||
			!Array.isArray(panel.findings)
		) {
			throw new Error("Stored review panel contradicts its subject or reviewer set");
		}
		const findings = panel.findings as CanonicalFinding[];
		const severities = findings.map((finding) => finding.severity);
		const approved = severities.every((severity) => severity === "suggestion");
		if (
			severities.some((severity) => !["blocker", "important", "suggestion"].includes(severity)) ||
			severities.join("\0") !== record.findingSeverities.join("\0") ||
			panel.approved !== approved ||
			record.approved !== approved
		) {
			throw new Error("Stored review approval contradicts original finding severities");
		}
		if ((await recaptureSubjectDigest()) !== subjectDigest) {
			return this.incomplete(subject, subjectDigest, [
				{ cause: "subject_drift", retryable: true, detail: "Stored review subject is no longer current" },
			]);
		}
		const notices = Array.isArray(panel.notices) ? (panel.notices as PanelNotice[]) : [];
		return mintCompletePanelResult({
			complete: true,
			subjectDigest,
			record,
			findings: Object.freeze(findings),
			notices: Object.freeze(notices),
			panelArtifact: { path: record.artifactPath, digest: record.artifactDigest },
			recordArtifact: {
				path: recordPath,
				digest: createHash("sha256").update(recordBytes).digest("hex"),
			},
		});
	}

	private canonicalFindingId(reviewerIndex: number, findingId: string): string {
		const prefix = `r${reviewerIndex + 1}:`;
		const value = `${prefix}${findingId}`;
		return value.length <= 128 ? value : `${prefix}${createHash("sha256").update(findingId).digest("hex")}`;
	}

	private validAdjudication(result: AgentResult<"adjudicate">, findings: readonly CanonicalFinding[]): boolean {
		try {
			if (result.kind !== "adjudicate" || result.role !== "adjudicator" || result.model !== this.gptModel) return false;
			const report = decodeAgentReport("adjudicate", result.report.value);
			if (report.status !== "ok") return false;
			const expected = [...findings.map((finding) => finding.id)].sort();
			const actual = report.decisions.map((decision) => decision.findingId).sort();
			return expected.length === actual.length && expected.every((id, index) => id === actual[index]);
		} catch {
			return false;
		}
	}

	private async incomplete(
		subject: ReviewSubject,
		subjectDigest: string,
		diagnostics: PanelDiagnostic[],
	): Promise<PanelResult> {
		try {
			await this.store.writeImmutableArtifact(
				this.ref,
				`review-attempts/${subjectDigest}/${randomUUID()}.json`,
				Buffer.from(canonicalJson({ schemaVersion: 1, subject, subjectDigest, diagnostics })),
			);
		} catch {}
		return { complete: false, subjectDigest, diagnostics: Object.freeze(diagnostics) };
	}
}

function completePanelResultDigest(result: Extract<PanelResult, { complete: true }>): string {
	return canonicalDigest({
		subjectDigest: result.subjectDigest,
		record: result.record,
		findings: result.findings,
		notices: result.notices,
		panelArtifact: result.panelArtifact,
		recordArtifact: result.recordArtifact,
	});
}

function mintCompletePanelResult<T extends Extract<PanelResult, { complete: true }>>(result: T): T {
	Object.freeze(result);
	completePanelResults.set(result, completePanelResultDigest(result));
	return result;
}
