export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	errorCode?: string;
}

export interface CommandOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
	command: string,
	args: readonly string[],
	options: CommandOptions,
) => Promise<CommandResult>;

interface RepositoryBase {
	root: string;
	sharedRoot: string;
	repositoryId: string;
}

export interface GitRepository extends RepositoryBase {
	kind: "git";
	commonDir: string;
}

export interface JjRepository extends RepositoryBase {
	kind: "jj";
	gitStore: string;
	workspaceId: string;
}

export type DetectedRepository = GitRepository | JjRepository;

export interface RepositoryStatus {
	clean: boolean;
	conflicted: boolean;
	changedPaths: string[];
}

export class VcsDetectionError extends Error {
	readonly code: "not_repository" | "probe_failed";

	constructor(message: string, code: "not_repository" | "probe_failed" = "probe_failed") {
		super(message);
		this.name = "VcsDetectionError";
		this.code = code;
	}
}
