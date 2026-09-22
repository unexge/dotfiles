import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { QualifyAndCommit } from "../src/application/qualify-and-commit.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import type { GitCandidateSubject } from "../src/subject/types.ts";

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
	it("sends a stable quick-gate failure through the bounded repair loop", async () => {
		const repair = { repair: vi.fn().mockResolvedValue(undefined) };
		const store = {
			load: vi.fn().mockResolvedValue({ lifecycle: "Active", attemptId: "attempt", lastEventRevision: 1 }),
			controls: vi.fn().mockResolvedValue({ revision: 0 }),
			readArtifact: vi.fn().mockImplementation(async (_ref, path: string) => {
				if (path.endsWith("stdout.bin")) return Buffer.from("");
				if (path.endsWith("stderr.bin")) return Buffer.from("syntax error");
				throw missing("qualification progress");
			}),
			writeArtifact: vi.fn().mockResolvedValue(undefined),
			writeCheckpoint: vi.fn().mockResolvedValue(undefined),
			writeImmutableArtifact: vi.fn().mockImplementation(async (_ref, _path, content: Buffer) => ({
				digest: createHash("sha256").update(content).digest("hex"),
			})),
		};
		const qualifier = new QualifyAndCommit(
			{ machine: { maxRepairRounds: 1 } } as never,
			{ commandsFor: (category: string) => (category === "quick" ? [command] : []) } as never,
			{ runExactlyTwoPasses: vi.fn().mockResolvedValue({}) } as never,
			{
				sealCandidate: vi.fn().mockResolvedValue(candidate),
				renderCandidatePatch: vi.fn().mockResolvedValue({ patch: "patch", paths: ["file.zig"] }),
			} as never,
			{
				run: vi.fn().mockResolvedValue({
					record: {
						outcome: "failed",
						exitCode: 1,
						diagnostic: null,
						stdout: { path: "commands/one/stdout.bin" },
						stderr: { path: "commands/one/stderr.bin" },
					},
				}),
			} as never,
			{} as never,
			{} as never,
			store as never,
			{ runId: "run", directory: "/run" } as never,
			{ kind: "git", service: {} as never },
			repair as never,
		);

		const result = await qualifier.run({
			workflow: "build",
			approvedDesign: {
				caller: "build",
				approvedDesignId: candidate.approvedDesignId,
				behavior: { kind: "contract", digest: candidate.behaviorContractId, contract: { observationIds: [] } },
			} as never,
			userOrigin: userOriginFromRegisteredCommand("fix the generated feature"),
			checkpointSequence: 2,
			authorizedAt: "2026-08-25T00:00:00.000Z",
		});

		expect(result).toMatchObject({ status: "Blocked" });
		expect(repair.repair).toHaveBeenCalledOnce();
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
