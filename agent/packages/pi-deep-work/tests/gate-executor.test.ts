import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ControlAcceptedError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { TrustedCommandCatalog } from "../src/gates/catalog.ts";
import { GateExecutor } from "../src/gates/executor.ts";
import { Normalizer } from "../src/gates/normalizer.ts";
import { BackendTreeService } from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy } from "../src/policy/schemas.ts";
import { RunStore } from "../src/store/run-store.ts";
import type { ObservationSubject } from "../src/subject/types.ts";
import { captureGitObservation } from "../src/vcs/git-backend.ts";
import { captureJjObservation } from "../src/vcs/jj-backend.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import type { CommandRunner } from "../src/vcs/types.ts";
import {
	createRepositoryFixture,
	detectJjAvailability,
	isolatedVcsEnvironment,
	type RepositoryFixtureKind,
} from "./helpers/repositories.ts";

const executeFile = promisify(execFile);
const temporary: string[] = [];
const jjAvailability = await detectJjAvailability();

const runner: CommandRunner = async (command, args, options) => {
	try {
		const result = await executeFile(command, [...args], {
			cwd: options.cwd,
			env: { ...isolatedVcsEnvironment(tmpdir()), ...options.env },
			signal: options.signal,
			timeout: options.timeoutMs,
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

function resolvedPolicy(argv: string[], timeoutMs = 5_000) {
	return resolvePolicy(
		decodeMachinePolicy({
			schemaVersion: 1,
			models: {
				gpt: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
				opusReviewers: [{ provider: "test", id: "claude-opus-4.8", thinkingLevel: "max" }],
			},
			concurrency: 2,
			maxRepairRounds: 1,
			commandTimeoutMs: 10_000,
			minimumQuickGates: [{ id: "command", languages: ["rust"], argv, timeoutMs }],
			minimumFullGates: [{ id: "full", languages: ["rust"], argv: [process.execPath, "-e", "void 0"], timeoutMs: 5_000 }],
			observations: [{ id: "red-observation", claimKeys: ["red.proof"], argv, timeoutMs }],
			verificationContracts: [],
			selectors: [],
		}),
	);
}

async function fixture(kind: RepositoryFixtureKind, argv: string[], timeoutMs = 5_000) {
	const repositoryFixture = await createRepositoryFixture(kind);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-gates-"));
	temporary.push(agentDir);
	const repository = await detectRepository(repositoryFixture.root, runner);
	const policy = resolvedPolicy(argv, timeoutMs);
	const store = new RunStore(agentDir);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "verify" as const,
		repositoryId: repository.repositoryId,
		policyDigest: policy.digest,
		goal: "gate",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create(repository.kind, initial);
	const authority = await RunAuthority.start(
		{
			store,
			leases: new PortableLeaseManager(agentDir),
			ref,
			repository,
			attemptId: attemptId(randomUUID()),
			phase: "gates",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	const capture = (): Promise<ObservationSubject> =>
		repository.kind === "git"
			? captureGitObservation(repository, policy.digest, runner)
			: captureJjObservation(repository, policy.digest, runner);
	const executor = new GateExecutor(authority, store, ref, repository.kind, capture);
	const catalog = await TrustedCommandCatalog.build(policy, repository.root);
	const trees = new BackendTreeService(authority, repository, policy.digest, runner, join(agentDir, "scratch"));
	const normalizer = new Normalizer(authority, policy, trees);
	return {
		repositoryFixture,
		agentDir,
		store,
		ref,
		authority,
		executor,
		capture,
		trees,
		normalizer,
		command: catalog.gate("quick", "command"),
		redCommand: catalog.observation("red-observation"),
	};
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function cleanReceipt(kind: RepositoryFixtureKind): Promise<void> {
	const values = await fixture(
		kind,
		[process.execPath, "-e", 'process.stdout.write("full stdout"); process.stderr.write("full stderr")'],
	);
	try {
		const result = await values.executor.run(values.command);
		expect(result.record).toMatchObject({ outcome: "passed", backend: kind === "git" ? "git" : "jj", exitCode: 0 });
		expect(result.receipt).toMatchObject({ subjectDigest: result.record.subjectDigest });
		expect(await readFile(join(values.ref.directory, "artifacts", result.record.stdout.path), "utf8")).toBe("full stdout");
		expect(await readFile(join(values.ref.directory, "artifacts", result.record.stderr.path), "utf8")).toBe("full stderr");
		expect(result.receipt?.stdout.digest).toBe(result.record.stdout.digest);
		await expect(
			values.store.writeImmutableArtifact(values.ref, result.record.stdout.path, Buffer.from("substitute")),
		).rejects.toMatchObject({ code: "EEXIST" });
		await values.authority.cancel("test complete", "2026-08-25T00:00:02.000Z");
	} finally {
		await values.repositoryFixture.cleanup();
	}
}

describe("GateExecutor", () => {
	it("rejects foreign authority, store, run, and backend bindings", async () => {
		const values = await fixture("git", [process.execPath, "-e", "void 0"]);
		try {
			expect(() => values.executor.assertRun(values.authority, values.store, values.ref, "git")).not.toThrow();
			expect(() => values.executor.assertRun({} as RunAuthority, values.store, values.ref, "git")).toThrow(
				"another authority",
			);
			expect(() => values.executor.assertRun(values.authority, new RunStore(values.agentDir), values.ref, "git")).toThrow(
				"another authority",
			);
			expect(() =>
				values.executor.assertRun(values.authority, values.store, { ...values.ref, runId: randomUUID() }, "git"),
			).toThrow("another authority");
			expect(() => values.executor.assertRun(values.authority, values.store, values.ref, "jj")).toThrow(
				"another authority",
			);
			await values.authority.cancel("done", "2026-08-25T00:00:02.000Z");
		} finally {
			await values.repositoryFixture.cleanup();
		}
	});

	it("mints an immutable same-subject Git receipt", async () => cleanReceipt("git"));
	const jjIt = jjAvailability.available ? it : it.skip;
	jjIt(`mints a native Jujutsu receipt (${jjAvailability.diagnostic})`, async () => cleanReceipt("jj-native"));
	jjIt(`mints a colocated Jujutsu receipt (${jjAvailability.diagnostic})`, async () => cleanReceipt("jj-colocated"));

	it("binds write-gate receipts to the complete sealed candidate", async () => {
		const values = await fixture("git", [process.execPath, "-e", "void 0"]);
		try {
			const normalization = await values.normalizer.runExactlyTwoPasses();
			const candidate = await values.trees.sealCandidate({
				normalization,
				approvedDesignId: "b".repeat(64),
				behaviorContractId: "c".repeat(64),
			});
			const result = await values.executor.run(values.command, candidate);
			expect(result.record.subject).toEqual(candidate);
			expect(result.receipt?.subject).toEqual(candidate);
			expect(result.receipt?.subjectDigest).toMatch(/^[0-9a-f]{64}$/);
			await expect(values.executor.run(values.command, { ...candidate })).rejects.toThrow(
				"not minted by BackendTreeService",
			);
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
		} finally {
			await values.repositoryFixture.cleanup();
		}
	}, 15_000);

	it("mints no candidate receipt when the command drifts the live observation", async () => {
		const values = await fixture("git", [
			process.execPath,
			"-e",
			'require("fs").writeFileSync("README.md", "drifted\\n")',
		]);
		try {
			const normalization = await values.normalizer.runExactlyTwoPasses();
			const candidate = await values.trees.sealCandidate({
				normalization,
				approvedDesignId: "b".repeat(64),
				behaviorContractId: "c".repeat(64),
			});
			const result = await values.executor.run(values.command, candidate);
			expect(result.record.outcome).toBe("drifted");
			expect(result.record.afterObservationDigest).not.toBe(result.record.beforeObservationDigest);
			expect(result.receipt).toBeUndefined();
			await values.authority.manualInspection("gate drift", "2026-08-25T00:00:03.000Z");
		} finally {
			await values.repositoryFixture.cleanup();
		}
	}, 15_000);

	it("binds a failing red observation to a distinct regression intermediate", async () => {
		const values = await fixture("git", [process.execPath, "-e", "process.exit(1)"]);
		try {
			const baseline = await values.trees.capture();
			if (baseline.kind !== "git") throw new Error("expected Git tree");
			await values.repositoryFixture.write("regression.test", "red\n");
			const regression = await values.trees.sealRegression(baseline, values.redCommand);
			const result = await values.executor.run(values.redCommand, regression);
			expect(result.record).toMatchObject({ outcome: "failed", subject: { kind: "git-regression" } });
			expect(result.receipt).toBeUndefined();
			await expect(values.executor.run(values.command, regression)).rejects.toThrow(
				"does not match the trusted observation command",
			);
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
		} finally {
			await values.repositoryFixture.cleanup();
		}
	}, 15_000);

	it("rejects a red subject when its untracked regression file disappears after sealing", async () => {
		const values = await fixture("git", [process.execPath, "-e", "process.exit(1)"]);
		try {
			const baseline = await values.trees.capture();
			await values.repositoryFixture.write("regression.test", "red\n");
			const regression = await values.trees.sealRegression(baseline, values.redCommand);
			await unlink(join(values.repositoryFixture.root, "regression.test"));
			await expect(values.executor.run(values.redCommand, regression)).rejects.toThrow(
				"does not match the live gate observation",
			);
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
		} finally {
			await values.repositoryFixture.cleanup();
		}
	}, 15_000);

	jjIt(`binds native Jujutsu red evidence (${jjAvailability.diagnostic})`, async () => {
		const values = await fixture("jj-native", [process.execPath, "-e", "process.exit(1)"]);
		try {
			const baseline = await values.trees.capture();
			await values.repositoryFixture.write("regression.test", "red\n");
			const regression = await values.trees.sealRegression(baseline, values.redCommand);
			const result = await values.executor.run(values.redCommand, regression);
			expect(result.record).toMatchObject({ outcome: "failed", subject: { kind: "jj-regression" } });
			await values.authority.cancel("done", "2026-08-25T00:00:02.000Z");
		} finally {
			await values.repositoryFixture.cleanup();
		}
	}, 15_000);

	it("audits nonzero exit without minting a receipt", async () => {
		const values = await fixture("git", [process.execPath, "-e", "process.exit(3)"]);
		try {
			const result = await values.executor.run(values.command);
			expect(result.record).toMatchObject({ outcome: "failed", exitCode: 3 });
			expect(result.receipt).toBeUndefined();
			await values.authority.cancel("test complete", "2026-08-25T00:00:02.000Z");
		} finally {
			await values.repositoryFixture.cleanup();
		}
	});

	it("audits signal termination as incomplete without losing the record", async () => {
		const values = await fixture("git", [process.execPath, "-e", 'process.kill(process.pid, "SIGKILL")']);
		try {
			const result = await values.executor.run(values.command);
			expect(result.record).toMatchObject({
				outcome: "incomplete",
				exitCode: null,
				terminationSignal: "SIGKILL",
			});
			expect(result.record.diagnostic).toContain("SIGKILL");
			expect(result.receipt).toBeUndefined();
			await values.authority.cancel("test complete", "2026-08-25T00:00:02.000Z");
		} finally {
			await values.repositoryFixture.cleanup();
		}
	});

	it("audits tracked-file drift without minting a receipt", async () => {
		const values = await fixture("git", [
			process.execPath,
			"-e",
			'require("fs").writeFileSync("README.md", "gate mutation\\n")',
		]);
		try {
			const result = await values.executor.run(values.command);
			expect(result.record.outcome).toBe("drifted");
			expect(result.record.afterObservationDigest).not.toBe(result.record.beforeObservationDigest);
			expect(result.receipt).toBeUndefined();
			await values.authority.manualInspection("gate changed checkout", "2026-08-25T00:00:02.000Z");
		} finally {
			await values.repositoryFixture.cleanup();
		}
	});

	it("audits incomplete output without minting a receipt", async () => {
		const values = await fixture("git", [
			process.execPath,
			"-e",
			"process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 120))",
		]);
		try {
			const result = await values.executor.run(values.command);
			expect(result.record).toMatchObject({ outcome: "output_overflow", stdout: { complete: false } });
			expect(result.receipt).toBeUndefined();
			await values.authority.cancel("test complete", "2026-08-25T00:00:03.000Z");
		} finally {
			await values.repositoryFixture.cleanup();
		}
	});

	it("classifies timeout with concurrent subject drift as drifted before timed out", async () => {
		const values = await fixture(
			"git",
			[
				process.execPath,
				"-e",
				'require("fs").writeFileSync("README.md", "timeout drift\\n"); setInterval(() => {}, 1000)',
			],
			1_000,
		);
		try {
			const result = await values.executor.run(values.command);
			expect(result.record).toMatchObject({ outcome: "drifted", exitCode: null });
			expect(result.receipt).toBeUndefined();
			await values.authority.manualInspection("timeout drift", "2026-08-25T00:00:03.000Z");
		} finally {
			await values.repositoryFixture.cleanup();
		}
	}, 15_000);

	it("audits timeout without minting a receipt", async () => {
		const values = await fixture(
			"git",
			[process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
			1_000,
		);
		try {
			const result = await values.executor.run(values.command);
			expect(result.record.outcome).toBe("timed_out");
			expect(result.receipt).toBeUndefined();
			await values.authority.cancel("test complete", "2026-08-25T00:00:03.000Z");
		} finally {
			await values.repositoryFixture.cleanup();
		}
	});

	it("never publishes a receipt when record or receipt persistence crashes", async () => {
		for (const failAt of [3, 4]) {
			const values = await fixture("git", [process.execPath, "-e", "void 0"]);
			try {
				const original = values.store.writeImmutableArtifact.bind(values.store);
				let writes = 0;
				values.store.writeImmutableArtifact = async (...args) => {
					if (++writes === failAt) throw new Error(`injected artifact crash ${failAt}`);
					return original(...args);
				};
				await expect(values.executor.run(values.command)).rejects.toThrow(`injected artifact crash ${failAt}`);
				const files = await readdir(join(values.ref.directory, "artifacts"), { recursive: true });
				expect(files.some((path) => path.startsWith("receipts/"))).toBe(false);
				expect(files.some((path) => path.endsWith("record.json"))).toBe(failAt === 4);
				expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Failed" });
			} finally {
				await values.repositoryFixture.cleanup();
			}
		}
	}, 15_000);

	it("preserves pause classification and persists only a cancelled audit record", async () => {
		const values = await fixture("git", [process.execPath, "-e", "setInterval(() => {}, 1000)"], 10_000);
		try {
			const running = values.executor.run(values.command);
			const rejected = expect(running).rejects.toBeInstanceOf(ControlAcceptedError);
			await new Promise((resolve) => setTimeout(resolve, 150));
			await values.authority.requestControl("Pause", "2026-08-25T00:00:02.000Z");
			await rejected;
			expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Paused" });
			const files = await readdir(join(values.ref.directory, "artifacts"), { recursive: true });
			const recordPath = files.find((path) => path.endsWith("record.json"));
			expect(recordPath).toBeTruthy();
			const record = JSON.parse(await readFile(join(values.ref.directory, "artifacts", recordPath!), "utf8"));
			expect(record.outcome).toBe("cancelled");
			expect(files.some((path) => path.startsWith("receipts/"))).toBe(false);
		} finally {
			await values.repositoryFixture.cleanup();
		}
	});
});
