import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { CommandRunner, DetectedRepository } from "./types.ts";
import { VcsDetectionError } from "./types.ts";

async function findMarker(start: string, marker: string): Promise<string | undefined> {
	let current: string;
	try {
		current = await realpath(start);
	} catch (error) {
		throw new VcsDetectionError(`Cannot inspect repository path ${start}: ${String(error)}`);
	}
	while (true) {
		try {
			await access(join(current, marker));
			return current;
		} catch {
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
}

function repositoryId(kind: DetectedRepository["kind"], sharedRoot: string): string {
	return createHash("sha256").update(`${kind}\0${sharedRoot}`).digest("hex");
}

async function detectJj(cwd: string, runner: CommandRunner): Promise<DetectedRepository> {
	const rootResult = await runner("jj", ["--ignore-working-copy", "workspace", "root"], { cwd });
	if (rootResult.code !== 0) {
		const reason = rootResult.errorCode === "ENOENT" ? "jj binary is not installed" : rootResult.stderr.trim();
		throw new VcsDetectionError(`Jujutsu metadata exists but the workspace probe failed: ${reason || "unknown error"}`);
	}
	const root = await realpath(rootResult.stdout.trim());
	const templateProbe = await runner(
		"jj",
		[
			"--ignore-working-copy",
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			'change_id.normal_hex() ++ "\\t" ++ commit_id ++ "\\t" ++ diff.files().map(|entry| entry.path()).join("\\0") ++ "\\n"',
		],
		{ cwd: root },
	);
	if (templateProbe.code !== 0) {
		throw new VcsDetectionError(
			`Installed jj lacks required template capabilities: ${templateProbe.stderr.trim() || "unknown error"}`,
		);
	}
	const treeProbe = await runner("jj", ["--ignore-working-copy", "debug", "tree", "-r", "@"], { cwd: root });
	if (treeProbe.code !== 0) {
		throw new VcsDetectionError(
			`Installed jj lacks required native tree capabilities: ${treeProbe.stderr.trim() || "unknown error"}`,
		);
	}
	const diffTemplateProbe = await runner(
		"jj",
		["--ignore-working-copy", "diff", "-r", "@", "-T", 'path ++ "\\0"'],
		{ cwd: root },
	);
	if (diffTemplateProbe.code !== 0) {
		throw new VcsDetectionError(
			`Installed jj lacks required diff-template capabilities: ${diffTemplateProbe.stderr.trim() || "unknown error"}`,
		);
	}
	const gitRootResult = await runner("jj", ["--ignore-working-copy", "git", "root"], { cwd: root });
	if (gitRootResult.code !== 0) {
		throw new VcsDetectionError(
			`requires a supported Git-backed Jujutsu repository; jj git root failed: ${gitRootResult.stderr.trim() || "unknown error"}`,
		);
	}
	const gitStore = await realpath(gitRootResult.stdout.trim());
	const workspaces = await runner(
		"jj",
		["--ignore-working-copy", "workspace", "list", "-T", 'name ++ "\\t" ++ root ++ "\\n"'],
		{
			cwd: root,
		},
	);
	if (workspaces.code !== 0) {
		throw new VcsDetectionError(
			`Jujutsu workspace-list probe failed; verify the installed jj supports workspace root templates: ${workspaces.stderr.trim()}`,
		);
	}
	let workspace: string[] | undefined;
	for (const line of workspaces.stdout.split("\n")) {
		const entry = line.split("\t", 2);
		if (entry.length !== 2) continue;
		try {
			if ((await realpath(entry[1])) === root) {
				workspace = entry;
				break;
			}
		} catch {
			// Ignore stale workspace-list entries and continue looking for this root.
		}
	}
	if (!workspace) throw new VcsDetectionError(`Jujutsu workspace ID not found for ${root}`);
	return {
		kind: "jj",
		root,
		sharedRoot: gitStore,
		gitStore,
		workspaceId: workspace[0],
		repositoryId: repositoryId("jj", gitStore),
	};
}

async function detectGit(cwd: string, runner: CommandRunner): Promise<DetectedRepository> {
	const rootResult = await runner("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (rootResult.code !== 0) {
		if (rootResult.errorCode === "ENOENT") throw new VcsDetectionError("git binary is not installed");
		throw new VcsDetectionError(`No Git or Jujutsu repository found from ${cwd}`, "not_repository");
	}
	const root = await realpath(rootResult.stdout.trim());
	const common = await runner("git", ["rev-parse", "--git-common-dir"], { cwd: root });
	if (common.code !== 0) throw new VcsDetectionError(`Git common-dir probe failed: ${common.stderr.trim()}`);
	const commonDir = await realpath(isAbsolute(common.stdout.trim()) ? common.stdout.trim() : join(root, common.stdout.trim()));
	return {
		kind: "git",
		root,
		sharedRoot: commonDir,
		commonDir,
		repositoryId: repositoryId("git", commonDir),
	};
}

export async function detectRepository(cwd: string, runner: CommandRunner): Promise<DetectedRepository> {
	const jjRoot = await findMarker(cwd, ".jj");
	if (jjRoot) return detectJj(jjRoot, runner);
	return detectGit(cwd, runner);
}
