import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("evaluation fixtures", () => {
	it("covers every workflow and the control boundary with substantive assertions", async () => {
		const values = JSON.parse(await readFile(join(root, "evals/workflow-output.json"), "utf8")) as Array<{
			command?: unknown;
			assertions?: unknown;
		}>;
		expect(values.map((value) => value.command).sort()).toEqual(
			["build", "controls", "design", "fix", "how", "review", "unslop", "verify"],
		);
		for (const value of values) {
			expect(Array.isArray(value.assertions)).toBe(true);
			expect((value.assertions as unknown[]).length).toBeGreaterThanOrEqual(3);
			expect((value.assertions as unknown[]).every((item) => typeof item === "string" && item.length > 20)).toBe(true);
		}
	});

	it("maps every trigger fixture to one bundled skill", async () => {
		const values = JSON.parse(await readFile(join(root, "evals/skill-triggers.json"), "utf8")) as Array<{
			prompt?: unknown;
			expectedSkill?: unknown;
		}>;
		for (const value of values) {
			expect(typeof value.prompt).toBe("string");
			expect(typeof value.expectedSkill).toBe("string");
			expect(await readFile(join(root, "skills", value.expectedSkill as string, "SKILL.md"), "utf8")).toContain(
				`name: ${value.expectedSkill}`,
			);
		}
	});
});
