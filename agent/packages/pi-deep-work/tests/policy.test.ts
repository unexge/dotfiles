import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson } from "../src/policy/canonical-json.ts";
import { resolvePolicy } from "../src/policy/catalog.ts";
import { normalizeClaim } from "../src/policy/normalize-claim.ts";
import {
	PolicyDecodeError,
	decodeMachinePolicy,
	decodeProjectPolicy,
} from "../src/policy/schemas.ts";
import { resolveSelector } from "../src/policy/selectors.ts";

const gate = (id: string) => ({ id, languages: ["rust"] as const, argv: ["cargo", "test", "--locked"], timeoutMs: 60_000 });
const observation = (id: string, claimKeys = ["cache.safe"]) => ({
	id,
	claimKeys,
	argv: ["cargo", "test", "--locked", id],
	timeoutMs: 60_000,
});

function machine() {
	return decodeMachinePolicy({
		schemaVersion: 2,
		models: {
			orchestrator: { provider: "bedrock", id: "gpt-5.6-sol", thinkingLevel: "max" },
			worker: { provider: "bedrock", id: "gpt-5.6-sol", thinkingLevel: "high" },
			reviewers: [{ provider: "bedrock", id: "claude-opus-4-8", thinkingLevel: "xhigh" }],
		},
		concurrency: 4,
		maxRepairRounds: 2,
		commandTimeoutMs: 600_000,
		minimumQuickGates: [gate("machine-quick")],
		minimumFullGates: [gate("machine-full")],
		observations: [observation("cache-test")],
		verificationContracts: [
			{
				id: "cache-contract",
				claim: "Cache is safe after shutdown",
				requiredClaimKeys: ["cache.safe"],
				observationIds: ["cache-test"],
			},
		],
		selectors: [
			{
				id: "rust-test-filter",
				language: "rust",
				observationId: "cache-test",
				valuePattern: "^[a-zA-Z0-9_:]+$",
			},
		],
	});
}

function project() {
	return decodeProjectPolicy({
		schemaVersion: 1,
		mainline: "main",
		quickGates: [gate("project-quick")],
		fullGates: [],
		normalizers: [
			{
				id: "lockfile",
				argv: ["cargo", "generate-lockfile"],
				timeoutMs: 60_000,
				allowedChangedPaths: ["Cargo.lock"],
			},
		],
		observations: [],
		verificationContracts: [],
		selectors: [],
		languageScopes: [{ language: "rust", paths: ["crates/core"] }],
	});
}

