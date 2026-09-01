import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandRunner, DetectedRepository } from "../vcs/types.ts";

export interface WorkspacePath {
	relative: string;
	absolute: string;
}

export class WorkspaceBoundaryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceBoundaryError";
	}
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
	);
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function validateRelativePath(input: string): string {
	if (!input || Buffer.byteLength(input) > 1024) throw new WorkspaceBoundaryError("Workspace path must be 1 to 1024 bytes");
	if (isAbsolute(input) || input.includes("\\") || /[\0\n\r]/.test(input)) {
		throw new WorkspaceBoundaryError(`Workspace path must be repository-relative: ${JSON.stringify(input)}`);
	}
	const segments = input.split("/").map((segment) => segment.normalize("NFC"));
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new WorkspaceBoundaryError(`Workspace path contains an unsafe segment: ${JSON.stringify(input)}`);
	}
	const lower = segments.map((segment) => segment.toLowerCase());
	if (lower.includes(".git") || lower.includes(".jj")) {
		throw new WorkspaceBoundaryError(`VCS metadata is outside the delegated workspace: ${input}`);
	}
	if (
		(lower[0] === ".pi" && (lower[1] === "pi-deep-work" || lower[1] === "deep-work")) ||
		lower[0] === ".deep-work"
	) {
		throw new WorkspaceBoundaryError(`Deep-work artifacts are outside the delegated workspace: ${input}`);
	}
	return segments.join("/");
}

export class WorkspaceBoundary {
	readonly root: string;
	private readonly repository: DetectedRepository;
	private readonly runner: CommandRunner;

	private constructor(root: string, repository: DetectedRepository, runner: CommandRunner) {
		this.root = root;
		this.repository = repository;
		this.runner = runner;
	}

	static async open(repository: DetectedRepository, runner: CommandRunner): Promise<WorkspaceBoundary> {
		const root = await realpath(repository.root);
		return new WorkspaceBoundary(root, repository, runner);
	}

	queuePath(input: string): WorkspacePath {
		const relativePath = validateRelativePath(input);
		const absolute = resolve(this.root, relativePath);
		if (!isInside(this.root, absolute) || absolute === this.root) {
			throw new WorkspaceBoundaryError(`Workspace path escapes repository root: ${input}`);
		}
		return { relative: relativePath, absolute };
	}

	mutationQueueKey(input: string): string {
		// One lock identity across case-sensitive, case-insensitive, NFC, and NFD filesystems is safer than platform-specific alias races.
		return this.queuePath(input).absolute.normalize("NFC").toLowerCase();
	}

	async admit(input: string): Promise<WorkspacePath> {
		const path = await this.rejectSymlinks(this.queuePath(input));
		if (await this.isIgnored(path.relative)) throw new WorkspaceBoundaryError(`Workspace path is ignored: ${path.relative}`);
		return path;
	}

	async searchableFiles(scope?: string): Promise<WorkspacePath[]> {
		const admittedScope = scope ? await this.admit(scope) : undefined;
		const pathspec = admittedScope ? `:(literal)${admittedScope.relative}` : ".";
		let names: string[];
		if (this.repository.kind === "git") {
			const listed = await this.runner(
				"git",
				["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", pathspec],
				{ cwd: this.root },
			);
			if (listed.code !== 0) throw new WorkspaceBoundaryError(`git ls-files failed: ${listed.stderr.trim()}`);
			names = listed.stdout.split("\0").filter(Boolean);
		} else {
			const fileset = admittedScope ? `root:${JSON.stringify(admittedScope.relative)}` : "all()";
			const tracked = await this.runner(
				"jj",
				["--ignore-working-copy", "file", "list", "-r", "@", "-T", 'path ++ "\\0"', fileset],
				{ cwd: this.root },
			);
			if (tracked.code !== 0) throw new WorkspaceBoundaryError(`jj file list failed: ${tracked.stderr.trim()}`);
			const untracked = await this.runner(
				"git",
				[
					`--git-dir=${this.repository.gitStore}`,
					`--work-tree=${this.root}`,
					"ls-files",
					"--others",
					"--exclude-standard",
					"-z",
					"--",
					pathspec,
					":(exclude,literal).jj",
					":(exclude,literal).git",
					":(exclude,literal).pi/pi-deep-work",
					":(exclude,literal).pi/deep-work",
					":(exclude,literal).deep-work",
				],
				{ cwd: this.root },
			);
			if (untracked.code !== 0) {
				throw new WorkspaceBoundaryError(`Jujutsu untracked-file listing failed: ${untracked.stderr.trim()}`);
			}
			names = [...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean);
		}
		const unique = [...new Set(names)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
		if (unique.length > 2000) throw new WorkspaceBoundaryError("Workspace search exceeds 2000 files; narrow the path");
		const paths: WorkspacePath[] = [];
		for (const name of unique) {
			try {
				paths.push(await this.rejectSymlinks(this.queuePath(name)));
			} catch (error) {
				if (!(error instanceof WorkspaceBoundaryError)) throw error;
			}
		}
		return paths;
	}

	private async rejectSymlinks(path: WorkspacePath): Promise<WorkspacePath> {
		let current = this.root;
		const segments = path.relative.split("/");
		for (let index = 0; index < segments.length; index++) {
			current = join(current, segments[index]);
			try {
				const stat = await lstat(current);
				if (stat.isSymbolicLink()) throw new WorkspaceBoundaryError(`Workspace path contains a symlink: ${path.relative}`);
				if (index < segments.length - 1 && !stat.isDirectory()) {
					throw new WorkspaceBoundaryError(`Workspace path traverses a non-directory: ${path.relative}`);
				}
			} catch (error) {
				if (isMissing(error)) break;
				throw error;
			}
		}
		let ancestor = path.absolute;
		while (true) {
			try {
				const canonical = await realpath(ancestor);
				if (!isInside(this.root, canonical)) {
					throw new WorkspaceBoundaryError(`Workspace path resolves outside repository root: ${path.relative}`);
				}
				if (ancestor === path.absolute) {
					return { relative: relative(this.root, canonical).split(sep).join("/").normalize("NFC"), absolute: canonical };
				}
				return path;
			} catch (error) {
				if (!isMissing(error)) throw error;
				const parent = resolve(ancestor, "..");
				if (parent === ancestor) throw error;
				ancestor = parent;
			}
		}
	}

	private async isIgnored(path: string): Promise<boolean> {
		if (this.repository.kind === "git") {
			const result = await this.runner("git", ["check-ignore", "-q", "--", path], { cwd: this.root });
			if (result.code === 0) return true;
			if (result.code === 1) return false;
			throw new WorkspaceBoundaryError(`git check-ignore failed: ${result.stderr.trim()}`);
		}

		const fileset = `file:${JSON.stringify(path)}`;
		const tracked = await this.runner(
			"jj",
			["--ignore-working-copy", "file", "list", "-r", "@", "-T", 'path ++ "\\0"', fileset],
			{ cwd: this.root },
		);
		if (tracked.code !== 0) throw new WorkspaceBoundaryError(`jj file list failed: ${tracked.stderr.trim()}`);
		if (tracked.stdout.split("\0").includes(path)) return false;
		const ignored = await this.runner(
			"git",
			[
				`--git-dir=${this.repository.gitStore}`,
				`--work-tree=${this.root}`,
				"check-ignore",
				"--no-index",
				"-q",
				"--",
				path,
			],
			{ cwd: this.root },
		);
		if (ignored.code === 0) return true;
		if (ignored.code === 1) return false;
		throw new WorkspaceBoundaryError(`Jujutsu ignore check failed: ${ignored.stderr.trim()}`);
	}
}
