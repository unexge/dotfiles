import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGateway, AgentResult } from "../src/agents/gateway.ts";
import { DesignApprover } from "../src/application/approve-design.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import { TrustedCommandCatalog } from "../src/gates/catalog.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { ReviewPanel } from "../src/review/panel.ts";
import { RunStore } from "../src/store/run-store.ts";
import { observationSubjectDigest } from "../src/subject/content.ts";
import type { GitCleanObservationSubject } from "../src/subject/types.ts";

const temporary: string[] = [];
const now = "2026-08-25T00:00:01.000Z";

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
const expectedObservationDigest = observationSubjectDigest(observation);

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
			minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
			observations: [
				{ id: "rust-observation", claimKeys: ["cache.safe"], argv: ["cargo", "test", "--locked"], timeoutMs: 1_000 },
			],
			verificationContracts: [],
			selectors: [
				{
					id: "rust-path",
					language: "rust",
					observationId: "rust-observation",
					valuePattern: "[a-zA-Z0-9_./-]+\\.rs",
				},
			],
		}),
	);
}

function reviewResult(findings: unknown[] = [], verdict: "approve" | "changes_required" = "approve"):
	AgentResult<"review-design"> {
	return {
		kind: "review-design",
		role: "design-reviewer",
		model: "test/claude-opus-4.8",
		turns: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		report: {
			source: "untrusted-agent",
			value: { status: "ok", summary: "reviewed", citations: [], verdict, findings } as never,
		},
	};
}

function importantFinding() {
	return {
		id: "f1",
		severity: "important",
		title: "Gap",
		detail: "Behavior gap",
		evidence: ["design"],
		recommendation: "Fix it",
	};
}

