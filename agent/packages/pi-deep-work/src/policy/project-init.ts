import { readFile } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeImmutable } from "../store/atomic.ts";
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
	| { status: "existing"; path: string; mainline: string }
	| { status: "cancelled" };

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

export async function initializeProjectPolicy(
	ctx: ExtensionCommandContext,
	runner: CommandRunner = commandRunner,
): Promise<ProjectPolicyInitialization> {
	if (!ctx.hasUI) throw new Error("/deep init requires interactive or RPC UI mode");
	if (!ctx.isProjectTrusted()) throw new Error("/deep init requires a trusted project");

	const repository = await detectRepository(ctx.cwd, runner);
	const path = await projectPolicyPath(repository.root);
	const existing = await readExisting(path);
	if (existing) return { status: "existing", path, mainline: existing.mainline };

	const entered = await ctx.ui.input("Mainline branch or bookmark", "main");
	if (entered === undefined) return { status: "cancelled" };
	const policy = decodeProjectPolicy({
		schemaVersion: 1,
		mainline: entered.trim() || "main",
		quickGates: [],
		fullGates: [],
		normalizers: [],
		observations: [],
		verificationContracts: [],
		selectors: [],
		languageScopes: [],
	});
	await writeImmutable(path, `${JSON.stringify(policy, null, 2)}\n`);
	return { status: "created", path, mainline: policy.mainline };
}
