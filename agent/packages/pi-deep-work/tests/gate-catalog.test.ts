import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy, decodeProjectPolicy } from "../src/policy/schemas.ts";
import { TrustedCommand, TrustedCommandCatalog } from "../src/gates/catalog.ts";
import { discoverProjectCapabilities } from "../src/gates/languages.ts";
import { detectRepository } from "../src/vcs/detect.ts";
import { commandRunner } from "../src/vcs/runner.ts";
import { createRepositoryFixture } from "./helpers/repositories.ts";

const temporary: string[] = [];

function policy() {
	const machine = decodeMachinePolicy({
		schemaVersion: 2,
		models: {
			orchestrator: { provider: "test", id: "gpt-5.6-sol", thinkingLevel: "max" },
			reviewers: [{ provider: "test", id: "claude-opus-4-8", thinkingLevel: "max" }],
		},
		concurrency: 2,
		maxRepairRounds: 1,
		commandTimeoutMs: 60_000,
		minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: ["node", "quick.js"], timeoutMs: 5_000 }],
		minimumFullGates: [{ id: "full", languages: ["rust"], argv: ["node", "full.js"], timeoutMs: 5_000 }],
		observations: [{ id: "rust-test", claimKeys: ["behavior.ok"], argv: ["cargo", "test", "--locked"], timeoutMs: 5_000 }],
		verificationContracts: [
			{
				id: "behavior",
				claim: "Behavior works",
				requiredClaimKeys: ["behavior.ok"],
				observationIds: ["rust-test"],
			},
		],
		selectors: [
			{
				id: "rust-test-path",
				language: "rust",
				observationId: "rust-test",
				valuePattern: "[a-zA-Z0-9_./-]+\\.rs",
			},
		],
	});
	const project = decodeProjectPolicy({
		schemaVersion: 1,
		mainline: "main",
		quickGates: [],
		fullGates: [],
		normalizers: [],
		observations: [],
		verificationContracts: [],
		selectors: [],
		languageScopes: [{ language: "rust", paths: ["crates/core"] }],
	});
	return resolvePolicy(machine, project);
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("trusted command catalog", () => {
	it("keeps argv package-minted while resolving typed selectors", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-gate-catalog-"));
		temporary.push(root);
		const resolved = policy();
		const catalog = await TrustedCommandCatalog.build(resolved, root);
		expect(() => catalog.assertPolicy(resolved)).not.toThrow();
		expect(() => catalog.assertPolicy(policy())).toThrow("another resolved policy");
		const selected = catalog.resolveSelector({ selectorId: "rust-test-path", value: "crates/core/tests/cache.rs" });
		expect(selected.command.argv).toEqual(["cargo", "test", "--locked"]);
		expect(selected.command.claimKeys).toEqual(["behavior.ok"]);
		expect(selected.value).toBe("crates/core/tests/cache.rs");
		expect(catalog.matchingSelectorsForPath("crates/core/tests/cache.rs")).toEqual([selected]);
		expect(catalog.matchingSelectorsForPath("crates/core/tests/cache.py")).toEqual([]);
		expect(catalog.selectorGuide()).toEqual([
			{
				selectorId: "rust-test-path",
				language: "rust",
				valuePattern: "[a-zA-Z0-9_./-]+\\.rs",
				scopes: ["crates/core"],
			},
		]);
		expect(JSON.stringify(catalog.selectorGuide())).not.toContain("cargo");
		expect(Object.keys(catalog.selectorGuide()[0])).not.toContain("observationId");
	});

	it("requires selectors only for fix workflows", async () => {
		const configured = policy();
		const resolved = resolvePolicy(
			decodeMachinePolicy({ ...configured.machine, selectors: [] }),
			configured.project,
		);
		const root = await mkdtemp(join(tmpdir(), "pi-deep-gate-readiness-"));
		temporary.push(root);
		const catalog = await TrustedCommandCatalog.build(resolved, root);
		expect(() => catalog.assertWriteReady("build")).not.toThrow();
		expect(() => catalog.assertWriteReady("fix")).toThrow("behavior selector");
	});

	it("runs machine gates only for languages active in the project policy", async () => {
		const base = policy();
		const project = decodeProjectPolicy({
			schemaVersion: 1,
			mainline: "main",
			quickGates: [
				{ id: "ts-check", languages: ["typescript"], argv: ["npm", "run", "check"], timeoutMs: 5_000 },
			],
			fullGates: [
				{ id: "ts-test", languages: ["typescript"], argv: ["npm", "test"], timeoutMs: 5_000 },
			],
			normalizers: [],
			observations: [
				{ id: "ts-observation", claimKeys: ["typescript.tests"], argv: ["npm", "test"], timeoutMs: 5_000 },
			],
			verificationContracts: [],
			selectors: [
				{ id: "ts-path", language: "typescript", observationId: "ts-observation", valuePattern: ".+\\.ts" },
			],
			languageScopes: [],
		});
		const resolved = resolvePolicy(base.machine, project);
		const root = await mkdtemp(join(tmpdir(), "pi-deep-gate-languages-"));
		temporary.push(root);

		const catalog = await TrustedCommandCatalog.build(resolved, root);

		expect(catalog.commandsFor("quick").map((command) => command.id)).toEqual(["ts-check"]);
		expect(catalog.commandsFor("full").map((command) => command.id)).toEqual(["ts-test"]);
	});

	it("rejects flags, wrappers, traversal, wrong languages, and paths outside trusted scopes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-gate-selectors-"));
		temporary.push(root);
		const catalog = await TrustedCommandCatalog.build(policy(), root);
		for (const value of [
			"--test.rs",
			"../test.rs",
			"crates/core/test.rs -- --nocapture",
			"crates/core/test.py",
			"crates/other/test.rs",
		]) {
			expect(() => catalog.resolveSelector({ selectorId: "rust-test-path", value })).toThrow();
		}
	});

	it("discovers non-installing package commands with locked/check flags", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			await fixture.write("Cargo.toml", "[package]\nname='x'\nversion='0.1.0'\n");
			await fixture.write(
				"package.json",
				JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest -u" } }),
			);
			const repository = await detectRepository(fixture.root, commandRunner);
			const plan = await discoverProjectCapabilities(repository, commandRunner, 5_000);
			const commands = [...plan.quickGates, ...plan.fullGates];
			const argv = commands.map((command) => command.argv.join(" "));
			expect(argv).toContain("cargo fmt --manifest-path Cargo.toml --all -- --check");
			expect(argv).toContain("cargo check --manifest-path Cargo.toml --all-targets --locked");
			expect(argv).toContain("cargo test --manifest-path Cargo.toml --locked");
			expect(argv).toContain("npm run --silent typecheck");
			expect(plan.fullGates.some((command) => command.languages.includes("typescript"))).toBe(false);
			expect(argv.some((value) => /(?:install| add | update |--fix|--write)/.test(value))).toBe(false);
		} finally {
			await fixture.cleanup();
		}
	});

	it("keeps other language capabilities when package.json is malformed", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			await fixture.write("Cargo.toml", "[package]\nname='x'\nversion='0.1.0'\n");
			await fixture.write("package.json", "{ malformed");
			const repository = await detectRepository(fixture.root, commandRunner);
			const plan = await discoverProjectCapabilities(repository, commandRunner, 5_000);
			expect(plan.quickGates.some((command) => command.id.endsWith(".check"))).toBe(true);
			expect(plan.quickGates.some((command) => command.languages.includes("typescript"))).toBe(false);
			expect(plan.warnings).toContain("Ignored malformed package.json at package.json");
			await fixture.write("package.json", "null");
			const invalid = await discoverProjectCapabilities(repository, commandRunner, 5_000);
			expect(invalid.quickGates.some((command) => command.id.endsWith(".check"))).toBe(true);
			expect(invalid.warnings).toContain("Ignored invalid package.json at package.json");
		} finally {
			await fixture.cleanup();
		}
	});

	it("rejects package scripts with pre/post lifecycle hooks", async () => {
		const fixture = await createRepositoryFixture("git");
		try {
			await fixture.write(
				"package.json",
				JSON.stringify({ scripts: { pretypecheck: "npm install", typecheck: "tsc --noEmit" } }),
			);
			const repository = await detectRepository(fixture.root, commandRunner);
			const plan = await discoverProjectCapabilities(repository, commandRunner, 5_000);
			expect(plan.quickGates.some((command) => command.languages.includes("typescript"))).toBe(false);
		} finally {
			await fixture.cleanup();
		}
	});

	it("rejects construction without the package authority token", () => {
		expect(
			() => new TrustedCommand(Symbol("fake") as never, "x", "machine", "quick", ["true"], 1_000),
		).toThrow("package catalog");
	});
});
