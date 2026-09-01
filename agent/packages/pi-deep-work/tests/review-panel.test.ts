import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGateway, AgentResult, AgentSettlement } from "../src/agents/gateway.ts";
import { ControlAcceptedError } from "../src/application/run-authority.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { ReviewPanel } from "../src/review/panel.ts";
import {
	noBehaviorContractDigest,
	reviewSubjectDigest,
	type ReviewSubject,
} from "../src/review/subjects.ts";
import { RunStore } from "../src/store/run-store.ts";
import type { GitCandidateSubject, GitCleanObservationSubject } from "../src/subject/types.ts";

const temporary: string[] = [];
const reviewerModels = ["test/claude-opus-4.8", "test/claude-opus-5.0"];

const observation: GitCleanObservationSubject = {
	schemaVersion: 1,
	kind: "git",
	repositoryId: "a".repeat(64),
	root: "/repo",
	policyDigest: "b".repeat(64),
	workingDigest: "c".repeat(64),
	changedPathsDigest: "d".repeat(64),
	headOid: "1".repeat(40),
	symbolicRef: "refs/heads/main",
	conflicted: false,
	indexTree: "2".repeat(40),
};

function policy() {
	return resolvePolicy(
		decodeMachinePolicy({
			schemaVersion: 1,
			models: {
				gpt: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
				opusReviewers: reviewerModels.map((model) => ({
					provider: "test",
					id: model.slice("test/".length),
					thinkingLevel: "max",
				})),
			},
			concurrency: 2,
			maxRepairRounds: 1,
			commandTimeoutMs: 10_000,
			minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			observations: [],
			verificationContracts: [],
			selectors: [],
		}),
	);
}

function report(
	verdict: "approve" | "changes_required" = "approve",
	findings: Array<Record<string, unknown>> = [],
) {
	return { status: "ok", summary: "reviewed", citations: [], verdict, findings };
}

function finding(severity: "blocker" | "important" | "suggestion", id = "f1") {
	return {
		id,
		severity,
		title: "Finding",
		detail: "Concrete detail",
		evidence: ["evidence"],
		recommendation: "Fix it",
	};
}

function agentResult(index: number, value: unknown, model = reviewerModels[index]): AgentResult<"review-design"> {
	return {
		kind: "review-design",
		role: "design-reviewer",
		model,
		turns: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		report: { source: "untrusted-agent", value: value as never },
	};
}

function settlements(values: unknown[]): AgentSettlement<"review-design">[] {
	return values.map((value, index) => ({ ok: true, result: agentResult(index, value) }));
}

async function fixture(runManySettled = vi.fn(), runSettled = vi.fn()) {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-panel-"));
	temporary.push(root);
	const store = new RunStore(root);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "design" as const,
		repositoryId: observation.repositoryId,
		policyDigest: observation.policyDigest,
		goal: "review",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create("git", initial);
	const gateway = { runManySettled, runSettled } as unknown as AgentGateway;
	return { root, store, ref, gateway, panel: new ReviewPanel(gateway, store, ref, policy()), runManySettled, runSettled };
}

