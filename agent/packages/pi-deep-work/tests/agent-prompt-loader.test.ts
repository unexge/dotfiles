import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PackagePromptLoader, loadAgentPrompt } from "../src/agents/prompt-loader.ts";

const temporary: string[] = [];

async function promptRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-prompts-"));
	temporary.push(root);
	await mkdir(join(root, "agents"), { recursive: true });
	await mkdir(join(root, "skills", "understand-code"), { recursive: true });
	await writeFile(join(root, "skills", "understand-code", "SKILL.md"), "# Understand\n\nTrace it.", "utf8");
	return root;
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("package prompt loader", () => {
	it("loads only the fixed role and skill and strips frontmatter", async () => {
		const root = await promptRoot();
		await writeFile(
			join(root, "agents", "planner.md"),
			"---\nname: planner\n---\n# Planner body\n\nPlan.",
			"utf8",
		);
		const prompt = await new PackagePromptLoader(root).load("plan");
		expect(prompt).toContain("# Planner body");
		expect(prompt).toContain("# Understand");
		expect(prompt).not.toContain("name: planner");
	});

	it("rejects symlinked and empty package resources", async () => {
		const root = await promptRoot();
		const outside = join(root, "outside.md");
		await writeFile(outside, "outside", "utf8");
		await symlink(outside, join(root, "agents", "planner.md"));
		await expect(new PackagePromptLoader(root).load("plan")).rejects.toThrow("not a regular file");
		await rm(join(root, "agents", "planner.md"));
		await writeFile(join(root, "agents", "planner.md"), "  \n", "utf8");
		await expect(new PackagePromptLoader(root).load("plan")).rejects.toThrow("empty");
	});

	it("adds language instructions only through the fixed language map", async () => {
		const prompt = await loadAgentPrompt("implement", "rust");
		expect(prompt).toContain("Required package skill: rust-engineering");
		expect(prompt).not.toContain("---\n");
	});
});
