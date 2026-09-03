import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
	GateSpec,
	ObservationSpec,
	ProjectPolicy,
	SelectorSpec,
	VerificationContract,
} from "../policy/schemas.ts";
import type { CommandRunner, DetectedRepository } from "../vcs/types.ts";
import { WorkspaceBoundary } from "../workspace/boundary.ts";

export type PackageLanguage = "rust" | "zig" | "python" | "typescript";

export interface DiscoveredPackageCapability {
	scope: string;
	language: PackageLanguage;
	quickGateIds: readonly string[];
	fullGateIds: readonly string[];
	observationId?: string;
	selectorId?: string;
}

export interface ProjectCapabilityPlan {
	quickGates: GateSpec[];
	fullGates: GateSpec[];
	observations: ObservationSpec[];
	verificationContracts: VerificationContract[];
	selectors: SelectorSpec[];
	languageScopes: ProjectPolicy["languageScopes"];
	packages: DiscoveredPackageCapability[];
	warnings: string[];
}

const manifestNames = new Set([
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
]);
const quickExecutables = new Set(["tsc", "eslint", "biome"]);
const testExecutables = new Set(["vitest", "jest", "mocha", "ava"]);

function directory(path: string): string {
	const value = dirname(path);
	return value === "." ? "" : value;
}

function pathInScope(scope: string, name: string): string {
	return scope ? `${scope}/${name}` : name;
}

function scopeHash(scope: string): string {
	return scope ? createHash("sha256").update(scope).digest("hex") : "root";
}

function prefix(language: PackageLanguage, scope: string): string {
	return `auto.${language}.${scopeHash(scope)}`;
}

