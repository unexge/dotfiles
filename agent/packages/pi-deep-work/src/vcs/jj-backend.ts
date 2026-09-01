import { realpath } from "node:fs/promises";
import type { JjObservationSubject } from "../subject/types.ts";
import { changedPathsDigest, combineDigests, nulFields } from "../subject/content.ts";
import type { CommandRunner, JjRepository, RepositoryStatus } from "./types.ts";

async function required(
	runner: CommandRunner,
	repository: JjRepository,
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	const result = await runner("jj", args, { cwd: repository.root, signal });
	if (result.code !== 0) throw new Error(`jj ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout;
}

async function snapshot(repository: JjRepository, runner: CommandRunner, signal?: AbortSignal): Promise<void> {
	await required(runner, repository, ["--quiet", "status"], signal);
}

export interface JjCommitIdentity {
	changeId: string;
	commitId: string;
	parentCommitIds: string[];
	conflicted: boolean;
}

async function commitFields(repository: JjRepository, runner: CommandRunner, signal?: AbortSignal): Promise<JjCommitIdentity> {
	const output = await required(
		runner,
		repository,
		[
			"log",
			"-r",
			"@",
			"--no-graph",
			"-T",
			'change_id.normal_hex() ++ "\\t" ++ commit_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ if(conflict, "true", "false") ++ "\\n"',
		],
		signal,
	);
	const [changeId, commitId, parents, conflicted] = output.trimEnd().split("\t", 4);
	if (!changeId || !commitId || parents === undefined || conflicted === undefined) {
		throw new Error("Jujutsu commit identity output is malformed");
	}
	return {
		changeId,
		commitId,
		parentCommitIds: parents ? parents.split(",") : [],
		conflicted: conflicted === "true",
	};
}

async function changedPaths(repository: JjRepository, runner: CommandRunner, signal?: AbortSignal): Promise<string[]> {
	const output = await required(
		runner,
		repository,
		["log", "-r", "@", "--no-graph", "-T", 'diff.files().map(|entry| entry.path()).join("\\0") ++ "\\0"'],
		signal,
	);
	return [...new Set(nulFields(output))].sort();
}

export async function jjStatus(
	repository: JjRepository,
	runner: CommandRunner,
	signal?: AbortSignal,
): Promise<RepositoryStatus> {
	await snapshot(repository, runner, signal);
	const fields = await commitFields(repository, runner, signal);
	const paths = await changedPaths(repository, runner, signal);
	return { clean: paths.length === 0, conflicted: fields.conflicted, changedPaths: paths };
}

export function buildJjObservationSubject(input: {
	repository: JjRepository;
	root: string;
	policyDigest: string;
	operationId: string;
	identity: JjCommitIdentity;
	changedPaths: string[];
}): JjObservationSubject {
	return {
		schemaVersion: 1,
		kind: "jj",
		repositoryId: input.repository.repositoryId,
		root: input.root,
		policyDigest: input.policyDigest,
		workingDigest: combineDigests([input.identity.commitId]),
		changedPathsDigest: changedPathsDigest(input.changedPaths),
		operationId: input.operationId,
		workspaceId: input.repository.workspaceId,
		changeId: input.identity.changeId,
		commitId: input.identity.commitId,
		parentCommitIds: input.identity.parentCommitIds,
		conflicted: input.identity.conflicted,
	};
}

export async function captureJjObservation(
	repository: JjRepository,
	policyDigest: string,
	runner: CommandRunner,
	signal?: AbortSignal,
): Promise<JjObservationSubject> {
	await snapshot(repository, runner, signal);
	const operationId = (
		await required(runner, repository, ["op", "log", "-n", "1", "--no-graph", "-T", 'id ++ "\\n"'], signal)
	).trim();
	const fields = await commitFields(repository, runner, signal);
	const changed = await changedPaths(repository, runner, signal);
	return buildJjObservationSubject({
		repository,
		root: await realpath(repository.root),
		policyDigest,
		operationId,
		identity: fields,
		changedPaths: changed,
	});
}

export async function resolveJjRevision(
	repository: JjRepository,
	revset: string,
	runner: CommandRunner,
	signal?: AbortSignal,
): Promise<string> {
	const output = await required(
		runner,
		repository,
		["--ignore-working-copy", "log", `--revisions=${revset}`, "--no-graph", "-T", 'commit_id ++ "\\n"'],
		signal,
	);
	const values = output
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
	if (values.length !== 1) throw new Error(`Jujutsu revset must resolve to exactly one commit: ${revset}`);
	return values[0];
}
