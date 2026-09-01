import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MutationEffectOptions, RunAuthority } from "../application/run-authority.ts";
import { canonicalDigest } from "../policy/canonical-json.ts";
import { changedPathsDigest, evidenceSubjectDigest, nulFields, observationSubjectDigest } from "../subject/content.ts";
import {
	CandidateSubjectSchema,
	RegressionSubjectSchema,
	type CandidateSubject,
	type RegressionSubject,
	type GitCleanObservationSubject,
	type GitConflictedObservationSubject,
	type JjObservationSubject,
} from "../subject/types.ts";
import { SubjectDriftError } from "../subject/drift.ts";
import type { MutationPhaseCheckpoint } from "../store/schemas.ts";
import { captureGitObservation, resolveGitRevision } from "../vcs/git-backend.ts";
import { captureJjObservation, resolveJjRevision } from "../vcs/jj-backend.ts";
import type { CommandRunner, DetectedRepository, GitRepository, JjRepository } from "../vcs/types.ts";
import { Check } from "typebox/value";
import { assertNormalizationResult, type NormalizationResult } from "./normalizer.ts";
import { assertTrustedCommand, type TrustedCommand } from "./catalog.ts";

const sealedCandidates = new WeakMap<object, string>();
const sealedRegressions = new WeakMap<object, string>();

export function assertSealedCandidate(candidate: CandidateSubject): void {
	if (sealedCandidates.get(candidate) !== evidenceSubjectDigest(candidate)) {
		throw new Error("Candidate was not minted by BackendTreeService or was modified after sealing");
	}
}

export function assertSealedRegression(subject: RegressionSubject): void {
	if (sealedRegressions.get(subject) !== evidenceSubjectDigest(subject)) {
		throw new Error("Regression subject was not minted by BackendTreeService or was modified after sealing");
	}
}

/** Re-mints only against the exact durable regression mutation checkpoint. */
export function restoreSealedRegression(
	subject: RegressionSubject,
	checkpoint: MutationPhaseCheckpoint,
): RegressionSubject {
	if (!Check(RegressionSubjectSchema, subject)) throw new Error("Persisted regression subject is invalid");
	if (
		checkpoint.phase !== "regression" ||
		checkpoint.policyDigest !== subject.observation.policyDigest ||
		checkpoint.subjectDigest !== observationSubjectDigest(subject.observation)
	) {
		throw new Error("Persisted regression subject is foreign to its mutation checkpoint");
	}
	sealedRegressions.set(subject, evidenceSubjectDigest(subject));
	return subject;
}

export interface GitTreeSnapshot {
	kind: "git";
	observation: GitCleanObservationSubject;
	treeId: string;
}

export interface JjTreeSnapshot {
	kind: "jj";
	observation: JjObservationSubject;
	treeDigest: string;
}

export interface GitConflictedObservationSnapshot {
	kind: "git";
	observation: GitConflictedObservationSubject;
	treeId: null;
}

export type BackendTreeSnapshot = GitTreeSnapshot | JjTreeSnapshot;
export type BackendObservationSnapshot = BackendTreeSnapshot | GitConflictedObservationSnapshot;

export class ObservedDiffPreconditionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ObservedDiffPreconditionError";
	}
}

export interface ObservedDiff {
	kind: "git" | "jj";
	baseRevision: string;
	patch: string;
	paths: string[];
	/** SHA-256 of patch bytes in the observed-diff domain. */
	diffDigest: string;
}

type ObservedDiffRenderResult =
	| { kind: "rendered"; value: ObservedDiff }
	| { kind: "drift"; beforeDigest: string; afterDigest: string };

export interface CandidateSealInput {
	normalization: NormalizationResult;
	approvedDesignId: string;
	behaviorContractId: string;
}

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function jjNativeTreeDigest(value: string | Buffer): string {
	return digest(value);
}

function treeIdentity(snapshot: BackendObservationSnapshot): string {
	if (snapshot.kind === "jj") return snapshot.treeDigest;
	if (snapshot.treeId !== null) return snapshot.treeId;
	return snapshot.observation.indexEntriesDigest;
}

