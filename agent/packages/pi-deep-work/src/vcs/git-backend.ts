import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { GitObservationSubject } from "../subject/types.ts";
import { changedPathsDigest, combineDigests, digestPaths, nulFields } from "../subject/content.ts";
import type { GitRepository, CommandRunner, RepositoryStatus } from "./types.ts";

interface IndexEntry {
	mode: string;
	oid: string;
	stage: number;
	path: string;
}

interface GitState {
	entriesRaw: string;
	indexTree?: string;
	conflicts: string[];
	tracked: string[];
	untracked: string[];
}

async function required(
	runner: CommandRunner,
	repository: GitRepository,
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	const result = await runner("git", args, { cwd: repository.root, signal });
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout;
}

function parseIndexEntries(value: string): IndexEntry[] {
	return nulFields(value).map((entry) => {
		const separator = entry.indexOf("\t");
		if (separator < 0) throw new Error("Git index entry is malformed");
		const [mode, oid, stageText] = entry.slice(0, separator).split(" ");
		const stage = Number(stageText);
		if (!mode || !oid || !Number.isInteger(stage)) throw new Error("Git index entry is malformed");
		return { mode, oid, stage, path: entry.slice(separator + 1) };
	});
}

function blobOid(algorithm: "sha1" | "sha256", content: Buffer): string {
	return createHash(algorithm)
		.update(`blob ${content.length}\0`)
		.update(content)
		.digest("hex");
}

async function worktreeEntryChanged(
	repository: GitRepository,
	entry: IndexEntry,
	algorithm: "sha1" | "sha256",
	runner: CommandRunner,
	signal?: AbortSignal,
): Promise<boolean> {
	const absolute = join(repository.root, entry.path);
	let metadata: Awaited<ReturnType<typeof lstat>>;
	try {
		metadata = await lstat(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
	if (entry.mode === "160000") {
		if (!metadata.isDirectory()) return true;
		const result = await runner("git", ["-C", entry.path, "rev-parse", "HEAD"], { cwd: repository.root, signal });
		return result.code !== 0 || result.stdout.trim() !== entry.oid;
	}
	let content: Buffer;
	let mode: string;
	if (metadata.isSymbolicLink()) {
		content = await readlink(absolute, { encoding: "buffer" });
		mode = "120000";
	} else if (metadata.isFile()) {
		content = await readFile(absolute);
		// Git records one executable bit derived from the owner's execute permission.
		mode = metadata.mode & 0o100 ? "100755" : "100644";
	} else {
		return true;
	}
	return mode !== entry.mode || blobOid(algorithm, content) !== entry.oid;
}

async function repositoryState(
	repository: GitRepository,
	runner: CommandRunner,
	signal?: AbortSignal,
): Promise<GitState> {
	const entriesRaw = await required(runner, repository, ["ls-files", "--stage", "-z"], signal);
	const entries = parseIndexEntries(entriesRaw);
	const conflicts = [...new Set(entries.filter((entry) => entry.stage !== 0).map((entry) => entry.path))].sort();
	const stageZero = entries.filter((entry) => entry.stage === 0);
	const untracked = nulFields(
		await required(runner, repository, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
	).sort();
	if (conflicts.length > 0) {
		return {
			entriesRaw,
			conflicts,
			tracked: [...new Set([...conflicts, ...stageZero.map((entry) => entry.path)])].sort(),
			untracked,
		};
	}
	const indexTree = (await required(runner, repository, ["write-tree"], signal)).trim();
	const staged = nulFields(
		await required(
			runner,
			repository,
			["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", "HEAD", indexTree, "--"],
			signal,
		),
	);
	const format = (await required(runner, repository, ["rev-parse", "--show-object-format"], signal)).trim();
	if (format !== "sha1" && format !== "sha256") throw new Error(`Unsupported Git object format: ${format}`);
	const unstaged: string[] = [];
	for (const entry of stageZero) {
		if (await worktreeEntryChanged(repository, entry, format, runner, signal)) unstaged.push(entry.path);
	}
	return {
		entriesRaw,
		indexTree,
		conflicts,
		tracked: [...new Set([...staged, ...unstaged])].sort(),
		untracked,
	};
}

export async function gitStatus(
	repository: GitRepository,
	runner: CommandRunner,
	signal?: AbortSignal,
): Promise<RepositoryStatus> {
	const state = await repositoryState(repository, runner, signal);
	const all = [...new Set([...state.tracked, ...state.untracked])].sort();
	return { clean: all.length === 0, conflicted: state.conflicts.length > 0, changedPaths: all };
}

export async function captureGitObservation(
	repository: GitRepository,
	policyDigest: string,
	runner: CommandRunner,
	signal?: AbortSignal,
): Promise<GitObservationSubject> {
	const headOid = (await required(runner, repository, ["rev-parse", "HEAD"], signal)).trim();
	const symbolic = await runner("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: repository.root, signal });
	const symbolicRef = symbolic.code === 0 ? symbolic.stdout.trim() : "DETACHED";
	const state = await repositoryState(repository, runner, signal);
	const all = [...new Set([...state.tracked, ...state.untracked])].sort();
	const common = {
		schemaVersion: 1 as const,
		kind: "git" as const,
		repositoryId: repository.repositoryId,
		root: await realpath(repository.root),
		policyDigest,
		workingDigest: await digestPaths(repository.root, all),
		changedPathsDigest: changedPathsDigest(all),
		headOid,
		symbolicRef,
	};
	if (state.conflicts.length > 0) {
		return { ...common, conflicted: true, indexEntriesDigest: combineDigests([state.entriesRaw]) };
	}
	return { ...common, conflicted: false, indexTree: state.indexTree! };
}

export async function resolveGitRevision(
	repository: GitRepository,
	revision: string,
	runner: CommandRunner,
	signal?: AbortSignal,
): Promise<string> {
	if (!revision || revision.startsWith("-")) throw new Error(`Invalid Git revision selector: ${revision}`);
	return (await required(runner, repository, ["rev-parse", "--verify", `${revision}^{commit}`], signal)).trim();
}
