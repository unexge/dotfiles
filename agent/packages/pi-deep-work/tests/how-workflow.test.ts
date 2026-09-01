import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGateway } from "../src/agents/gateway.ts";
import { ControlAcceptedError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import type { BackendTreeService, GitTreeSnapshot } from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { RunStore } from "../src/store/run-store.ts";
import type { GitRepository } from "../src/vcs/types.ts";
import { runHowWorkflow } from "../src/workflows/how.ts";

const temporary: string[] = [];

function snapshot(workingDigest = "c".repeat(64)): GitTreeSnapshot {
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

async function fixture(captures: GitTreeSnapshot[]) {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-how-"));
	temporary.push(root);
	const store = new RunStore(root);
	const leases = new PortableLeaseManager(root);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "how" as const,
		repositoryId: "a".repeat(64),
		policyDigest: "b".repeat(64),
		goal: "explain",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create("git", initial);
	const repository: GitRepository = {
		kind: "git",
		root: "/repo",
		sharedRoot: "/repo/.git",
		commonDir: "/repo/.git",
		repositoryId: initial.repositoryId,
	};
	const authority = await RunAuthority.start(
		{
			store,
			leases,
			ref,
			repository,
			attemptId: attemptId(randomUUID()),
			phase: "how",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	let captureIndex = 0;
	const trees = {
		captureObservation: async () => captures[Math.min(captureIndex++, captures.length - 1)],
	} as BackendTreeService;
	let boundAuthority = authority;
	const gateway = {
		assertAuthority(value: RunAuthority) {
			if (value !== boundAuthority) throw new Error("wrong authority");
		},
		run: async (job: { kind: string }) => {
			if (job.kind === "plan") {
				return {
					report: {
						value: {
							status: "ok",
							summary: "planned",
							citations: [],
							interpretation: "question",
							successCriteria: ["trace behavior"],
							steps: ["entry point", "data flow"],
						},
					},
				};
			}
			return {
				report: {
					value: {
						status: "ok",
						summary: "edited",
						citations: [{ path: "src/value.ts", detail: "entry" }],
						output: "The system traces input to output.",
					},
				},
			};
		},
		runMany: async (jobs: unknown[]) =>
			jobs.map(() => ({
				report: {
					value: {
						status: "ok",
						summary: "explored",
						citations: [{ path: "src/value.ts", detail: "flow" }],
						components: ["component"],
						flow: ["input", "output"],
						constraints: [],
						unknowns: [],
					},
				},
			})),
	} as unknown as AgentGateway;
	return {
		root,
		store,
		leases,
		ref,
		repository,
		authority,
		trees,
		gateway,
		bindAuthority(value: RunAuthority) {
			boundAuthority = value;
		},
	};
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("how workflow", () => {
	it("publishes one same-subject explanation", async () => {
		const values = await fixture([snapshot()]);
		const result = await runHowWorkflow({
			origin: userOriginFromRegisteredCommand("How does this work?"),
			authority: values.authority,
			gateway: values.gateway,
			trees: values.trees,
			store: values.store,
			ref: values.ref,
			concurrency: 2,
			completedAt: "2026-08-25T00:00:02.000Z",
		});
		expect(result).toMatchObject({ outcome: "ExplanationProduced", output: "The system traces input to output." });
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "ExplanationProduced" });
		expect(JSON.parse(await readFile(join(values.ref.directory, "artifacts", result.artifactPath), "utf8"))).toMatchObject({
			question: "How does this work?",
			proposedOutcome: "ExplanationProduced",
			authoritative: false,
			lifecycleAuthority: "state.json",
		});
	});

	it("keeps a pending-control output provisional and replaceable", async () => {
		const values = await fixture([snapshot()]);
		const original = values.store.writeArtifact.bind(values.store);
		let requested = false;
		values.store.writeArtifact = async (...args) => {
			const written = await original(...args);
			if (!requested && args[1] === "outputs/how.json") {
				requested = true;
				await values.store.appendControl(values.ref, "Pause", "2026-08-25T00:00:02.000Z");
			}
			return written;
		};
		await expect(
			runHowWorkflow({
				origin: userOriginFromRegisteredCommand("How does this work?"),
				authority: values.authority,
				gateway: values.gateway,
				trees: values.trees,
				store: values.store,
				ref: values.ref,
				concurrency: 2,
				completedAt: "2026-08-25T00:00:03.000Z",
			}),
		).rejects.toBeInstanceOf(ControlAcceptedError);
		const paused = await values.store.load(values.ref);
		expect(paused).toMatchObject({ lifecycle: "Paused" });
		if (paused.lifecycle !== "Paused") throw new Error("expected paused run");
		values.store.writeArtifact = original;
		const resumed = await RunAuthority.resume(
			{
				store: values.store,
				leases: values.leases,
				ref: values.ref,
				repository: values.repository,
				attemptId: attemptId(randomUUID()),
				phase: "how",
				pollIntervalMs: 5,
			},
			paused,
			"2026-08-25T00:00:04.000Z",
		);
		values.bindAuthority(resumed);
		const completed = await runHowWorkflow({
			origin: userOriginFromRegisteredCommand("How does this work?"),
			authority: resumed,
			gateway: values.gateway,
			trees: values.trees,
			store: values.store,
			ref: values.ref,
			concurrency: 2,
			completedAt: "2026-08-25T00:00:05.000Z",
		});
		expect(completed.outcome).toBe("ExplanationProduced");
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed" });
	});

	it("turns schema-valid blocked and failed agent statuses into explicit lifecycles", async () => {
		for (const status of ["blocked", "failed"] as const) {
			const values = await fixture([snapshot()]);
			(values.gateway as unknown as { run: (job: unknown) => Promise<unknown> }).run = async () => ({
				report: { value: { status, summary: status, citations: [], interpretation: "", successCriteria: [], steps: [] } },
			});
			const result = await runHowWorkflow({
				origin: userOriginFromRegisteredCommand("How does this work?"),
				authority: values.authority,
				gateway: values.gateway,
				trees: values.trees,
				store: values.store,
				ref: values.ref,
				concurrency: 1,
				completedAt: "2026-08-25T00:00:02.000Z",
			});
			expect(result.outcome).toBe(status === "blocked" ? "Blocked" : "Failed");
			expect(await values.store.load(values.ref)).toMatchObject({
				lifecycle: status === "blocked" ? "Blocked" : "Failed",
			});
		}
	});

	it("fails and releases ownership on an unexpected workflow error", async () => {
		const values = await fixture([snapshot()]);
		(values.gateway as unknown as { run: (job: unknown) => Promise<unknown> }).run = async () => {
			throw new Error("unexpected planner failure");
		};
		const result = await runHowWorkflow({
			origin: userOriginFromRegisteredCommand("How does this work?"),
			authority: values.authority,
			gateway: values.gateway,
			trees: values.trees,
			store: values.store,
			ref: values.ref,
			concurrency: 1,
			completedAt: "2026-08-25T00:00:02.000Z",
		});
		expect(result.outcome).toBe("Failed");
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
		await expect(
			values.leases.acquire({
				scope: "repository",
				repositoryId: values.repository.repositoryId,
				runId: randomUUID(),
				attemptId: randomUUID(),
			}),
		).resolves.toBeTruthy();
	});

	it("discards reports and blocks on subject drift", async () => {
		const values = await fixture([snapshot(), snapshot(), snapshot("e".repeat(64))]);
		const result = await runHowWorkflow({
			origin: userOriginFromRegisteredCommand("How does this work?"),
			authority: values.authority,
			gateway: values.gateway,
			trees: values.trees,
			store: values.store,
			ref: values.ref,
			concurrency: 2,
			completedAt: "2026-08-25T00:00:02.000Z",
		});
		expect(result.outcome).toBe("Blocked");
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Blocked" });
	});
});