function sameSnapshot(left: BackendObservationSnapshot, right: BackendObservationSnapshot): boolean {
	return left.kind === right.kind && treeIdentity(left) === treeIdentity(right) && observationSubjectDigest(left.observation) === observationSubjectDigest(right.observation);
}

function gitPatchArgs(fromOid: string, toOid: string): string[] {
	return [
		"-c",
		"diff.algorithm=myers",
		"-c",
		"core.quotePath=false",
		"diff",
		"--binary",
		"--full-index",
		"--no-ext-diff",
		"--no-textconv",
		"--no-renames",
		"--unified=3",
		fromOid,
		toOid,
		"--",
	];
}

function gitChangedPathArgs(fromOid: string, toOid: string): string[] {
	return ["diff", "--name-only", "-z", "--no-renames", fromOid, toOid, "--"];
}

function jjPatchArgs(fromCommitId: string, toCommitId: string): string[] {
	return [
		"--ignore-working-copy",
		"--color",
		"never",
		"--no-pager",
		"diff",
		"--git",
		"--context=3",
		"--from",
		fromCommitId,
		"--to",
		toCommitId,
	];
}

function jjChangedPathArgs(fromCommitId: string, toCommitId: string): string[] {
	return [
		"--ignore-working-copy",
		"diff",
		"--from",
		fromCommitId,
		"--to",
		toCommitId,
		"-T",
		'path ++ "\\0"',
	];
}

async function required(
	runner: CommandRunner,
	command: string,
	args: readonly string[],
	cwd: string,
	signal: AbortSignal,
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	const result = await runner(command, args, { cwd, signal, ...(env ? { env } : {}) });
	if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout;
}

export class BackendTreeService {
	constructor(
		private readonly authority: RunAuthority,
		private readonly repository: DetectedRepository,
		private readonly policyDigest: string,
		private readonly runner: CommandRunner,
		private readonly scratchDirectory: string,
	) {}

	assertContext(authority: RunAuthority, repository: DetectedRepository, policyDigest: string): void {
		if (this.authority !== authority || this.repository !== repository || this.policyDigest !== policyDigest) {
			throw new Error("BackendTreeService is bound to another authority, repository, or policy");
		}
	}

	capture(): Promise<BackendTreeSnapshot> {
		return this.authority.runEffect("vcs:capture-tree", (signal) => this.captureInside(signal));
	}

	captureObservation(): Promise<BackendObservationSnapshot> {
		return this.authority.runEffect("vcs:capture-observation", (signal) => this.captureObservationInside(signal));
	}

	captureMutationObservation(options: MutationEffectOptions): Promise<BackendObservationSnapshot> {
		return this.authority.runMutationEffect(
			"vcs:capture-mutation-observation",
			(signal) => this.captureObservationInside(signal),
			options,
		);
	}

	async renderObservedDiff(snapshot: BackendObservationSnapshot, base?: string): Promise<ObservedDiff> {
		// Expected precondition and drift failures stay outside runEffect so the workflow can settle them truthfully.
		if (base !== undefined && !base.trim()) throw new ObservedDiffPreconditionError("Observed diff base cannot be empty");
		if (snapshot.kind === "git" && snapshot.treeId === null) {
			throw new ObservedDiffPreconditionError("Cannot render a Git diff with unresolved conflicts");
		}
		if (snapshot.kind === "jj" && base === undefined && snapshot.observation.parentCommitIds.length !== 1) {
			throw new ObservedDiffPreconditionError("Jujutsu observed diff requires an explicit base for a multi-parent commit");
		}
		const result = await this.authority.runEffect("vcs:render-observed-diff", (signal) =>
			this.renderObservedDiffInside(snapshot, base, signal),
		);
		if (result.kind === "drift") throw new SubjectDriftError(result.beforeDigest, result.afterDigest);
		return result.value;
	}

	diffPaths(before: BackendTreeSnapshot, after: BackendTreeSnapshot): Promise<string[]> {
		return this.authority.runEffect("vcs:diff-trees", (signal) => this.diffPathsInside(before, after, signal));
	}

	sealCandidate(input: CandidateSealInput): Promise<CandidateSubject> {
		return this.authority.runEffect("vcs:seal-candidate", (signal) => this.sealInside(input, signal));
	}