function designSubject(content: string): ReviewSubject {
	return {
		schemaVersion: 1,
		kind: "standalone-design",
		observation,
		designDigest: createHash("sha256").update(content).digest("hex"),
		behaviorContractDigest: noBehaviorContractDigest,
	};
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("complete review panel", () => {
	it("rejects foreign gateway and run bindings", async () => {
		const values = await fixture();
		expect(() => values.panel.assertGateway(values.gateway)).not.toThrow();
		expect(() => values.panel.assertGateway({} as AgentGateway)).toThrow("another AgentGateway");
		expect(() => values.panel.assertRun(values.store, values.ref)).not.toThrow();
		expect(() => values.panel.assertRun(new RunStore(values.root), values.ref)).toThrow("another run store");
		expect(() => values.panel.assertRun(values.store, { ...values.ref, runId: randomUUID() })).toThrow("another run store");
	});

	it("persists approval only after every configured reviewer completes", async () => {
		const runMany = vi.fn().mockResolvedValue(settlements([report(), report()]));
		const values = await fixture(runMany);
		const subject = designSubject("design");
		const recaptureSubjectDigest = vi.fn(async () => reviewSubjectDigest(subject));
		const result = await values.panel.review({
			subject,
			frozenArtifact: "design",
			task: "Review design",
			recaptureSubjectDigest,
		});
		expect(result).toMatchObject({ complete: true, record: { complete: true, approved: true } });
		expect(runMany).toHaveBeenCalledTimes(1);
		expect(recaptureSubjectDigest).toHaveBeenCalledTimes(1);
		const files = await readdir(join(values.ref.directory, "artifacts", "reviews", reviewSubjectDigest(subject)));
		expect(files.some((file) => file.endsWith("-panel.json"))).toBe(true);
		expect(files).toContain("record.json");
	});

	it("allows exactly one canonical complete record for a subject", async () => {
		const runMany = vi.fn().mockResolvedValue(settlements([report(), report()]));
		const values = await fixture(runMany);
		const subject = designSubject("design");
		const input = {
			subject,
			frozenArtifact: "design",
			task: "Review",
			recaptureSubjectDigest: async () => reviewSubjectDigest(subject),
		};
		expect((await values.panel.review(input)).complete).toBe(true);
		const second = await values.panel.review(input);
		expect(second).toMatchObject({ complete: true, record: { approved: true } });
		expect(runMany).toHaveBeenCalledTimes(1);
		const files = await readdir(join(values.ref.directory, "artifacts", "reviews", reviewSubjectDigest(subject)));
		expect(files.filter((file) => file === "record.json")).toHaveLength(1);
		expect(files.filter((file) => file.endsWith("-panel.json"))).toHaveLength(1);
	});

	it("rejects tampered canonical records and panel artifacts on reload", async () => {
		for (const tamper of ["panel", "reviewers", "approval"] as const) {
			const runMany = vi.fn().mockResolvedValue(settlements([report(), report()]));
			const values = await fixture(runMany);
			const subject = designSubject("design");
			const input = {
				subject,
				frozenArtifact: "design",
				task: "Review",
				recaptureSubjectDigest: async () => reviewSubjectDigest(subject),
			};
			const first = await values.panel.review(input);
			if (!first.complete) throw new Error("expected complete panel");
			if (tamper === "panel") {
				await writeFile(join(values.ref.directory, "artifacts", first.panelArtifact.path), "{}", "utf8");
			} else {
				const path = join(values.ref.directory, "artifacts", first.recordArtifact.path);
				const record = JSON.parse(await readFile(path, "utf8"));
				if (tamper === "reviewers") record.completedReviewerIds = ["foreign/model"];
				else record.approved = false;
				await writeFile(path, JSON.stringify(record), "utf8");
			}
			await expect(values.panel.review(input)).rejects.toThrow();
		}
	});

	it("revalidates subject freshness when reusing a canonical panel", async () => {
		const runMany = vi.fn().mockResolvedValue(settlements([report(), report()]));
		const values = await fixture(runMany);
		const subject = designSubject("design");
		const current = {
			subject,
			frozenArtifact: "design",
			task: "Review",
			recaptureSubjectDigest: async () => reviewSubjectDigest(subject),
		};
		expect((await values.panel.review(current)).complete).toBe(true);
		const stale = await values.panel.review({
			...current,
			recaptureSubjectDigest: async () => "9".repeat(64),
		});
		expect(stale).toMatchObject({ complete: false, diagnostics: [{ cause: "subject_drift" }] });
		expect(runMany).toHaveBeenCalledTimes(1);
	});

	it("propagates durable control errors instead of converting them to panel diagnostics", async () => {
		const values = await fixture(vi.fn().mockRejectedValue(new ControlAcceptedError("Pause")));
		const subject = designSubject("design");
		await expect(
			values.panel.review({
				subject,
				frozenArtifact: "design",
				task: "Review",
				recaptureSubjectDigest: async () => reviewSubjectDigest(subject),
			}),
		).rejects.toMatchObject({ kind: "Pause" });
	});

	it("starts no reviewer when frozen bytes do not match the subject", async () => {
		const runMany = vi.fn();
		const values = await fixture(runMany);
		const subject = designSubject("design");
		const result = await values.panel.review({
			subject,
			frozenArtifact: "different",
			task: "Review",
			recaptureSubjectDigest: async () => reviewSubjectDigest(subject),
		});
		expect(result).toMatchObject({ complete: false, diagnostics: [{ cause: "malformed_output", retryable: false }] });
		expect(runMany).not.toHaveBeenCalled();
	});

	it("never writes a complete record for missing, failed, mismatched, or contradictory reviewers", async () => {
		const cases: AgentSettlement<"review-design">[][] = [
			[{ ok: false, error: "provider down" }, ...settlements([report()])],
			settlements([report(), report()]).map((entry, index) =>
				index === 0 && entry.ok ? { ...entry, result: agentResult(0, report(), "other/model") } : entry,
			),
			settlements([report("approve", [finding("important")]), report()]),
			settlements([report("changes_required", [finding("suggestion")]), report()]),
		];
		for (const responses of cases) {
			const values = await fixture(vi.fn().mockResolvedValue(responses));
			const subject = designSubject("design");
			const result = await values.panel.review({
				subject,
				frozenArtifact: "design",
				task: "Review",
				recaptureSubjectDigest: async () => reviewSubjectDigest(subject),
			});
			expect(result.complete).toBe(false);
			const base = join(values.ref.directory, "artifacts", "reviews", reviewSubjectDigest(subject));
			await expect(readdir(base)).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("records changes required from original Opus severity regardless of GPT decisions", async () => {
		const substantive = finding("important");
		const runMany = vi.fn().mockResolvedValue(settlements([report("changes_required", [substantive]), report()]));
		const runSettled = vi.fn().mockResolvedValue({
			ok: true,
			result: {
				...agentResult(0, {}),
				kind: "adjudicate",
				role: "adjudicator",
				model: "test/gpt-5.6-sol",
				report: {
					source: "untrusted-agent",
					value: {
						status: "ok",
						summary: "disputed",
						citations: [],
						decisions: [{ findingId: "r1:f1", disposition: "disproved", rationale: "No", evidence: ["claim"] }],
					},
				},
			},
		});
		const values = await fixture(runMany, runSettled);
		const subject = designSubject("design");
		const result = await values.panel.review({
			subject,
			frozenArtifact: "design",
			task: "Review",
			recaptureSubjectDigest: async () => reviewSubjectDigest(subject),
		});
		expect(result).toMatchObject({ complete: true, record: { approved: false } });
	});

	it("drops failed adjudication without changing suggestion-only approval", async () => {
		const runMany = vi.fn().mockResolvedValue(settlements([report("approve", [finding("suggestion")]), report()]));
		const values = await fixture(runMany, vi.fn().mockResolvedValue({ ok: false, error: "gpt failed" }));
		const subject = designSubject("design");
		const result = await values.panel.review({
			subject,
			frozenArtifact: "design",
			task: "Review",
			recaptureSubjectDigest: async () => reviewSubjectDigest(subject),
		});
		expect(result).toMatchObject({
			complete: true,
			record: { approved: true },
			notices: [{ kind: "adjudication_dropped" }],
		});
	});

	it("publishes no complete record after subject drift", async () => {
		const values = await fixture(vi.fn().mockResolvedValue(settlements([report(), report()])));
		const subject = designSubject("design");
		const result = await values.panel.review({
			subject,
			frozenArtifact: "design",
			task: "Review",
			recaptureSubjectDigest: async () => "9".repeat(64),
		});
		expect(result).toMatchObject({ complete: false, diagnostics: [{ cause: "subject_drift" }] });
		const base = join(values.ref.directory, "artifacts", "reviews", reviewSubjectDigest(subject));
		await expect(readdir(base)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("binds all four review-subject variants to distinct digests", () => {
		const standalone = designSubject("design");
		const behavior: ReviewSubject = {
			schemaVersion: 1,
			kind: "behavior-design",
			observation,
			designDigest: createHash("sha256").update("design").digest("hex"),
			behaviorContractDigest: "8".repeat(64),
		};
		const observed: ReviewSubject = {
			schemaVersion: 1,
			kind: "observed-code",
			observation,
			diffDigest: "7".repeat(64),
		};
		const candidate: GitCandidateSubject = {
			schemaVersion: 1,
			kind: "git",
			observation,
			treeOid: "3".repeat(40),
			patchDigest: "7".repeat(64),
			changedPathsDigest: "4".repeat(64),
			approvedDesignId: "5".repeat(64),
			behaviorContractId: "6".repeat(64),
		};
		const candidateSubject: ReviewSubject = { schemaVersion: 1, kind: "candidate-code", candidate };
		expect(new Set([standalone, behavior, observed, candidateSubject].map(reviewSubjectDigest)).size).toBe(4);
	});
});
