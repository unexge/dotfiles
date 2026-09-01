import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../src/store/run-store.ts";
import { blockRun, resumeRun, startRun } from "../src/application/lifecycle.ts";
import { attemptId } from "../src/application/types.ts";
import { decodeRunProjection, type QueuedRun } from "../src/store/schemas.ts";

const temporary: string[] = [];

function queued(runId: string, repositoryId: string): QueuedRun {
	return decodeRunProjection({
		schemaVersion: 1,
		runId,
		workflow: "how",
		repositoryId,
		policyDigest: "b".repeat(64),
		goal: "lookup",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued",
	}) as QueuedRun;
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("run lookup", () => {
	it("never enumerates historical non-run directories", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-ignore-junk-"));
		temporary.push(agentDir);
		const junk = join(agentDir, "pi-deep-work", "runs", "junk-repository", randomUUID());
		await mkdir(junk, { recursive: true });
		await writeFile(join(junk, "state.json"), JSON.stringify({ schemaVersion: 0, status: "passed" }), "utf8");
		const store = new RunStore(agentDir);
		expect(await store.list()).toEqual([]);
	});

	it("skips one malformed run without hiding valid repository runs", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-list-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const repositoryId = "a".repeat(64);
		const validId = randomUUID();
		await store.create("git", queued(validId, repositoryId));
		const malformed = join(store.root, `git-${repositoryId}`, randomUUID());
		await mkdir(join(malformed, "events"), { recursive: true });
		await writeFile(join(malformed, "state.json"), "not-json", "utf8");
		const listed = await store.list(repositoryId);
		expect(listed.map((value) => value.ref.runId)).toEqual([validId]);
	});

	it("recovers the latest durable control watermark from event history", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-watermark-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const ref = await store.create("git", queued(randomUUID(), "a".repeat(64)));
		const created = await store.load(ref);
		if (created.lifecycle !== "Queued") throw new Error("expected queued");
		const first = startRun(created, attemptId(randomUUID()), "work", "2026-08-25T00:00:01.000Z");
		let active = await store.appendTransition(ref, "AttemptStarted", first, first.updatedAt);
		if (active.lifecycle !== "Active") throw new Error("expected active");
		for (let revision = 1; revision <= 5; revision++) {
			const blockedAt = String(revision * 2).padStart(2, "0");
			const resumedAt = String(revision * 2 + 1).padStart(2, "0");
			const blocked = blockRun(active, "blocked", `2026-08-25T00:00:${blockedAt}.000Z`, revision);
			const recoverable = await store.appendTransition(ref, "AttemptStopped", blocked, blocked.updatedAt);
			if (recoverable.lifecycle !== "Blocked") throw new Error("expected blocked");
			const resumed = resumeRun(
				recoverable,
				attemptId(randomUUID()),
				"work",
				`2026-08-25T00:00:${resumedAt}.000Z`,
			);
			active = await store.appendTransition(ref, "AttemptStarted", resumed, resumed.updatedAt);
			if (active.lifecycle !== "Active") throw new Error("expected active");
		}
		expect(active.lastEventRevision).toBeGreaterThan(10);
		expect(await store.latestObservedControlRevision(ref)).toBe(5);
	});

	it("rejects ambiguous partial IDs across repositories", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-lookup-"));
		temporary.push(agentDir);
		const store = new RunStore(agentDir);
		const suffixA = randomUUID().slice(8);
		const suffixB = randomUUID().slice(8);
		const first = `12345678${suffixA}`;
		const second = `12345678${suffixB}`;
		await store.create("git", queued(first, "a".repeat(64)));
		await store.create("jj", queued(second, "c".repeat(64)));
		await expect(store.find("12345678")).rejects.toThrow("ambiguous");
		expect((await store.find(first)).backend).toBe("git");
		expect((await store.find(second)).backend).toBe("jj");
	});
});