describe("canonical policy", () => {
	it("canonicalizes object keys while preserving array order", () => {
		expect(canonicalJson({ b: 2, a: { d: 4, c: 3 }, list: [2, 1] })).toBe(
			'{"a":{"c":3,"d":4},"b":2,"list":[2,1]}',
		);
		expect(canonicalDigest({ a: 1, b: 2 })).toBe(canonicalDigest({ b: 2, a: 1 }));
		expect(canonicalJson({ ä: 1, z: 2, A: 3, a: 4 })).toBe('{"A":3,"a":4,"z":2,"ä":1}');
		expect(canonicalJson({ "2": "two", "10": "ten", a: "letter" })).toBe(
			'{"10":"ten","2":"two","a":"letter"}',
		);
	});

	it("normalizes only ASCII whitespace and preserves case and Unicode form", () => {
		expect(normalizeClaim(" \tCache\n is\r safe ")).toBe("Cache is safe");
		expect(normalizeClaim("CACHE")).not.toBe(normalizeClaim("cache"));
		expect(normalizeClaim("é")).not.toBe(normalizeClaim("é"));
		expect(() => normalizeClaim("bad\0claim")).toThrow("NUL");
		expect(() => normalizeClaim(42)).toThrow("must be a string");
	});

	it("merges additive project authority without weakening machine policy", () => {
		const resolved = resolvePolicy(machine(), project());
		expect(resolved.quickGates.map((entry) => entry.id)).toEqual(["machine-quick", "project-quick"]);
		expect(resolved.fullGates.map((entry) => entry.id)).toEqual(["machine-full"]);
		expect(resolved.machine.models.orchestrator.thinkingLevel).toBe("max");
		expect(resolved.machine.models.worker?.thinkingLevel).toBe("high");
		expect(resolved.mainline).toBe("main");
		expect(resolved.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(resolved.normalizedClaims.get("Cache is safe after shutdown")?.id).toBe("cache-contract");
		expect(Object.isFrozen(resolved)).toBe(true);
		expect(Object.isFrozen(resolved.machine)).toBe(true);
		expect(Object.isFrozen(resolved.quickGates)).toBe(true);
		expect(Object.isFrozen(resolved.normalizedClaims)).toBe(true);
		expect(() =>
			(resolved.normalizedClaims as unknown as Map<string, unknown>).set("tampered", {}),
		).toThrow(TypeError);
		expect(() =>
			(resolved.selectorPatterns as unknown as Map<string, unknown>).delete("rust-test-filter"),
		).toThrow(TypeError);
		const originalProvider = resolved.machine.models.orchestrator.provider;
		const source = machine();
		const cloned = resolvePolicy(source);
		source.models.orchestrator.provider = "mutated-after-resolution";
		expect(cloned.machine.models.orchestrator.provider).toBe(originalProvider);
	});
});

describe("strict policy validation", () => {
	it("rejects unknown project authority such as model overrides", () => {
		expect(() =>
			decodeProjectPolicy({
				...project(),
				models: { orchestrator: { provider: "other", id: "other", thinkingLevel: "max" } },
			}),
		).toThrow(PolicyDecodeError);
	});

	it("accepts configurable thinking levels and rejects invalid levels or unknown keys", () => {
		expect(() =>
			decodeMachinePolicy({
				...machine(),
				models: {
					...machine().models,
					orchestrator: { provider: "bedrock", id: "other-model", thinkingLevel: "xhigh" },
				},
			}),
		).not.toThrow();
		expect(() =>
			decodeMachinePolicy({
				...machine(),
				models: {
					...machine().models,
					orchestrator: { provider: "bedrock", id: "other-model", thinkingLevel: "extreme" },
				},
			}),
		).toThrow(PolicyDecodeError);
		expect(() => decodeMachinePolicy({ ...machine(), unknown: true })).toThrow(PolicyDecodeError);
	});

	it("rejects duplicate normalized claims, unknown observations, and incomplete coverage", () => {
		const duplicate = machine();
		duplicate.verificationContracts.push({
			id: "duplicate",
			claim: "  Cache   is safe after shutdown ",
			requiredClaimKeys: ["cache.safe"],
			observationIds: ["cache-test"],
		});
		expect(() => resolvePolicy(duplicate)).toThrow("Duplicate normalized verification claim");

		const unknown = machine();
		unknown.verificationContracts[0].observationIds = ["missing"];
		expect(() => resolvePolicy(unknown)).toThrow("unknown observation");

		const incomplete = machine();
		incomplete.verificationContracts[0].requiredClaimKeys = ["cache.safe", "cache.persisted"];
		expect(() => resolvePolicy(incomplete)).toThrow("lacks observation coverage");
	});

	it("rejects invalid paths, refs, regexes, and timeout escalation", () => {
		for (const invalidPath of ["/etc/passwd", "../escape", "src/../../escape", "line\nbreak", "windows\\path"]) {
			expect(() =>
				decodeProjectPolicy({
					...project(),
					normalizers: [
						{ id: "bad", argv: ["tool"], timeoutMs: 60_000, allowedChangedPaths: [invalidPath] },
					],
				}),
			).toThrow(PolicyDecodeError);
		}
		expect(() => decodeProjectPolicy({ ...project(), mainline: "bad..ref" })).toThrow(PolicyDecodeError);

		const invalidRegex = machine();
		invalidRegex.selectors[0].valuePattern = "(";
		expect(() => resolvePolicy(invalidRegex)).toThrow("invalid valuePattern");
		const unsafeRegex = machine();
		unsafeRegex.selectors[0].valuePattern = "(a+)+";
		expect(() => resolvePolicy(unsafeRegex)).toThrow("unsafe valuePattern");
		const longTimeout = machine();
		longTimeout.minimumQuickGates[0].timeoutMs = longTimeout.commandTimeoutMs + 1;
		expect(() => resolvePolicy(longTimeout)).toThrow("timeout exceeds");
	});

	it("rejects duplicate IDs and selector injection", () => {
		const duplicate = machine();
		duplicate.observations.push(observation("cache-test"));
		expect(() => resolvePolicy(duplicate)).toThrow("Duplicate observation ID");

		const crossAuthorityDuplicate = project();
		crossAuthorityDuplicate.observations.push(observation("cache-test"));
		expect(() => resolvePolicy(machine(), crossAuthorityDuplicate)).toThrow("Duplicate observation ID");

		const resolved = resolvePolicy(machine());
		expect(resolveSelector(resolved, { selectorId: "rust-test-filter", value: "cache::test" })).toMatchObject({
			observationId: "cache-test",
		});
		expect(() => resolveSelector(resolved, { selectorId: "rust-test-filter", value: "x; rm -rf /" })).toThrow(
			"rejected value",
		);
		const unanchored = machine();
		unanchored.selectors[0].valuePattern = "[a-z]+";
		const anchoredPolicy = resolvePolicy(unanchored);
		expect(() => resolveSelector(anchoredPolicy, { selectorId: "rust-test-filter", value: "x; rm" })).toThrow(
			"rejected value",
		);
		expect(() => resolveSelector(resolved, { selectorId: "missing", value: "test" })).toThrow("Unknown selector");
		expect(() => resolveSelector(resolved, { selectorId: "rust-test-filter", value: "test", argv: ["rm"] })).toThrow(
			PolicyDecodeError,
		);
	});
});