	renderCandidatePatch(candidate: CandidateSubject): Promise<{ patch: string; paths: string[] }> {
		assertSealedCandidate(candidate);
		return this.authority.runEffect("vcs:render-candidate", async (signal) => {
			let patch: string;
			let paths: string[];
			if (candidate.kind === "git" && this.repository.kind === "git") {
				patch = await required(
					this.runner,
					"git",
					gitPatchArgs(candidate.observation.headOid, candidate.treeOid),
					this.repository.root,
					signal,
				);
				paths = nulFields(
					await required(
						this.runner,
						"git",
						gitChangedPathArgs(candidate.observation.headOid, candidate.treeOid),
						this.repository.root,
						signal,
					),
				).sort();
			} else if (candidate.kind === "jj" && this.repository.kind === "jj") {
				const parent = candidate.parentCommitIds[0];
				patch = await required(
					this.runner,
					"jj",
					jjPatchArgs(parent, candidate.commitId),
					this.repository.root,
					signal,
				);
				paths = await this.jjDiffPaths(parent, candidate.commitId, signal);
			} else {
				throw new Error("Candidate backend differs from tree service");
			}
			if (digest(patch) !== candidate.patchDigest || changedPathsDigest(paths) !== candidate.changedPathsDigest) {
				throw new Error("Rendered candidate patch or paths differ from sealed identity");
			}
			return { patch, paths };
		});
	}

	sealRegression(baseline: BackendTreeSnapshot, command: TrustedCommand): Promise<RegressionSubject> {
		assertTrustedCommand(command);
		if (command.category !== "observation") throw new Error("Regression sealing requires a trusted observation command");
		return this.authority.runEffect("vcs:seal-regression", (signal) => this.sealRegressionInside(baseline, command, signal));
	}

	private async captureInside(signal: AbortSignal): Promise<BackendTreeSnapshot> {
		const snapshot = await this.captureObservationInside(signal);
		if (snapshot.kind === "git") {
			if (snapshot.treeId === null) throw new Error("Cannot capture a Git tree with conflicts");
			return snapshot;
		}
		if (snapshot.observation.conflicted) throw new Error("Cannot capture a Jujutsu tree with conflicts");
		if (snapshot.observation.parentCommitIds.length !== 1) {
			throw new Error("Jujutsu candidate requires exactly one parent");
		}
		return snapshot;
	}

	private async captureObservationInside(signal: AbortSignal): Promise<BackendObservationSnapshot> {
		if (this.repository.kind === "git") return this.captureGitObservation(this.repository, signal);
		return this.captureJjObservation(this.repository, signal);
	}

