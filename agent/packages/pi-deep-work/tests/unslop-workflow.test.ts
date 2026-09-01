import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGateway } from "../src/agents/gateway.ts";
import { ControlAcceptedError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import {
	ObservedDiffPreconditionError,
	type BackendObservationSnapshot,
	type BackendTreeService,
	type ObservedDiff,
} from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { RunStore } from "../src/store/run-store.ts";
import type { DetectedRepository } from "../src/vcs/types.ts";
import { runUnslopWorkflow, type UnslopSource } from "../src/workflows/unslop.ts";

const temporary: string[] = [];

function gitSnapshot(workingDigest = "c".repeat(64)): BackendObservationSnapshot {
	return {
		kind: "git",
		treeId: "3".repeat(40),
		observation: {
			schemaVersion: 1,
			kind: "git",
			repositoryId: "a".repeat(64),
			root: "/repo",
			policyDigest: "b".repeat(64),
			workingDigest,
			changedPathsDigest: "d".repeat(64),
			headOid: "1".repeat(40),
			symbolicRef: "refs/heads/main",
			conflicted: false,
			indexTree: "2".repeat(40),
		},
	};
}

function jjSnapshot(workingDigest = "c".repeat(64)): BackendObservationSnapshot {
	return {
		kind: "jj",
		treeDigest: "3".repeat(64),
		observation: {
			schemaVersion: 1,
			kind: "jj",
			repositoryId: "a".repeat(64),
			root: "/repo",
			policyDigest: "b".repeat(64),
			workingDigest,
			changedPathsDigest: "d".repeat(64),
			operationId: "op-1",
			workspaceId: "default",
			changeId: "4".repeat(32),
			commitId: "5".repeat(64),
			parentCommitIds: ["6".repeat(64)],
			conflicted: false,
		},
	};
}

async function fixture(kind: "git" | "jj" = "git") {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-unslop-"));
	temporary.push(root);
	const store = new RunStore(root);
	const leases = new PortableLeaseManager(root);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "unslop" as const,
		repositoryId: "a".repeat(64),
		policyDigest: "b".repeat(64),
		goal: "unslop",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create(kind, initial);
	const repository: DetectedRepository =
		kind === "git"
			? {
					kind: "git",
					root: "/repo",
					sharedRoot: "/repo/.git",
					commonDir: "/repo/.git",
					repositoryId: initial.repositoryId,
				}
			: {
					kind: "jj",
					root: "/repo",
					sharedRoot: "/repo/.jj/repo",
					gitStore: "/repo/.jj/repo/store/git",
					workspaceId: "default",
					repositoryId: initial.repositoryId,
				};
	const authority = await RunAuthority.start(
		{
			store,
			leases,
			ref,
			repository,
			attemptId: attemptId(randomUUID()),
			phase: "unslop",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	const snapshot = kind === "git" ? gitSnapshot() : jjSnapshot();
	let renderError: Error | undefined;
	let rendered: ObservedDiff = {
		kind,
		baseRevision: kind === "git" ? "1".repeat(40) : "6".repeat(64),
		patch: "diff --git a/value.ts b/value.ts\n+const value = true;\n",
		paths: ["value.ts"],
		diffDigest: "e".repeat(64),
	};
	let afterWrite: "drift" | "fail" | undefined;
	let artifactWritten = false;
	let artifactWrites = 0;
	let failDiagnostic = false;
	let pauseAfterWrite = false;
	const originalWriteArtifact = store.writeArtifact.bind(store);
	store.writeArtifact = async (...args) => {
		if (args[1] === "outputs/unslop.json" && failDiagnostic && artifactWrites > 0) {
			throw new Error("diagnostic write failed");
		}
		const result = await originalWriteArtifact(...args);
		if (args[1] === "outputs/unslop.json") {
			artifactWritten = true;
			artifactWrites++;
			if (pauseAfterWrite) {
				pauseAfterWrite = false;
				await store.appendControl(ref, "Pause", "2026-08-25T00:00:01.500Z");
			}
		}
		return result;
	};
	const trees = {
		captureObservation: async () => {
			if (artifactWritten && afterWrite === "fail") throw new Error("recapture failed");
			if (artifactWritten && afterWrite === "drift") {
				return kind === "git" ? gitSnapshot("f".repeat(64)) : jjSnapshot("f".repeat(64));
			}
			return snapshot;
		},
		renderObservedDiff: async () => {
			if (renderError) throw renderError;
			return rendered;
		},
	} as unknown as BackendTreeService;
	const jobs: string[] = [];
	const statuses = new Map<string, "ok" | "blocked" | "failed">();
	const gateway = {
		assertAuthority(value: RunAuthority) {
			if (value !== authority) throw new Error("wrong authority");
		},
		run: async (job: { kind: string }) => {
			jobs.push(job.kind);
			const status = statuses.get(job.kind) ?? "ok";
			if (job.kind === "explore") {
				return {
					report: {
						value: {
							status,
							summary: status,
							citations: [],
							components: [],
							flow: [],
							constraints: [],
							unknowns: [],
						},
					},
				};
			}
			return {
				report: {
					value: {
						status,
						summary: status,
						citations: [{ path: "value.ts", detail: "evidence" }],
						output: "Concise unslop result.",
					},
				},
			};
		},
	} as unknown as AgentGateway;
	return {
		root,
		store,
		ref,
		authority,
		trees,
		gateway,
		jobs,
		statuses,
		setRenderError(error: Error | undefined) {
			renderError = error;
		},
		setRendered(value: ObservedDiff) {
			rendered = value;
		},
		setAfterWrite(value: "drift" | "fail" | undefined) {
			afterWrite = value;
		},
		failDiagnosticWrite() {
			failDiagnostic = true;
		},
		pauseAfterProvisionalWrite() {
			pauseAfterWrite = true;
		},
	};
}

async function run(values: Awaited<ReturnType<typeof fixture>>, source: UnslopSource) {
	return runUnslopWorkflow({
		source,
		origin: userOriginFromRegisteredCommand("Unslop this"),
		authority: values.authority,
		gateway: values.gateway,
		trees: values.trees,
		store: values.store,
		ref: values.ref,
		completedAt: "2026-08-25T00:00:02.000Z",
	});
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("unslop workflow", () => {
	it("rewrites text with no inspection tools and binds its exact digest", async () => {
		const values = await fixture();
		const result = await run(values, { kind: "text", text: "Some verbose prose." });
		expect(result).toMatchObject({ outcome: "UnslopReportProduced", output: "Concise unslop result." });
		expect(values.jobs).toEqual(["edit"]);
		expect(await values.store.load(values.ref)).toMatchObject({
			lifecycle: "Completed",
			outcome: "UnslopReportProduced",
		});
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/unslop.json"), "utf8"));
		expect(artifact).toMatchObject({
			proposedOutcome: "UnslopReportProduced",
			authoritative: false,
			lifecycleAuthority: "state.json",
			source: {
				kind: "text",
				textDigest: createHash("sha256").update("Some verbose prose.").digest("hex"),
			},
		});
	});

	for (const kind of ["git", "jj"] as const) {
		it(`inspects and publishes one exact ${kind} diff`, async () => {
			const values = await fixture(kind);
			const result = await run(values, { kind: "diff", base: "base" });
			expect(result.outcome).toBe("UnslopReportProduced");
			expect(values.jobs).toEqual(["explore", "edit"]);
			const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/unslop.json"), "utf8"));
			expect(artifact).toMatchObject({
				source: {
					kind: "diff",
					diffDigest: "e".repeat(64),
					paths: ["value.ts"],
				},
			});
		});
	}

	it("maps every observed-diff precondition and empty input to Blocked", async () => {
		for (const reason of [
			"Observed diff base cannot be empty",
			"Cannot render a Git diff with unresolved conflicts",
			"Jujutsu observed diff requires an explicit base for a multi-parent commit",
		]) {
			const values = await fixture();
			values.setRenderError(new ObservedDiffPreconditionError(reason));
			const result = await run(values, { kind: "diff" });
			expect(result).toMatchObject({ outcome: "Blocked", reason });
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
		}
		const values = await fixture();
		values.setRendered({
			kind: "git",
			baseRevision: "1".repeat(40),
			patch: "",
			paths: [],
			diffDigest: createHash("sha256").update("").digest("hex"),
		});
		expect(await run(values, { kind: "diff" })).toMatchObject({ outcome: "Blocked", reason: "No diff to unslop" });
		const emptyText = await fixture();
		expect(await run(emptyText, { kind: "text", text: "  " })).toMatchObject({
			outcome: "Blocked",
			reason: "Text input cannot be empty",
		});
	});

	it("maps schema-valid explorer and editor statuses to Blocked or Failed", async () => {
		for (const job of ["explore", "edit"] as const) {
			for (const status of ["blocked", "failed"] as const) {
				const values = await fixture();
				values.statuses.set(job, status);
				const source = job === "explore" ? ({ kind: "diff" } as const) : ({ kind: "text", text: "text" } as const);
				expect(await run(values, source)).toMatchObject({
					outcome: status === "blocked" ? "Blocked" : "Failed",
				});
				expect(await values.store.load(values.ref)).toMatchObject({
					lifecycle: status === "blocked" ? "Blocked" : "Failed",
				});
			}
		}
	});

	it("replaces a provisional output with an atomic Blocked drift diagnostic", async () => {
		const values = await fixture();
		values.setAfterWrite("drift");
		const result = await run(values, { kind: "text", text: "text" });
		expect(result).toMatchObject({ outcome: "Blocked" });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/unslop.json"), "utf8"));
		expect(artifact).toMatchObject({ proposedOutcome: "Blocked", authoritative: false });
		expect(artifact.output).toBeUndefined();
		expect(artifact.beforeSubjectDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(artifact.afterSubjectDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("propagates a Pause admitted after provisional publication", async () => {
		const values = await fixture();
		values.pauseAfterProvisionalWrite();
		await expect(run(values, { kind: "text", text: "text" })).rejects.toBeInstanceOf(ControlAcceptedError);
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Paused" });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/unslop.json"), "utf8"));
		expect(artifact).toMatchObject({ proposedOutcome: "UnslopReportProduced", authoritative: false });
	});

	it("surfaces a failed drift diagnostic write after settling Blocked", async () => {
		const values = await fixture();
		values.setAfterWrite("drift");
		values.failDiagnosticWrite();
		await expect(run(values, { kind: "text", text: "text" })).rejects.toThrow("diagnostic write failed");
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/unslop.json"), "utf8"));
		expect(artifact).toMatchObject({ proposedOutcome: "UnslopReportProduced", authoritative: false });
	});

	it("settles Failed and replaces provisional output when recapture fails technically", async () => {
		const values = await fixture();
		values.setAfterWrite("fail");
		const result = await run(values, { kind: "text", text: "text" });
		expect(result).toMatchObject({ outcome: "Failed", reason: "recapture failed" });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
		const artifact = JSON.parse(await readFile(join(values.ref.directory, "artifacts/outputs/unslop.json"), "utf8"));
		expect(artifact).toMatchObject({ proposedOutcome: "Failed", authoritative: false, reason: "recapture failed" });
		expect(artifact.output).toBeUndefined();
	});
});