async function fixture(options: { findings?: unknown[]; verdict?: "approve" | "changes_required"; captures?: GitCleanObservationSubject[] } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-approve-design-"));
	temporary.push(root);
	const resolved = policy();
	const store = new RunStore(root);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "design" as const,
		repositoryId: observation.repositoryId,
		policyDigest: resolved.digest,
		goal: "approve",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create("git", initial);
	const runManySettled = vi.fn().mockResolvedValue([
		{ ok: true, result: reviewResult(options.findings, options.verdict) },
	]);
	const runSettled = vi.fn().mockResolvedValue({ ok: false, error: "adjudication unavailable" });
	const gateway = { runManySettled, runSettled } as unknown as AgentGateway;
	const panel = new ReviewPanel(gateway, store, ref, resolved);
	const catalog = await TrustedCommandCatalog.build(resolved, root);
	let captureIndex = 0;
	const captures = options.captures ?? [observation];
	const capture = async () => captures[Math.min(captureIndex++, captures.length - 1)];
	return {
		root,
		store,
		ref,
		gateway,
		runManySettled,
		approver: new DesignApprover(panel, catalog, store, ref, capture),
	};
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("shared approveDesign", () => {
	it("rejects foreign gateway, store, and run bindings", async () => {
		const values = await fixture();
		expect(() => values.approver.assertRun(values.gateway, values.store, values.ref)).not.toThrow();
		expect(() => values.approver.assertRun({} as AgentGateway, values.store, values.ref)).toThrow("another AgentGateway");
		expect(() => values.approver.assertRun(values.gateway, new RunStore(values.root), values.ref)).toThrow(
			"another run store",
		);
		expect(() => values.approver.assertRun(values.gateway, values.store, { ...values.ref, runId: randomUUID() })).toThrow(
			"another run store",
		);
	});

	it("blocks a foreign capture before panel or approved-design artifacts", async () => {
		const foreign = { ...observation, workingDigest: "9".repeat(64) };
		const values = await fixture({ captures: [foreign] });
		const result = await values.approver.approve({
			caller: "design",
			design: "design",
			userOrigin: userOriginFromRegisteredCommand("goal"),
			expectedObservationDigest,
			approvedAt: now,
		});
		expect(result).toMatchObject({ status: "Blocked", diagnostics: [{ cause: "subject_drift" }] });
		expect(values.runManySettled).not.toHaveBeenCalled();
		await expect(readdir(join(values.ref.directory, "artifacts", "approved-designs"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("approves standalone design without a behavior contract", async () => {
		const values = await fixture();
		const result = await values.approver.approve({
			caller: "design",
			design: "canonical design",
			userOrigin: userOriginFromRegisteredCommand("Design the cache"),
			expectedObservationDigest,
			approvedAt: now,
		});
		expect(result).toMatchObject({
			status: "Approved",
			record: { caller: "design", behavior: { kind: "none" }, reviewSubject: { kind: "standalone-design" } },
		});
	});

	for (const caller of ["fix", "build"] as const) {
		it(`approves ${caller} with a coordinator-minted behavior contract`, async () => {
			const values = await fixture();
			const result = await values.approver.approve({
				caller,
				design: `${caller} design`,
				userOrigin: userOriginFromRegisteredCommand(`${caller} the cache`),
				expectedObservationDigest,
				selectorProposals: [
					{ selectorId: "rust-path", value: "crates/cache/tests/cache.rs" },
					{ selectorId: "rust-path", value: "crates/cache/tests/cache.rs" },
				],
				approvedAt: now,
			});
			expect(result).toMatchObject({
				status: "Approved",
				record: {
					caller,
					behavior: {
						kind: "contract",
						contract: {
							claimKeys: ["cache.safe"],
							observationIds: ["rust-observation"],
							selectors:
								caller === "fix"
									? [{ selectorId: "rust-path", value: "crates/cache/tests/cache.rs" }]
									: [],
						},
					},
					reviewSubject: { kind: "behavior-design" },
				},
			});
			const task = values.runManySettled.mock.calls[0][0][0].task as string;
			expect(task).toContain(`${caller} the cache`);
			expect(task).toContain("cache.safe");
		});
	}

	it("binds every trusted observation into build approval without model selectors", async () => {
		const values = await fixture();
		const result = await values.approver.approve({
			caller: "build",
			design: "build design",
			userOrigin: userOriginFromRegisteredCommand("Build the cache"),
			expectedObservationDigest,
			selectorProposals: [{ selectorId: "rust-path", value: "not-a-concrete-path" }],
			approvedAt: now,
		});
		expect(result).toMatchObject({
			status: "Approved",
			record: {
				caller: "build",
				behavior: {
					kind: "contract",
					contract: {
						selectors: [],
						observationIds: ["rust-observation"],
						claimKeys: ["cache.safe"],
					},
				},
			},
		});
	});

	it("binds standalone design lineage into a build approval", async () => {
		const values = await fixture();
		const sourceDesign = {
			runId: randomUUID(),
			approvedDesignId: "9".repeat(64),
			artifactDigest: "8".repeat(64),
		};
		const result = await values.approver.approve({
			caller: "build",
			design: "build derivative",
			userOrigin: userOriginFromRegisteredCommand("Build the cache"),
			expectedObservationDigest,
			sourceDesign,
			approvedAt: now,
		});
		expect(result).toMatchObject({ status: "Approved", record: { caller: "build", sourceDesign } });
	});

	it("rejects caller and selector authority violations", async () => {
		const values = await fixture();
		await expect(
			values.approver.approve({
				caller: "design",
				design: "design",
				userOrigin: userOriginFromRegisteredCommand("goal"),
				expectedObservationDigest,
				selectorProposals: [] as never,
				approvedAt: now,
			}),
		).rejects.toThrow("cannot supply");
		for (const selectorProposals of [
			[],
			[{ selectorId: "missing", value: "test.rs" }],
			[{ selectorId: "rust-path", value: "../test.rs" }],
			[{ selectorId: "rust-path", value: "--test.rs" }],
			[{ selectorId: "rust-path", value: "test.rs -- --nocapture" }],
			[
				{ selectorId: "rust-path", value: "one.rs" },
				{ selectorId: "rust-path", value: "two.rs" },
			],
		]) {
			await expect(
				values.approver.approve({
					caller: "fix",
					design: "design",
					userOrigin: userOriginFromRegisteredCommand("goal"),
					expectedObservationDigest,
					selectorProposals,
					approvedAt: now,
				}),
			).rejects.toThrow();
		}
		await expect(
			values.approver.approve({
				caller: "design",
				design: "design",
				userOrigin: { goal: "forged" } as never,
				expectedObservationDigest,
				approvedAt: now,
			}),
		).rejects.toThrow("UserOrigin");
	});

	it("reuses a strict current panel record after a crash before approved-design persistence", async () => {
		const values = await fixture();
		const original = values.store.writeImmutableArtifact.bind(values.store);
		let writes = 0;
		values.store.writeImmutableArtifact = async (...args) => {
			if (++writes === 3) throw new Error("injected approved-design crash");
			return original(...args);
		};
		const input = {
			caller: "design" as const,
			design: "replay design",
			userOrigin: userOriginFromRegisteredCommand("goal"),
			expectedObservationDigest,
			approvedAt: now,
		};
		await expect(values.approver.approve(input)).rejects.toThrow("injected approved-design crash");
		values.store.writeImmutableArtifact = original;
		const replayed = await values.approver.approve(input);
		expect(replayed.status).toBe("Approved");
		expect((await values.approver.approve(input)).status).toBe("Approved");
		expect(values.runManySettled).toHaveBeenCalledTimes(1);
	});

	it("replays fix approval only with the same re-minted behavior contract", async () => {
		const values = await fixture();
		const original = values.store.writeImmutableArtifact.bind(values.store);
		let writes = 0;
		values.store.writeImmutableArtifact = async (...args) => {
			if (++writes === 5) throw new Error("injected behavior approval crash");
			return original(...args);
		};
		const input = {
			caller: "fix" as const,
			design: "fix replay design",
			userOrigin: userOriginFromRegisteredCommand("fix goal"),
			expectedObservationDigest,
			selectorProposals: [{ selectorId: "rust-path", value: "crates/cache/test.rs" }],
			approvedAt: now,
		};
		await expect(values.approver.approve(input)).rejects.toThrow("injected behavior approval crash");
		values.store.writeImmutableArtifact = original;
		expect((await values.approver.approve(input)).status).toBe("Approved");
		expect(values.runManySettled).toHaveBeenCalledTimes(1);
		const changed = await values.approver.approve({
			...input,
			selectorProposals: [{ selectorId: "rust-path", value: "crates/cache/other.rs" }],
		});
		expect(changed.status).toBe("Approved");
		expect(values.runManySettled).toHaveBeenCalledTimes(2);
	});

	it("rejects contradictory bytes at an existing immutable approved-design path", async () => {
		const values = await fixture();
		const input = {
			caller: "design" as const,
			design: "immutable design",
			userOrigin: userOriginFromRegisteredCommand("goal"),
			expectedObservationDigest,
			approvedAt: now,
		};
		const first = await values.approver.approve(input);
		if (first.status !== "Approved") throw new Error("expected approval");
		await writeFile(
			join(values.ref.directory, "artifacts", first.record.design.artifactPath),
			"tampered design",
			"utf8",
		);
		await expect(values.approver.approve(input)).rejects.toThrow("contradicts approved design");
	});

	it("rejects a storage result whose digest contradicts the bytes just written", async () => {
		const values = await fixture();
		const original = values.store.writeImmutableArtifact.bind(values.store);
		let writes = 0;
		values.store.writeImmutableArtifact = async (...args) => {
			const written = await original(...args);
			return ++writes === 3 ? { ...written, digest: "0".repeat(64) } : written;
		};
		await expect(
			values.approver.approve({
				caller: "design",
				design: "digest design",
				userOrigin: userOriginFromRegisteredCommand("goal"),
				expectedObservationDigest,
				approvedAt: now,
			}),
		).rejects.toThrow("digest mismatch");
	});

	it("returns ChangesRequired without minting an approved design", async () => {
		const values = await fixture({ findings: [importantFinding()], verdict: "changes_required" });
		const result = await values.approver.approve({
			caller: "design",
			design: "design",
			userOrigin: userOriginFromRegisteredCommand("goal"),
			expectedObservationDigest,
			approvedAt: now,
		});
		expect(result).toMatchObject({
			status: "ChangesRequired",
			reviewSubject: { kind: "standalone-design", observation },
			subjectDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		if (result.status !== "ChangesRequired") throw new Error("expected changes required");
		expect(observationSubjectDigest(result.reviewSubject.observation)).toBe(expectedObservationDigest);
		await expect(readdir(join(values.ref.directory, "artifacts", "approved-designs"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("blocks when the subject drifts after panel publication", async () => {
		const drifted = { ...observation, workingDigest: "9".repeat(64) };
		const values = await fixture({ captures: [observation, observation, drifted] });
		const result = await values.approver.approve({
			caller: "design",
			design: "design",
			userOrigin: userOriginFromRegisteredCommand("goal"),
			expectedObservationDigest,
			approvedAt: now,
		});
		expect(result).toMatchObject({ status: "Blocked", diagnostics: [{ cause: "subject_drift" }] });
		await expect(readdir(join(values.ref.directory, "artifacts", "approved-designs"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