function escapePattern(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectorPattern(language: PackageLanguage, scope: string): string {
	const base = scope ? `${escapePattern(scope)}/.+` : ".+";
	switch (language) {
		case "rust":
			return `${base}\\.rs`;
		case "zig":
			return `${base}\\.zig`;
		case "python":
			return `${base}\\.py`;
		case "typescript":
			return `${base}\\.tsx?`;
	}
}

function executable(script: string): string {
	return script.trim().split(/\s+/, 1)[0] ?? "";
}

function unsafeScript(script: string): boolean {
	return (
		/[;&|`$<>\\\n\r]/.test(script) ||
		/(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade)\b/i.test(script) ||
		/(?:--fix|--write|updateSnapshot|snapshot\s+-u)/i.test(script) ||
		/(?:^|\s)(?:-u|--update(?:Snapshot)?)(?=\s|$)/i.test(script)
	);
}

function packageRunner(filesByDirectory: ReadonlyMap<string, ReadonlySet<string>>, scope: string): string {
	let current = scope;
	while (true) {
		const names = filesByDirectory.get(current);
		if (names?.has("pnpm-lock.yaml")) return "pnpm";
		if (names?.has("yarn.lock")) return "yarn";
		if (names?.has("bun.lock") || names?.has("bun.lockb")) return "bun";
		if (names?.has("package-lock.json")) return "npm";
		if (!current) return "npm";
		current = directory(current);
	}
}

function runScript(runner: string, scope: string, script: string): readonly [string, ...string[]] {
	if (runner === "npm") {
		return scope
			? ["npm", "--prefix", scope, "run", "--silent", script]
			: ["npm", "run", "--silent", script];
	}
	const cwdFlag = runner === "pnpm" ? "--dir" : "--cwd";
	return scope ? [runner, cwdFlag, scope, "run", script] : [runner, "run", script];
}

function hasLifecycleHook(scripts: Readonly<Record<string, unknown>>, name: string): boolean {
	return scripts[`pre${name}`] !== undefined || scripts[`post${name}`] !== undefined;
}

function nearestRoots(scopes: readonly string[]): string[] {
	const sorted = [...new Set(scopes)].sort((left, right) => {
		const depth = left ? left.split("/").length : 0;
		const otherDepth = right ? right.split("/").length : 0;
		return depth - otherDepth || (left < right ? -1 : left > right ? 1 : 0);
	});
	const selected: string[] = [];
	for (const scope of sorted) {
		if (selected.some((parent) => !parent || scope.startsWith(`${parent}/`))) continue;
		selected.push(scope);
	}
	return selected;
}

function addBehavior(
	plan: ProjectCapabilityPlan,
	language: PackageLanguage,
	scope: string,
	argv: readonly [string, ...string[]],
	timeoutMs: number,
): { observationId: string; selectorId: string } {
	const id = prefix(language, scope);
	const observationId = `${id}.tests`;
	const selectorId = `${id}.test-path`;
	plan.observations.push({
		id: observationId,
		claimKeys: [`${id}.tests`],
		argv: [...argv],
		timeoutMs,
	});
	plan.selectors.push({
		id: selectorId,
		language,
		observationId,
		valuePattern: selectorPattern(language, scope),
	});
	return { observationId, selectorId };
}

function addGate(
	values: GateSpec[],
	id: string,
	language: PackageLanguage,
	argv: readonly [string, ...string[]],
	timeoutMs: number,
): string {
	values.push({ id, languages: [language], argv: [...argv], timeoutMs });
	return id;
}

function addRust(plan: ProjectCapabilityPlan, scope: string, timeoutMs: number): void {
	const id = prefix("rust", scope);
	const manifest = pathInScope(scope, "Cargo.toml");
	const quickGateIds = [
		addGate(plan.quickGates, `${id}.fmt`, "rust", ["cargo", "fmt", "--manifest-path", manifest, "--all", "--", "--check"], timeoutMs),
		addGate(plan.quickGates, `${id}.check`, "rust", ["cargo", "check", "--manifest-path", manifest, "--all-targets", "--locked"], timeoutMs),
	];
	const test = ["cargo", "test", "--manifest-path", manifest, "--locked"] as const;
	const fullGateIds = [
		addGate(plan.fullGates, `${id}.test`, "rust", test, timeoutMs),
		addGate(plan.fullGates, `${id}.clippy`, "rust", ["cargo", "clippy", "--manifest-path", manifest, "--all-targets", "--locked", "--", "-D", "warnings"], timeoutMs),
	];
	const behavior = addBehavior(plan, "rust", scope, test, timeoutMs);
	plan.packages.push({ scope, language: "rust", quickGateIds, fullGateIds, ...behavior });
}

function addZig(plan: ProjectCapabilityPlan, scope: string, timeoutMs: number): void {
	const id = prefix("zig", scope);
	const build = pathInScope(scope, "build.zig");
	const quickGateIds = [
		addGate(plan.quickGates, `${id}.fmt`, "zig", ["zig", "fmt", "--check", scope || "."], timeoutMs),
	];
	const test = ["zig", "build", "--build-file", build, "test"] as const;
	const fullGateIds = [addGate(plan.fullGates, `${id}.test`, "zig", test, timeoutMs)];
	const behavior = addBehavior(plan, "zig", scope, test, timeoutMs);
	plan.packages.push({ scope, language: "zig", quickGateIds, fullGateIds, ...behavior });
}

function addPython(
	plan: ProjectCapabilityPlan,
	scope: string,
	filesByDirectory: ReadonlyMap<string, ReadonlySet<string>>,
	timeoutMs: number,
): void {
	const id = prefix("python", scope);
	const hasUv = filesByDirectory.get(scope)?.has("uv.lock") ?? false;
	const project = scope || ".";
	const compile = hasUv
		? (["uv", "run", "--project", project, "--frozen", "--no-sync", "python", "-m", "compileall", "-q", project] as const)
		: (["python3", "-m", "compileall", "-q", project] as const);
	const test = hasUv
		? (["uv", "run", "--project", project, "--frozen", "--no-sync", "python", "-m", "pytest", project] as const)
		: (["python3", "-m", "pytest", project] as const);
	const quickGateIds = [addGate(plan.quickGates, `${id}.compile`, "python", compile, timeoutMs)];
	const fullGateIds = [addGate(plan.fullGates, `${id}.test`, "python", test, timeoutMs)];
	const behavior = addBehavior(plan, "python", scope, test, timeoutMs);
	plan.packages.push({ scope, language: "python", quickGateIds, fullGateIds, ...behavior });
}

async function addTypeScript(
	plan: ProjectCapabilityPlan,
	scope: string,
	packagePath: string,
	filesByDirectory: ReadonlyMap<string, ReadonlySet<string>>,
	timeoutMs: number,
): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(packagePath, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) {
			plan.warnings.push(`Ignored malformed package.json at ${pathInScope(scope, "package.json")}`);
			return;
		}
		throw error;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		plan.warnings.push(`Ignored invalid package.json at ${pathInScope(scope, "package.json")}`);
		return;
	}
	const scriptsValue = (parsed as Record<string, unknown>).scripts;
	if (scriptsValue !== undefined && (!scriptsValue || typeof scriptsValue !== "object" || Array.isArray(scriptsValue))) {
		plan.warnings.push(`Ignored invalid package.json at ${pathInScope(scope, "package.json")}`);
		return;
	}
	const scripts = (scriptsValue ?? {}) as Record<string, unknown>;
	const runner = packageRunner(filesByDirectory, scope);
	const id = prefix("typescript", scope);
	const quickGateIds: string[] = [];
	for (const name of ["typecheck", "check", "lint"] as const) {
		const body = scripts[name];
		if (
			typeof body !== "string" ||
			hasLifecycleHook(scripts, name) ||
			unsafeScript(body) ||
			!quickExecutables.has(executable(body))
		) {
			continue;
		}
		quickGateIds.push(addGate(plan.quickGates, `${id}.${name}`, "typescript", runScript(runner, scope, name), timeoutMs));
	}
	const testBody = scripts.test;
	let observationId: string | undefined;
	let selectorId: string | undefined;
	let testCommand: readonly [string, ...string[]] | undefined;
	const fullGateIds: string[] = [];
	if (
		typeof testBody === "string" &&
		!hasLifecycleHook(scripts, "test") &&
		!unsafeScript(testBody) &&
		testExecutables.has(executable(testBody))
	) {
		testCommand = runScript(runner, scope, "test");
		fullGateIds.push(addGate(plan.fullGates, `${id}.test`, "typescript", testCommand, timeoutMs));
		({ observationId, selectorId } = addBehavior(plan, "typescript", scope, testCommand, timeoutMs));
	}
	if (quickGateIds.length === 0 && testCommand) {
		quickGateIds.push(addGate(plan.quickGates, `${id}.test-quick`, "typescript", testCommand, timeoutMs));
	}
	if (quickGateIds.length === 0 && fullGateIds.length === 0) {
		plan.warnings.push(`No safe TypeScript check or test script was discovered at ${pathInScope(scope, "package.json")}`);
		return;
	}
	plan.packages.push({
		scope,
		language: "typescript",
		quickGateIds,
		fullGateIds,
		...(observationId ? { observationId, selectorId } : {}),
	});
}

function languageScopes(packages: readonly DiscoveredPackageCapability[]): ProjectPolicy["languageScopes"] {
	const byLanguage = new Map<PackageLanguage, Set<string>>();
	for (const value of packages) {
		if (!value.scope) {
			byLanguage.set(value.language, new Set());
			continue;
		}
		const scopes = byLanguage.get(value.language);
		if (scopes && scopes.size === 0) continue;
		const next = scopes ?? new Set<string>();
		next.add(value.scope);
		byLanguage.set(value.language, next);
	}
	return [...byLanguage]
		.filter((entry): entry is [PackageLanguage, Set<string>] => entry[1].size > 0)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([language, paths]) => ({ language, paths: [...paths].sort() }));
}

export async function discoverProjectCapabilities(
	repository: DetectedRepository,
	runner: CommandRunner,
	timeoutMs = 20 * 60 * 1000,
): Promise<ProjectCapabilityPlan> {
	const boundary = await WorkspaceBoundary.open(repository, runner);
	const files = (await boundary.searchableFiles()).filter((file) => manifestNames.has(basename(file.relative)));
	const filesByDirectory = new Map<string, Set<string>>();
	const absoluteByRelative = new Map(files.map((file) => [file.relative, file.absolute]));
	for (const file of files) {
		const scope = directory(file.relative);
		const values = filesByDirectory.get(scope) ?? new Set<string>();
		values.add(basename(file.relative));
		filesByDirectory.set(scope, values);
	}
	const plan: ProjectCapabilityPlan = {
		quickGates: [],
		fullGates: [],
		observations: [],
		verificationContracts: [],
		selectors: [],
		languageScopes: [],
		packages: [],
		warnings: [],
	};
	for (const scope of nearestRoots(
		[...filesByDirectory].filter(([, names]) => names.has("Cargo.toml")).map(([scope]) => scope),
	)) {
		addRust(plan, scope, timeoutMs);
	}
	for (const [scope, names] of [...filesByDirectory].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
		if (names.has("build.zig")) addZig(plan, scope, timeoutMs);
		if (names.has("pyproject.toml") || names.has("setup.py")) addPython(plan, scope, filesByDirectory, timeoutMs);
		if (names.has("package.json")) {
			await addTypeScript(
				plan,
				scope,
				absoluteByRelative.get(pathInScope(scope, "package.json"))!,
				filesByDirectory,
				timeoutMs,
			);
		}
	}
	plan.languageScopes = languageScopes(plan.packages);
	if (plan.observations.length > 0) {
		plan.verificationContracts.push({
			id: "auto.discovered-tests",
			claim: "discovered tests pass",
			requiredClaimKeys: plan.observations.flatMap((observation) => [...observation.claimKeys]).sort(),
			observationIds: plan.observations.map((observation) => observation.id).sort(),
		});
	}
	return plan;
}
