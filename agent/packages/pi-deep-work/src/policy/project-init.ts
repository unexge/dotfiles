import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverProjectCapabilities, type ProjectCapabilityPlan } from "../gates/languages.ts";
import { writeAtomic, writeImmutable } from "../store/atomic.ts";
import { detectRepository } from "../vcs/detect.ts";
import { commandRunner } from "../vcs/runner.ts";
import type { CommandRunner } from "../vcs/types.ts";
import { projectPolicyPath } from "./resolver.ts";
import {
	decodeProjectPolicy,
	PolicyDecodeError,
	type ProjectPolicy,
} from "./schemas.ts";

export type ProjectPolicyInitialization =
	| { status: "created"; path: string; mainline: string }
	| { status: "refreshed"; path: string; mainline: string; backupPath: string }
	| { status: "existing"; path: string; mainline: string }
	| { status: "cancelled" };

export interface ProjectPolicyInitializationOptions {
	refresh?: boolean;
	backupRoot?: string;
}

const generatedIdPrefix = "auto.";

async function readExisting(path: string): Promise<ProjectPolicy | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) {
			throw new Error(`Existing project policy contains invalid JSON and will not be overwritten: ${path}`);
		}
		throw error;
	}
	try {
		return decodeProjectPolicy(value);
	} catch (error) {
		if (error instanceof PolicyDecodeError) {
			throw new Error(`Existing project policy is invalid and will not be overwritten: ${path}`);
		}
		throw error;
	}
}

function customEntries<T extends { id: string }>(values: readonly T[]): T[] {
	return values.filter((value) => !value.id.startsWith(generatedIdPrefix));
}

function customLanguageScopes(policy: ProjectPolicy | undefined): ProjectPolicy["languageScopes"] {
	if (!policy) return [];
	return policy.languageScopes
		.map((scope) => ({
			...scope,
			paths: scope.paths.filter((path) => {
				const patternPrefix = `${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.+`;
				return !policy.selectors.some(
					(selector) =>
						selector.id.startsWith(generatedIdPrefix) &&
						selector.language === scope.language &&
						selector.valuePattern.startsWith(patternPrefix),
				);
			}),
		}))
		.filter((scope) => scope.paths.length > 0);
}

function mergeLanguageScopes(
	existing: ProjectPolicy["languageScopes"],
	discovered: ProjectPolicy["languageScopes"],
): ProjectPolicy["languageScopes"] {
	const byLanguage = new Map<ProjectPolicy["languageScopes"][number]["language"], Set<string>>();
	for (const scope of [...existing, ...discovered]) {
		const paths = byLanguage.get(scope.language) ?? new Set<string>();
		for (const path of scope.paths) paths.add(path);
		byLanguage.set(scope.language, paths);
	}
	return [...byLanguage]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([language, paths]) => ({ language, paths: [...paths].sort() }));
}

function discoverySummary(plan: ProjectCapabilityPlan): string {
	const gates = new Map([...plan.quickGates, ...plan.fullGates].map((gate) => [gate.id, gate]));
	const selectors = new Map(plan.selectors.map((selector) => [selector.id, selector]));
	const lines: string[] = [];
	for (const value of plan.packages) {
		lines.push(`${value.language} ${value.scope || "."}`);
		for (const id of value.quickGateIds) lines.push(`  quick: ${JSON.stringify(gates.get(id)!.argv)}`);
		for (const id of value.fullGateIds) lines.push(`  full: ${JSON.stringify(gates.get(id)!.argv)}`);
		if (value.selectorId) {
			lines.push(`  selector ${value.selectorId}: ${selectors.get(value.selectorId)!.valuePattern}`);
		} else {
			lines.push("  no behavior observation");
		}
	}
	if (plan.warnings.length > 0) lines.push(...plan.warnings.map((warning) => `Warning: ${warning}`));
	return lines.join("\n");
}

export async function initializeProjectPolicy(
	ctx: ExtensionCommandContext,
	runner: CommandRunner = commandRunner,
	options: ProjectPolicyInitializationOptions = {},
): Promise<ProjectPolicyInitialization> {
	if (!ctx.hasUI) throw new Error("/deep init requires interactive or RPC UI mode");
	if (!ctx.isProjectTrusted()) throw new Error("/deep init requires a trusted project");

	const repository = await detectRepository(ctx.cwd, runner);
	const path = await projectPolicyPath(repository.root);
	const existing = await readExisting(path);
	if (existing && !options.refresh) return { status: "existing", path, mainline: existing.mainline };

	let mainline = existing?.mainline;
	if (!mainline) {
		const entered = await ctx.ui.input("Mainline branch or bookmark", "main");
		if (entered === undefined) return { status: "cancelled" };
		mainline = entered.trim() || "main";
	}
	const discovered = await discoverProjectCapabilities(repository, runner);
	const summary = discoverySummary(discovered) || "No supported project checks or behavior observations were discovered.";
	if (!(await ctx.ui.confirm("Discovered project capabilities", summary))) {
		return { status: "cancelled" };
	}
	const policy = decodeProjectPolicy({
		schemaVersion: 1,
		mainline,
		quickGates: [...customEntries(existing?.quickGates ?? []), ...discovered.quickGates],
		fullGates: [...customEntries(existing?.fullGates ?? []), ...discovered.fullGates],
		normalizers: existing?.normalizers ?? [],
		observations: [...customEntries(existing?.observations ?? []), ...discovered.observations],
		verificationContracts: [
			...customEntries(existing?.verificationContracts ?? []),
			...discovered.verificationContracts,
		],
		selectors: [...customEntries(existing?.selectors ?? []), ...discovered.selectors],
		languageScopes: mergeLanguageScopes(customLanguageScopes(existing), discovered.languageScopes),
	});
	const content = `${JSON.stringify(policy, null, 2)}\n`;
	if (!existing) {
		await writeImmutable(path, content);
		return { status: "created", path, mainline: policy.mainline };
	}
	const backupRoot =
		options.backupRoot ?? join(getAgentDir(), "pi-deep-work", "policy-backups", repository.repositoryId);
	const backupPath = join(
		backupRoot,
		`${new Date().toISOString().replace(/[^0-9A-Za-z.-]/g, "-")}.json`,
	);
	await writeImmutable(backupPath, await readFile(path));
	await writeAtomic(path, content);
	return { status: "refreshed", path, mainline: policy.mainline, backupPath };
}
