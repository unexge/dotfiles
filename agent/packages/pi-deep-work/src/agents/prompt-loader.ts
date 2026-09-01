import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentJobKind } from "./schemas.ts";

const defaultPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const promptParts: Readonly<Record<AgentJobKind, { role: string; skills: readonly string[] }>> = Object.freeze({
	plan: { role: "planner", skills: ["understand-code"] },
	explore: { role: "explorer", skills: ["understand-code"] },
	design: { role: "designer", skills: ["design-software"] },
	implement: { role: "implementer", skills: ["implement-small-changes"] },
	repair: { role: "implementer", skills: ["implement-small-changes"] },
	verify: { role: "verifier", skills: ["prove-behavior"] },
	adjudicate: { role: "adjudicator", skills: ["review-software"] },
	edit: { role: "editor", skills: ["technical-writing"] },
	"review-design": { role: "design-reviewer", skills: ["design-software", "review-software"] },
	"review-code": { role: "code-reviewer", skills: ["review-software"] },
});

const languageSkills = Object.freeze({
	rust: "rust-engineering",
	zig: "zig-engineering",
	python: "python-engineering",
	typescript: "typescript-engineering",
});

export type AgentLanguage = keyof typeof languageSkills;

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---\n")) return content.trim();
	const end = content.indexOf("\n---\n", 4);
	if (end < 0) throw new Error("Malformed package prompt frontmatter");
	return content.slice(end + 5).trim();
}

export class PackagePromptLoader {
	constructor(private readonly packageRoot = defaultPackageRoot) {}

	async load(kind: AgentJobKind, language?: AgentLanguage): Promise<string> {
		const parts = promptParts[kind];
		const skills = [...parts.skills];
		if (language && (kind === "implement" || kind === "repair" || kind === "review-code")) {
			skills.push(languageSkills[language]);
		}
		const role = await this.readPrompt(join(this.packageRoot, "agents", `${parts.role}.md`));
		const skillPrompts = await Promise.all(
			skills.map(async (skill) => ({
				skill,
				prompt: await this.readPrompt(join(this.packageRoot, "skills", skill, "SKILL.md")),
			})),
		);
		return [
			role,
			...skillPrompts.map(({ skill, prompt }) => `## Required package skill: ${skill}\n\n${prompt}`),
		].join("\n\n");
	}

	private async readPrompt(path: string): Promise<string> {
		const [canonicalRoot, stat, canonicalPath] = await Promise.all([
			realpath(this.packageRoot),
			lstat(path),
			realpath(path),
		]);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Package prompt is not a regular file: ${path}`);
		const rel = relative(canonicalRoot, canonicalPath);
		if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Package prompt escapes package root: ${path}`);
		const prompt = stripFrontmatter(await readFile(canonicalPath, "utf8"));
		if (!prompt) throw new Error(`Package prompt is empty: ${path}`);
		return prompt;
	}
}

const defaultLoader = new PackagePromptLoader();

export function loadAgentPrompt(kind: AgentJobKind, language?: AgentLanguage): Promise<string> {
	return defaultLoader.load(kind, language);
}
