import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { startRun } from "../src/application/lifecycle.ts";
import { attemptId } from "../src/application/types.ts";
import { observationSubjectDigest } from "../src/subject/content.ts";
import type { QueuedRun } from "../src/store/schemas.ts";
import { captureGitObservation } from "../src/vcs/git-backend.ts";
import { captureJjObservation } from "../src/vcs/jj-backend.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner } from "../src/vcs/types.ts";
import { projectInterruptedMutation } from "../src/workspace/recovery.ts";
import {
	createRepositoryFixture,
	detectJjAvailability,
	isolatedVcsEnvironment,
	type RepositoryFixtureKind,
} from "./helpers/repositories.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const policyDigest = "b".repeat(64);
const jjAvailability = await detectJjAvailability();

const runner: CommandRunner = async (command, args, options) => {
	try {
		const result = await executeFile(command, [...args], {
			cwd: options.cwd,
			env: isolatedVcsEnvironment(tmpdir()),
			signal: options.signal,
			maxBuffer: 20 * 1024 * 1024,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
		return {
			code: typeof failure.code === "number" ? failure.code : 1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? failure.message,
			errorCode: typeof failure.code === "string" ? failure.code : undefined,
		};
	}
};

async function crashMutation(kind: RepositoryFixtureKind): Promise<void> {
	const fixture = await createRepositoryFixture(kind);
	try {
		const repository = await detectRepository(fixture.root, runner);
		const before =
			repository.kind === "git"
				? await captureGitObservation(repository, policyDigest, runner)
				: await captureJjObservation(repository, policyDigest, runner);
		const initial: QueuedRun = {
			schemaVersion: 1,
			runId: randomUUID(),
			workflow: "build",
			repositoryId: repository.repositoryId,
			policyDigest,
			goal: "crash mutation",
			createdAt: "2026-08-25T00:00:00.000Z",
			updatedAt: "2026-08-25T00:00:00.000Z",
			lastEventRevision: 1,
			lifecycle: "Queued",
		};
		const active = startRun(initial, attemptId(randomUUID()), "implement", "2026-08-25T00:00:01.000Z");
		expect(
			projectInterruptedMutation(active, observationSubjectDigest(before), before, 3, "2026-08-25T00:00:02.000Z"),
		).toMatchObject({
			lifecycle: "Blocked",
			observedControlRevision: 3,
			reason: "Interrupted attempt left the checkout at its last complete checkpoint",
		});
		const worker = spawn(process.execPath, [join(import.meta.dirname, "helpers", "mutation-crash-worker.ts"), fixture.root], {
			stdio: ["ignore", "pipe", "pipe"],
			env: isolatedVcsEnvironment(tmpdir()),
		});
		const exit = new Promise((resolve) => worker.once("exit", resolve));
		await new Promise<void>((resolve, reject) => {
			let output = "";
			let errors = "";
			worker.stdout.setEncoding("utf8");
			worker.stderr.setEncoding("utf8");
			worker.stdout.on("data", (chunk: string) => {
				output += chunk;
				if (output.includes("written")) resolve();
			});
			worker.stderr.on("data", (chunk: string) => (errors += chunk));
			worker.once("error", reject);
			worker.once("exit", (code) => {
				if (!output.includes("written")) reject(new Error(`Mutation worker exited ${code}: ${errors}`));
			});
		});
		worker.kill("SIGKILL");
		await exit;
		expect(await readFile(join(fixture.root, "README.md"), "utf8")).toBe("partial mutation\n");
		const current =
			repository.kind === "git"
				? await captureGitObservation(repository, policyDigest, runner)
				: await captureJjObservation(repository, policyDigest, runner);
		const projected = projectInterruptedMutation(
			active,
			observationSubjectDigest(before),
			current,
			4,
			"2026-08-25T00:00:02.000Z",
		);
		expect(projected).toMatchObject({
			lifecycle: "NeedsManualInspection",
			observedControlRevision: 4,
			reason: "Checkout differs from the last complete mutation checkpoint",
		});
	} finally {
		await fixture.cleanup();
	}
}

describe("interrupted workspace mutation", () => {
	it("leaves Git bytes for the operator and projects manual inspection", async () => crashMutation("git"), 15_000);
	const jjIt = jjAvailability.available ? it : it.skip;
	jjIt(
		`leaves Jujutsu bytes for the operator and projects manual inspection (${jjAvailability.diagnostic})`,
		async () => crashMutation("jj-native"),
		15_000,
	);
});
