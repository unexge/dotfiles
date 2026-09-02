import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { decodeMachinePolicy, decodeProjectPolicy } from "../src/policy/schemas.ts";
import { TrustedCommand, TrustedCommandCatalog } from "../src/gates/catalog.ts";

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

	it("emits non-installing package commands with locked/check flags", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-language-plans-"));
		temporary.push(root);
		await writeFile(join(root, "Cargo.toml"), "[package]\nname='x'\nversion='0.1.0'\n", "utf8");
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest -u" } }),
			"utf8",
		);
		const catalog = await TrustedCommandCatalog.build(policy(), root);
		const commands = [...catalog.packageCommands("quick"), ...catalog.packageCommands("full")];
		const argv = commands.map((command) => command.argv.join(" "));
		expect(argv).toContain("cargo fmt --all -- --check");
		expect(argv).toContain("cargo check --workspace --all-targets --locked");
		expect(argv).toContain("cargo test --workspace --locked");
		expect(argv).toContain("npm run --silent typecheck");
		expect(commands.map((command) => command.id)).not.toContain("package.typescript.test");
		expect(argv.some((value) => /(?:install| add | update |--fix|--write)/.test(value))).toBe(false);
	});

	it("keeps other language commands when package.json is malformed", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-malformed-package-"));
		temporary.push(root);
		await writeFile(join(root, "Cargo.toml"), "[package]\nname='x'\nversion='0.1.0'\n", "utf8");
		await writeFile(join(root, "package.json"), "{ malformed", "utf8");
		const catalog = await TrustedCommandCatalog.build(policy(), root);
		expect(catalog.packageCommands("quick").map((command) => command.id)).toContain("package.rust.check");
		expect(catalog.packageCommands("quick").some((command) => command.id.startsWith("package.typescript"))).toBe(false);
	});

	it("rejects package scripts with pre/post lifecycle hooks", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-deep-language-hooks-"));
		temporary.push(root);
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ scripts: { pretypecheck: "npm install", typecheck: "tsc --noEmit" } }),
			"utf8",
		);
		const catalog = await TrustedCommandCatalog.build(policy(), root);
		expect(catalog.packageCommands("quick").map((command) => command.id)).not.toContain("package.typescript.typecheck");
	});

	it("rejects construction without the package authority token", () => {
		expect(
			() => new TrustedCommand(Symbol("fake") as never, "x", "machine", "quick", ["true"], 1_000),
		).toThrow("package catalog");
	});
});
