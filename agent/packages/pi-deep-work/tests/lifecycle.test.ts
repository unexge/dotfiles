import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	blockRun,
	cancelRun,
	completeRun,
	failQueuedRun,
	failRun,
	LifecycleTransitionError,
	requestPause,
	requireManualInspection,
	resumeRun,
	settlePause,
	startRun,
} from "../src/application/lifecycle.ts";
import { attemptId } from "../src/application/types.ts";
import { decodeRunProjection, type QueuedRun } from "../src/store/schemas.ts";

const initialTime = "2026-08-25T00:00:00.000Z";
const nextTime = "2026-08-25T00:01:00.000Z";
const laterTime = "2026-08-25T00:02:00.000Z";

function queued(workflow: QueuedRun["workflow"] = "build"): QueuedRun {
	return decodeRunProjection({
		schemaVersion: 1,
		runId: randomUUID(),
		workflow,
		repositoryId: "a".repeat(64),
		policyDigest: "b".repeat(64),
		goal: "test lifecycle",
		createdAt: initialTime,
		updatedAt: initialTime,
		lastEventRevision: 0,
		lifecycle: "Queued",
	}) as QueuedRun;
}

describe("lifecycle transitions", () => {
	it("starts immutably and increments event revision", () => {
		const before = queued();
		const started = startRun(before, attemptId(randomUUID()), "frame", nextTime);
		expect(before.lifecycle).toBe("Queued");
		expect(started).toMatchObject({ lifecycle: "Active", phase: "frame", lastEventRevision: 1, updatedAt: nextTime });
		expect(decodeRunProjection(started)).toEqual(started);
	});

	it("pauses only through Pausing and resumes with a new attempt", () => {
		const firstAttempt = attemptId(randomUUID());
		const secondAttempt = attemptId(randomUUID());
		const active = startRun(queued(), firstAttempt, "implement", nextTime);
		const pausing = requestPause(active, laterTime);
		const paused = settlePause(pausing, "session shutdown", laterTime, 1);
		const resumed = resumeRun(paused, secondAttempt, "implement", laterTime);
		expect(pausing.lifecycle).toBe("Pausing");
		expect(paused).toMatchObject({ lifecycle: "Paused", lastAttemptId: firstAttempt });
		expect(resumed).toMatchObject({ lifecycle: "Active", attemptId: secondAttempt, lastEventRevision: 4 });
		expect(() => settlePause(active, "invalid", laterTime, 0)).toThrow(LifecycleTransitionError);
		expect(() => requestPause(pausing, laterTime)).toThrow(LifecycleTransitionError);
	});

	it("projects blocked and manual states as recoverable", () => {
		const active = startRun(queued(), attemptId(randomUUID()), "gates", nextTime);
		for (const state of [
			blockRun(active, "gate failed", laterTime, 0),
			requireManualInspection(active, "partial mutation", laterTime, 0),
			requireManualInspection(requestPause(active, laterTime), "pause settlement uncertain", laterTime, 0),
		]) {
			expect(["Blocked", "NeedsManualInspection"]).toContain(state.lifecycle);
			expect(decodeRunProjection(state)).toEqual(state);
		}
	});

	it("cancels or fails an attempt without fabricating an outcome", () => {
		const queuedState = queued();
		const queuedFailureAttempt = attemptId(randomUUID());
		expect(failQueuedRun(queuedState, queuedFailureAttempt, "startup failed", laterTime)).toMatchObject({
			lifecycle: "Failed",
			lastAttemptId: queuedFailureAttempt,
			reason: "startup failed",
		});
		const active = startRun(queued(), attemptId(randomUUID()), "review", nextTime);
		const cancelled = cancelRun(active, "user cancelled", laterTime);
		const pausing = requestPause(active, laterTime);
		const cancelledPausing = cancelRun(pausing, "cancel supersedes pause", laterTime);
		const paused = settlePause(pausing, "paused", laterTime, 1);
		const cancelledPaused = cancelRun(paused, "cancel paused run", laterTime);
		const failed = failRun(active, "provider failed", laterTime);
		expect(cancelled).toMatchObject({ lifecycle: "Cancelled", reason: "user cancelled" });
		expect(cancelledPausing).toMatchObject({
			lifecycle: "Cancelled",
			lastAttemptId: pausing.attemptId,
			reason: "cancel supersedes pause",
		});
		expect(cancelledPaused).toMatchObject({ lifecycle: "Cancelled", lastAttemptId: paused.lastAttemptId });
		expect(failed).toMatchObject({ lifecycle: "Failed", reason: "provider failed" });
		expect("outcome" in cancelled).toBe(false);
		expect("outcome" in failed).toBe(false);
		expect(() => failRun(pausing, "invalid", laterTime)).toThrow(LifecycleTransitionError);
		expect(() => blockRun(pausing, "invalid", laterTime, 0)).toThrow(LifecycleTransitionError);
	});

	it("accepts only workflow-compatible completion outcomes", () => {
		const how = startRun(queued("how"), attemptId(randomUUID()), "explain", nextTime);
		expect(completeRun(how, "ExplanationProduced", "final.md", laterTime)).toMatchObject({
			lifecycle: "Completed",
			outcome: "ExplanationProduced",
		});
		expect(() => completeRun(how, "LocalCommitCreated", "final.md", laterTime)).toThrow(
			"is not valid for how",
		);
		expect(() => completeRun(requestPause(how, laterTime), "ExplanationProduced", "final.md", laterTime)).toThrow(
			LifecycleTransitionError,
		);
		expect(() => startRun(queued(), attemptId(randomUUID()), "", laterTime)).toThrow("phase cannot be empty");
		expect(() => blockRun(startRun(queued(), attemptId(randomUUID()), "frame", laterTime), "", laterTime, 0)).toThrow(
			"reason cannot be empty",
		);
		expect(() => completeRun(how, "ExplanationProduced", "", laterTime)).toThrow("summaryArtifact cannot be empty");
	});
});
