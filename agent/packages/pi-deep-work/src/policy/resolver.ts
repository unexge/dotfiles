import { realpath, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolvePolicy, type ResolvedPolicy } from "./catalog.ts";
import { decodeMachinePolicy, decodeProjectPolicy } from "./schemas.ts";

export interface PolicyPaths {
	machine: string;
	canonicalRoot: string;
}

async function readJson(path: string, required: boolean): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return undefined;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`machine policy is missing: ${path}. Run /deep config after cutover.`);
		}
		if (error instanceof SyntaxError) throw new Error(`Invalid JSON in policy ${path}: ${error.message}`);
		throw error;
	}
}

function assertContained(root: string, path: string): void {
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`Project policy escapes canonical repository root: ${path}`);
	}
}

export async function projectPolicyPath(root: string): Promise<string> {
	const expected = join(root, CONFIG_DIR_NAME, "pi-deep-work.json");
	try {
		const canonical = await realpath(expected);
		assertContained(root, canonical);
		return canonical;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			const canonicalParent = await realpath(dirname(expected));
			assertContained(root, canonicalParent);
			return join(canonicalParent, basename(expected));
		} catch (parentError) {
			if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
			return expected;
		}
	}
}

export async function loadResolvedPolicy(
	ctx: Pick<ExtensionContext, "isProjectTrusted">,
	paths: PolicyPaths,
): Promise<ResolvedPolicy> {
	const canonicalRoot = await realpath(paths.canonicalRoot);
	const machine = decodeMachinePolicy(await readJson(paths.machine, true));
	const projectPath = await projectPolicyPath(canonicalRoot);
	const projectValue = ctx.isProjectTrusted() ? await readJson(projectPath, false) : undefined;
	const project = projectValue === undefined ? undefined : decodeProjectPolicy(projectValue);
	return resolvePolicy(machine, project);
}
