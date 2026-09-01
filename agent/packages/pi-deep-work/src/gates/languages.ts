import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export type PackageLanguage = "rust" | "zig" | "python" | "typescript";

export interface PackageCommandSpec {
	id: string;
	language: PackageLanguage;
	category: "quick" | "full";
	argv: readonly [string, ...string[]];
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function unsafeScript(script: string): boolean {
	const executable = script.trim().split(/\s+/, 1)[0];
	return (
		!["tsc", "vitest", "jest", "eslint", "biome", "mocha", "ava"].includes(executable) ||
		/[;&|`$<>\\\n\r]/.test(script) ||
		/(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade)\b/i.test(script) ||
		/(?:--fix|--write|updateSnapshot|snapshot\s+-u)/i.test(script) ||
		/(?:^|\s)(?:-u|--update(?:Snapshot)?)(?=\s|$)/i.test(script)
	);
}

function packageRunner(rootFiles: Set<string>): string {
	if (rootFiles.has("pnpm-lock.yaml")) return "pnpm";
	if (rootFiles.has("yarn.lock")) return "yarn";
	if (rootFiles.has("bun.lock") || rootFiles.has("bun.lockb")) return "bun";
	return "npm";
}

function runScript(runner: string, script: string): readonly [string, ...string[]] {
	if (runner === "npm") return ["npm", "run", "--silent", script];
	return [runner, "run", script];
}

export async function packageLanguageCommands(root: string): Promise<PackageCommandSpec[]> {
	const rootNames = [
		"Cargo.toml",
		"build.zig",
		"build.zig.zon",
		"pyproject.toml",
		"setup.py",
		"uv.lock",
		"package.json",
		"tsconfig.json",
		"pnpm-lock.yaml",
		"yarn.lock",
		"bun.lock",
		"bun.lockb",
		"package-lock.json",
	];
	const rootFiles = new Set<string>();
	await Promise.all(rootNames.map(async (name) => (await exists(join(root, name))) && rootFiles.add(name)));
	const commands: PackageCommandSpec[] = [];
	if (rootFiles.has("Cargo.toml")) {
		commands.push(
			{ id: "package.rust.fmt", language: "rust", category: "quick", argv: ["cargo", "fmt", "--all", "--", "--check"] },
			{
				id: "package.rust.check",
				language: "rust",
				category: "quick",
				argv: ["cargo", "check", "--workspace", "--all-targets", "--locked"],
			},
			{
				id: "package.rust.test",
				language: "rust",
				category: "full",
				argv: ["cargo", "test", "--workspace", "--locked"],
			},
			{
				id: "package.rust.clippy",
				language: "rust",
				category: "full",
				argv: ["cargo", "clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"],
			},
		);
	}
	if (rootFiles.has("build.zig")) {
		commands.push(
			{ id: "package.zig.fmt", language: "zig", category: "quick", argv: ["zig", "fmt", "--check", "."] },
			{ id: "package.zig.test", language: "zig", category: "full", argv: ["zig", "build", "test"] },
		);
	}
	if (rootFiles.has("pyproject.toml") || rootFiles.has("setup.py")) {
		if (rootFiles.has("uv.lock")) {
			commands.push(
				{
					id: "package.python.compile",
					language: "python",
					category: "quick",
					argv: ["uv", "run", "--frozen", "--no-sync", "python", "-m", "compileall", "-q", "."],
				},
				{
					id: "package.python.test",
					language: "python",
					category: "full",
					argv: ["uv", "run", "--frozen", "--no-sync", "python", "-m", "pytest"],
				},
			);
		} else {
			commands.push(
				{
					id: "package.python.compile",
					language: "python",
					category: "quick",
					argv: ["python3", "-m", "compileall", "-q", "."],
				},
				{
					id: "package.python.test",
					language: "python",
					category: "full",
					argv: ["python3", "-m", "pytest"],
				},
			);
		}
	}
	if (rootFiles.has("package.json")) {
		let parsed: { scripts?: Record<string, unknown> } | undefined;
		try {
			parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
				scripts?: Record<string, unknown>;
			};
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
		if (!parsed) return commands;
		const runner = packageRunner(rootFiles);
		for (const [script, category] of [
			["typecheck", "quick"],
			["test", "full"],
		] as const) {
			const body = parsed.scripts?.[script];
			const before = parsed.scripts?.[`pre${script}`];
			const after = parsed.scripts?.[`post${script}`];
			if (typeof body === "string" && before === undefined && after === undefined && !unsafeScript(body)) {
				commands.push({
					id: `package.typescript.${script}`,
					language: "typescript",
					category,
					argv: runScript(runner, script),
				});
			}
		}
	}
	return commands;
}