	private async captureGitObservation(
		repository: GitRepository,
		signal: AbortSignal,
	): Promise<GitTreeSnapshot | GitConflictedObservationSnapshot> {
		const observation = await captureGitObservation(repository, this.policyDigest, this.runner, signal);
		if (observation.conflicted) return { kind: "git", observation, treeId: null };
		await mkdir(this.scratchDirectory, { recursive: true });
		const index = join(this.scratchDirectory, `index-${process.pid}-${randomUUID()}`);
		const env = { GIT_INDEX_FILE: index };
		try {
			await required(this.runner, "git", ["read-tree", observation.indexTree], repository.root, signal, env);
			// This list reads the live index; the trailing observation rejects divergence from the index tree captured above.
			const paths = nulFields(
				await required(
					this.runner,
					"git",
					["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
					repository.root,
					signal,
				),
			);
			for (const path of paths) await this.updateGitIndex(repository, index, path, signal);
			const treeId = (await required(this.runner, "git", ["write-tree"], repository.root, signal, env)).trim();
			const after = await captureGitObservation(repository, this.policyDigest, this.runner, signal);
			if (observationSubjectDigest(after) !== observationSubjectDigest(observation)) {
				throw new Error(
					`Git subject drifted while capturing candidate tree: ${observationSubjectDigest(observation)} != ${observationSubjectDigest(after)}`,
				);
			}
			return { kind: "git", observation, treeId };
		} finally {
			await unlink(index).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
			await unlink(`${index}.lock`).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
		}
	}

	private async updateGitIndex(
		repository: GitRepository,
		index: string,
		path: string,
		signal: AbortSignal,
	): Promise<void> {
		const env = { GIT_INDEX_FILE: index };
		const absolute = join(repository.root, path);
		let metadata: Awaited<ReturnType<typeof lstat>>;
		try {
			metadata = await lstat(absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await required(this.runner, "git", ["update-index", "--force-remove", "--", path], repository.root, signal, env);
			return;
		}
		if (metadata.isDirectory()) {
			const staged = await required(
				this.runner,
				"git",
				["ls-files", "--stage", "-z", "--", path],
				repository.root,
				signal,
			);
			const metadataEnd = staged.indexOf("\t");
			const [mode] = metadataEnd < 0 ? [] : staged.slice(0, metadataEnd).split(" ");
			if (mode !== "160000") throw new Error(`Unsupported Git candidate directory: ${path}`);
			const oid = (
				await required(this.runner, "git", ["-C", path, "rev-parse", "HEAD"], repository.root, signal)
			).trim();
			await required(
				this.runner,
				"git",
				["update-index", "--add", "--cacheinfo", "160000", oid, path],
				repository.root,
				signal,
				env,
			);
			return;
		}
		let mode: string;
		let objectPath = path;
		let temporary: string | undefined;
		if (metadata.isFile()) {
			mode = metadata.mode & 0o100 ? "100755" : "100644";
		} else if (metadata.isSymbolicLink()) {
			mode = "120000";
			temporary = join(this.scratchDirectory, `symlink-${process.pid}-${randomUUID()}`);
			await writeFile(temporary, await readlink(absolute, { encoding: "buffer" }));
			objectPath = temporary;
		} else {
			throw new Error(`Unsupported Git candidate path type: ${path}`);
		}
		try {
			const oid = (
				await required(this.runner, "git", ["hash-object", "-w", "--no-filters", "--", objectPath], repository.root, signal)
			).trim();
			await required(
				this.runner,
				"git",
				["update-index", "--add", "--cacheinfo", mode, oid, path],
				repository.root,
				signal,
				env,
			);
		} finally {
			if (temporary) await unlink(temporary).catch(() => undefined);
		}
	}

	private async captureJjObservation(repository: JjRepository, signal: AbortSignal): Promise<JjTreeSnapshot> {
		const observation = await captureJjObservation(repository, this.policyDigest, this.runner, signal);
		const tree = await required(
			this.runner,
			"jj",
			["--ignore-working-copy", "debug", "tree", "-r", observation.commitId],
			repository.root,
			signal,
		);
		return { kind: "jj", observation, treeDigest: jjNativeTreeDigest(tree) };
	}

	private async renderObservedDiffInside(
		snapshot: BackendObservationSnapshot,
		base: string | undefined,
		signal: AbortSignal,
	): Promise<ObservedDiffRenderResult> {
		if (snapshot.observation.repositoryId !== this.repository.repositoryId) {
			throw new Error("Observed diff repository identity differs from tree service");
		}
		if (snapshot.observation.policyDigest !== this.policyDigest) {
			throw new Error("Observed diff policy differs from tree service");
		}
		const expectedDigest = backendSnapshotDigest(snapshot);
		const before = await this.captureObservationInside(signal);
		const beforeDigest = backendSnapshotDigest(before);
		if (!sameSnapshot(snapshot, before)) {
			return { kind: "drift", beforeDigest: expectedDigest, afterDigest: beforeDigest };
		}
		const selector = base?.trim();
		let result: ObservedDiff;
		if (snapshot.kind === "git" && this.repository.kind === "git" && snapshot.treeId !== null) {
			const baseRevision = selector
				? await resolveGitRevision(this.repository, selector, this.runner, signal)
				: snapshot.observation.headOid;
			const patch = await required(
				this.runner,
				"git",
				gitPatchArgs(baseRevision, snapshot.treeId),
				this.repository.root,
				signal,
			);
			const paths = nulFields(
				await required(
					this.runner,
					"git",
					gitChangedPathArgs(baseRevision, snapshot.treeId),
					this.repository.root,
					signal,
				),
			).sort();
			result = { kind: "git", baseRevision, patch, paths, diffDigest: digest(patch) };
		} else if (snapshot.kind === "jj" && this.repository.kind === "jj") {
			const baseRevision = selector
				? await resolveJjRevision(this.repository, selector, this.runner, signal)
				: snapshot.observation.parentCommitIds[0];
			const patch = await required(
				this.runner,
				"jj",
				jjPatchArgs(baseRevision, snapshot.observation.commitId),
				this.repository.root,
				signal,
			);
			const paths = await this.jjDiffPaths(baseRevision, snapshot.observation.commitId, signal);
			result = { kind: "jj", baseRevision, patch, paths, diffDigest: digest(patch) };
		} else {
			// A foreign snapshot is a coordinator invariant violation, so runEffect must fail the attempt.
			throw new Error("Observed diff backend mismatch");
		}
		const after = await this.captureObservationInside(signal);
		const afterDigest = backendSnapshotDigest(after);
		if (!sameSnapshot(snapshot, after)) {
			return { kind: "drift", beforeDigest: expectedDigest, afterDigest };
		}
		return { kind: "rendered", value: result };
	}

	private async diffPathsInside(
		before: BackendTreeSnapshot,
		after: BackendTreeSnapshot,
		signal: AbortSignal,
	): Promise<string[]> {
		if (before.kind !== after.kind || before.kind !== this.repository.kind) throw new Error("Cannot diff trees from different backends");
		if (before.kind === "git" && after.kind === "git") {
			return nulFields(
				await required(
					this.runner,
					"git",
					gitChangedPathArgs(before.treeId, after.treeId),
					this.repository.root,
					signal,
				),
			).sort();
		}
		if (before.kind !== "jj" || after.kind !== "jj") throw new Error("Jujutsu tree diff received Git state");
		return this.jjDiffPaths(before.observation.commitId, after.observation.commitId, signal);
	}

	private async jjDiffPaths(from: string, to: string, signal: AbortSignal): Promise<string[]> {
		const output = await required(
			this.runner,
			"jj",
			jjChangedPathArgs(from, to),
			this.repository.root,
			signal,
		);
		return nulFields(output).sort();
	}

	private async sealRegressionInside(
		baseline: BackendTreeSnapshot,
		command: TrustedCommand,
		signal: AbortSignal,
	): Promise<RegressionSubject> {
		const current = await this.captureInside(signal);
		if (baseline.kind !== current.kind || treeIdentity(baseline) === treeIdentity(current)) {
			throw new Error("Regression subject requires one changed tree on the same backend");
		}
		const paths = await this.diffPathsInside(baseline, current, signal);
		let value: unknown;
		if (baseline.kind === "git" && current.kind === "git") {
			if (
				baseline.observation.repositoryId !== current.observation.repositoryId ||
				baseline.observation.policyDigest !== current.observation.policyDigest ||
				baseline.observation.headOid !== current.observation.headOid ||
				baseline.observation.symbolicRef !== current.observation.symbolicRef ||
				baseline.observation.indexTree !== current.observation.indexTree
			) {
				throw new Error("Git regression baseline identity changed");
			}
			const patch = await required(
				this.runner,
				"git",
				gitPatchArgs(baseline.treeId, current.treeId),
				this.repository.root,
				signal,
			);
			value = {
				schemaVersion: 1,
				kind: "git-regression",
				observation: current.observation,
				treeOid: current.treeId,
				patchDigest: digest(patch),
				changedPathsDigest: changedPathsDigest(paths),
				observationId: command.id,
				argvDigest: command.argvDigest(),
				baseline: {
					headOid: baseline.observation.headOid,
					symbolicRef: baseline.observation.symbolicRef,
					indexTree: baseline.observation.indexTree,
					treeOid: baseline.treeId,
				},
			};
		} else if (baseline.kind === "jj" && current.kind === "jj") {
			if (
				baseline.observation.repositoryId !== current.observation.repositoryId ||
				baseline.observation.policyDigest !== current.observation.policyDigest ||
				baseline.observation.workspaceId !== current.observation.workspaceId ||
				baseline.observation.changeId !== current.observation.changeId ||
				baseline.observation.parentCommitIds.join("\0") !== current.observation.parentCommitIds.join("\0")
			) {
				throw new Error("Jujutsu regression baseline identity changed");
			}
			const patch = await required(
				this.runner,
				"jj",
				jjPatchArgs(baseline.observation.commitId, current.observation.commitId),
				this.repository.root,
				signal,
			);
			value = {
				schemaVersion: 1,
				kind: "jj-regression",
				observation: current.observation,
				treeDigest: current.treeDigest,
				patchDigest: digest(patch),
				changedPathsDigest: changedPathsDigest(paths),
				observationId: command.id,
				argvDigest: command.argvDigest(),
				baseline: {
					workspaceId: baseline.observation.workspaceId,
					changeId: baseline.observation.changeId,
					parentCommitIds: baseline.observation.parentCommitIds,
					commitId: baseline.observation.commitId,
					treeDigest: baseline.treeDigest,
				},
			};
		} else {
			throw new Error("Regression backend mismatch");
		}
		if (!Check(RegressionSubjectSchema, value)) throw new Error("Constructed regression subject is invalid");
		const subject = value as RegressionSubject;
		sealedRegressions.set(subject, evidenceSubjectDigest(subject));
		return subject;
	}

	private async sealInside(input: CandidateSealInput, signal: AbortSignal): Promise<CandidateSubject> {
		assertNormalizationResult(input.normalization);
		const snapshot = await this.captureInside(signal);
		if (
			treeIdentity(snapshot) !== input.normalization.fixedPointTree ||
			backendSnapshotDigest(snapshot) !== backendSnapshotDigest(input.normalization.passTwo)
		) {
			throw new Error("Candidate subject differs from normalization fixed point");
		}
		let value: unknown;
		if (snapshot.kind === "git") {
			const patch = await required(
				this.runner,
				"git",
				gitPatchArgs(snapshot.observation.headOid, snapshot.treeId),
				this.repository.root,
				signal,
			);
			const paths = nulFields(
				await required(
					this.runner,
					"git",
					gitChangedPathArgs(snapshot.observation.headOid, snapshot.treeId),
					this.repository.root,
					signal,
				),
			).sort();
			value = {
				schemaVersion: 1,
				kind: "git",
				observation: snapshot.observation,
				treeOid: snapshot.treeId,
				patchDigest: digest(patch),
				changedPathsDigest: changedPathsDigest(paths),
				approvedDesignId: input.approvedDesignId,
				behaviorContractId: input.behaviorContractId,
			};
		} else {
			const parent = snapshot.observation.parentCommitIds[0];
			const patch = await required(
				this.runner,
				"jj",
				jjPatchArgs(parent, snapshot.observation.commitId),
				this.repository.root,
				signal,
			);
			const paths = await this.jjDiffPaths(parent, snapshot.observation.commitId, signal);
			value = {
				schemaVersion: 1,
				kind: "jj",
				observation: snapshot.observation,
				treeDigest: snapshot.treeDigest,
				patchDigest: digest(patch),
				changedPathsDigest: changedPathsDigest(paths),
				approvedDesignId: input.approvedDesignId,
				behaviorContractId: input.behaviorContractId,
				operationId: snapshot.observation.operationId,
				changeId: snapshot.observation.changeId,
				commitId: snapshot.observation.commitId,
				parentCommitIds: snapshot.observation.parentCommitIds,
			};
		}
		const after = await this.captureInside(signal);
		if (!sameSnapshot(snapshot, after)) throw new Error("Candidate subject drifted while sealing");
		if (!Check(CandidateSubjectSchema, value)) throw new Error(`Constructed ${snapshot.kind} candidate is invalid`);
		const candidate = value as CandidateSubject;
		sealedCandidates.set(candidate, evidenceSubjectDigest(candidate));
		return candidate;
	}
}

export function backendTreeIdentity(snapshot: BackendTreeSnapshot): string {
	return treeIdentity(snapshot);
}

export function backendSnapshotDigest(snapshot: BackendObservationSnapshot): string {
	return canonicalDigest(snapshot);
}
