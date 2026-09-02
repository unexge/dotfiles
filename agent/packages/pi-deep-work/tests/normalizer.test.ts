import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { NormalizationResult, Normalizer } from "../src/gates/normalizer.ts";
import { BackendTreeService, backendTreeIdentity } from "../src/gates/tree-backend.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy, decodeProjectPolicy } from "../src/policy/schemas.ts";
import { RunStore } from "../src/store/run-store.ts";
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

function policy(argv: string[], allowedChangedPaths: string[], timeoutMs = 5_000) {
	const machine = decodeMachinePolicy({
		schemaVersion: 2,
		models: {
			orchestrator: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
			reviewers: [{ provider: "test", id: "claude-opus-4-8", thinkingLevel: "max" }],
		},
		concurrency: 2,
		maxRepairRounds: 1,
		commandTimeoutMs: 10_000,
		minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
		minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["true"], timeoutMs: 1_000 }],
		observations: [],
		verificationContracts: [],
		selectors: [],
	});
	const project = decodeProjectPolicy({
		schemaVersion: 1,
		mainline: "main",
		quickGates: [],
		fullGates: [],
		normalizers: [{ id: "generate", argv, timeoutMs, allowedChangedPaths }],
		observations: [],
		verificationContracts: [],
		selectors: [],
		languageScopes: [],
	});
	return resolvePolicy(machine, project);
}

async function setup(kind: RepositoryFixtureKind, argv: string[], allowed: string[], timeoutMs = 5_000) {
	const fixture = await createRepositoryFixture(kind);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-deep-normalizer-"));
	temporary.push(agentDir);
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
	const repository = await detectRepository(fixture.root, runner);
	const resolved = policy(argv, allowed, timeoutMs);
	const store = new RunStore(agentDir);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "build" as const,
		repositoryId: repository.repositoryId,
		policyDigest: resolved.digest,
		goal: "normalize",
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
			phase: "normalize",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		"2026-08-25T00:00:01.000Z",
	);
	const trees = new BackendTreeService(authority, repository, resolved.digest, runner, join(agentDir, "scratch"));
	return { fixture, authority, trees, normalizer: new Normalizer(authority, resolved, trees) };
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixedPoint(kind: RepositoryFixtureKind): Promise<void> {
	const script =
		'const fs=require("fs"); const p="generated.txt"; if(!fs.existsSync(p)||fs.readFileSync(p,"utf8")!=="stable\\n") fs.writeFileSync(p,"stable\\n")';
	const values = await setup(kind, [process.execPath, "-e", script], ["generated.txt"]);
	try {
		const result = await values.normalizer.runExactlyTwoPasses();
		expect(result.commands).toHaveLength(2);
		expect(result.commands[0]).toMatchObject({ pass: 1, changedPaths: ["generated.txt"] });
		expect(result.commands[1]).toMatchObject({ pass: 2, changedPaths: [] });
		expect(result.fixedPointTree).toBe(backendTreeIdentity(result.passTwo));
		const candidate = await values.trees.sealCandidate({
			normalization: result,
			approvedDesignId: "c".repeat(64),
			behaviorContractId: "d".repeat(64),
		});
		expect(candidate.kind).toBe(kind === "git" ? "git" : "jj");
		await values.authority.cancel("done", "2026-08-25T00:00:03.000Z");
	} finally {
		await values.fixture.cleanup();
	}
}

describe("bounded normalizer", () => {
	it("does not expose construction of fixed-point proofs", () => {
		expect(
			() => new NormalizationResult(Symbol("fake") as never, {} as never, {} as never, {} as never, "tree", []),
		).toThrow("package authority");
	});

	it("accepts one Git change followed by an exact no-op pass", async () => fixedPoint("git"), 15_000);
	const jjIt = jjAvailability.available ? it : it.skip;
	jjIt(
		`accepts one native Jujutsu change followed by a no-op (${jjAvailability.diagnostic})`,
		async () => fixedPoint("jj-native"),
		15_000,
	);

	it("rejects undeclared changed paths", async () => {
		const values = await setup(
			"git",
			[process.execPath, "-e", 'require("fs").writeFileSync("unexpected.txt", "x")'],
			["generated.txt"],
		);
		try {
			await expect(values.normalizer.runExactlyTwoPasses()).rejects.toThrow("undeclared paths");
			await values.authority.block("normalizer rejected", "2026-08-25T00:00:03.000Z");
		} finally {
			await values.fixture.cleanup();
		}
	}, 15_000);

	it("rejects pass-two drift without a third pass", async () => {
		const script =
			'const fs=require("fs"); const p="toggle.txt"; const v=fs.existsSync(p)?fs.readFileSync(p,"utf8"):"B"; fs.writeFileSync(p,v==="A"?"B":"A")';
		const values = await setup("git", [process.execPath, "-e", script], ["toggle.txt"]);
		try {
			await expect(values.normalizer.runExactlyTwoPasses()).rejects.toThrow("pass 2");
			expect(await readFile(join(values.fixture.root, "toggle.txt"), "utf8")).toBe("B");
			await values.authority.block("normalizer did not converge", "2026-08-25T00:00:03.000Z");
		} finally {
			await values.fixture.cleanup();
		}
	}, 15_000);

	it("rejects a timed-out normalizer", async () => {
		const values = await setup("git", [process.execPath, "-e", "setInterval(() => {}, 1000)"], ["generated.txt"], 1_000);
		try {
			await expect(values.normalizer.runExactlyTwoPasses()).rejects.toThrow("timed_out");
			await values.authority.block("normalizer timed out", "2026-08-25T00:00:03.000Z");
		} finally {
			await values.fixture.cleanup();
		}
	}, 15_000);
});
