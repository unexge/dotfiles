import { persistApprovedDesign } from "./helpers/approved-design.ts";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { QualifyAndCommit } from "../src/application/qualify-and-commit.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import type { GitCandidateSubject } from "../src/subject/types.ts";
import { evidenceSubjectDigest, observationSubjectDigest } from "../src/subject/content.ts";
import type { GateRecord } from "../src/gates/schemas.ts";

const observation = {
	schemaVersion: 1 as const,
	kind: "git" as const,
	repositoryId: "a".repeat(64),
	root: "/repo",
	policyDigest: "b".repeat(64),
	workingDigest: "c".repeat(64),
	changedPathsDigest: "d".repeat(64),
	headOid: "1".repeat(40),
	symbolicRef: "refs/heads/main",
	conflicted: false as const,
	indexTree: "2".repeat(40),
};

const candidate: GitCandidateSubject = {
	schemaVersion: 1,
	kind: "git",
	observation,
	treeOid: "3".repeat(40),
	patchDigest: "4".repeat(64),
	changedPathsDigest: "5".repeat(64),
	approvedDesignId: "6".repeat(64),
	behaviorContractId: "7".repeat(64),
};

const command = {
	id: "quick",
	category: "quick",
	source: "project",
	claimKeys: [],
	argv: ["check"],
	argvDigest: () => "8".repeat(64),
};

function missing(path: string): NodeJS.ErrnoException {
	return Object.assign(new Error(path), { code: "ENOENT" });
}

describe("qualification gate repair", () => {
	it.each([
		{ category: "quick", budget: 0, outcome: "failed", repairs: 0 },
		{ category: "quick", budget: 1, outcome: "failed", repairs: 1 },
		{ category: "full", budget: 2, outcome: "failed", repairs: 2 },
		...(["timed_out", "cancelled", "output_overflow", "incomplete", "drifted"] as const).map((outcome) => ({ category: "quick", budget: 1, outcome, repairs: 0 })),
	])("bounds stable $category failure repairs and rejects $outcome (budget $budget)", async ({ category, budget, outcome, repairs }) => {
		const repair = { repair: vi.fn().mockResolvedValue(undefined) };
		const artifacts = new Map<string, Buffer>();
		const ref = { runId: "run", directory: "/run", repositoryId: observation.repositoryId };
		const store = {
			load: vi.fn().mockResolvedValue({ lifecycle: "Active", attemptId: "attempt", lastEventRevision: 1, workflow: "build", policyDigest: observation.policyDigest }),
			readOptionalArtifact: vi.fn(async (_ref, path: string) => artifacts.get(path)),
			controls: vi.fn().mockResolvedValue({ revision: 0 }),
			readArtifact: vi.fn().mockImplementation(async (_ref, path: string) => {
				if (artifacts.has(path)) return artifacts.get(path);
				if (path.endsWith("stdout.bin")) return Buffer.from("");
				if (path.endsWith("stderr.bin")) return Buffer.from(`${"x".repeat(10 * 1024)}syntax error`);
				throw missing("qualification progress");
			}),
			writeArtifact: vi.fn().mockResolvedValue(undefined),
			writeCheckpoint: vi.fn().mockResolvedValue(undefined),
			writeImmutableArtifact: vi.fn().mockImplementation(async (_ref, path: string, content: Buffer | string) => {
				artifacts.set(path, Buffer.from(content));
				return { digest: createHash("sha256").update(content).digest("hex") };
			}),
		};
		const approvedDesign = await persistApprovedDesign(store as never, ref as never, observation);
		const gateCommand = { ...command, category };
		const runGate = vi.fn().mockImplementation(async () => ({
			record: {
				schemaVersion: 1, executionId: randomUUID(),
				source: gateCommand.source, category, commandId: gateCommand.id, argvDigest: gateCommand.argvDigest(),
				backend: "git", subject: candidate, subjectDigest: evidenceSubjectDigest(candidate),
				beforeObservationDigest: observationSubjectDigest(observation),
				afterObservationDigest: outcome === "drifted" ? "f".repeat(64) : observationSubjectDigest(observation),
				startedAt: "2026-08-25T00:00:00.000Z", completedAt: "2026-08-25T00:00:01.000Z", durationMs: 1000,
				outcome: outcome as GateRecord["outcome"], exitCode: 1, terminationSignal: null, diagnostic: null,
				stdout: { path: "commands/one/stdout.bin", digest: "a".repeat(64), bytes: 0, complete: true },
				stderr: { path: "commands/one/stderr.bin", digest: "b".repeat(64), bytes: 12, complete: true },
			},
			recordArtifact: { path: "commands/one/record.json", digest: "c".repeat(64), bytes: 1, complete: true },
		}));
		const publish = vi.fn();
		const qualifier = new QualifyAndCommit(
			{ machine: { maxRepairRounds: budget } } as never,
			{ commandsFor: (group: string) => (group === category ? [gateCommand] : []) } as never,
			{ runExactlyTwoPasses: vi.fn().mockResolvedValue({}) } as never,
			{
				sealCandidate: vi.fn().mockResolvedValue(candidate),
				renderCandidatePatch: vi.fn().mockResolvedValue({ patch: "patch", paths: ["file.zig"] }),
			} as never,
			{ run: runGate } as never,
			{} as never,
			{} as never,
			store as never,
			ref as never,
			{ kind: "git", service: { publish } as never },
			repair as never,
		);

		const result = await qualifier.run({
			workflow: "build",
			approvedDesign,
			userOrigin: userOriginFromRegisteredCommand("fix the generated feature"),
			checkpointSequence: 2,
			authorizedAt: "2026-08-25T00:00:00.000Z",
		});

		expect(result).toMatchObject(outcome === "failed"
			? { status: "ChangesRequired", phase: `${category} gates`, repairRounds: repairs, findings: [expect.objectContaining({ detail: expect.stringContaining("syntax error") })] }
			: { status: "Blocked" });
		expect(repair.repair).toHaveBeenCalledTimes(repairs);
		expect(runGate).toHaveBeenCalledTimes(repairs + 1);
		expect(publish).not.toHaveBeenCalled();
		if (result.status === "ChangesRequired") {
			expect(result.findings[0].detail).toContain("[truncated");
			expect(result.findings[0].detail.length).toBeLessThan(9 * 1024);
			expect(result.findings[0].evidence).toContain(`Candidate: ${evidenceSubjectDigest(candidate)}`);
		}
		if (repairs === 0) return;
		expect(repair.repair).toHaveBeenCalledWith(
			expect.objectContaining({
				round: 1,
				candidate,
				checkpointSequence: 3,
				findings: [
					expect.objectContaining({
						reviewerId: "machine-gate/quick",
						severity: "blocker",
						detail: expect.stringContaining("syntax error"),
					}),
				],
			}),
		);
	});
});
