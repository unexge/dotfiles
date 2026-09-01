import { describe, expect, it } from "vitest";
import { AgentReportDecodeError, decodeAgentReport } from "../src/agents/schemas.ts";

const common = {
	status: "ok",
	summary: "implemented",
	citations: [],
};

describe("agent report schemas", () => {
	it("accepts typed test selectors without executable argv", () => {
		expect(
			decodeAgentReport("implement", {
				...common,
				changes: [{ path: "src/value.ts", detail: "changed value" }],
				testSelectors: [{ selectorId: "typescript.test-file", value: "tests/value.test.ts" }],
			}),
		).toMatchObject({ testSelectors: [{ selectorId: "typescript.test-file" }] });
	});

	it("accepts data-only selectors in design reports", () => {
		expect(
			decodeAgentReport("design", {
				...common,
				usage: "caller usage",
				dataShape: "data shape",
				interfaces: [],
				modules: [],
				invariants: ["invariant"],
				tradeoffs: [],
				verification: ["verification"],
				testSelectors: [{ selectorId: "rust.test", value: "tests/value.rs" }],
			}),
		).toMatchObject({ testSelectors: [{ selectorId: "rust.test" }] });
	});

	it("rejects raw argv, unknown fields, and unsafe paths", () => {
		for (const value of [
			{
				...common,
				changes: [],
				testSelectors: [],
				argv: ["sh", "-c", "evil"],
			},
			{
				...common,
				changes: [{ path: "../escape", detail: "bad" }],
				testSelectors: [],
			},
			{
				...common,
				changes: [],
				testSelectors: [{ selectorId: "test", value: "x", command: "evil" }],
			},
		]) {
			expect(() => decodeAgentReport("implement", value)).toThrow(AgentReportDecodeError);
		}
	});

	it("strictly validates review findings", () => {
		expect(() =>
			decodeAgentReport("review-code", {
				...common,
				verdict: "approve",
				findings: [],
				extra: true,
			}),
		).toThrow(AgentReportDecodeError);
	});
});
