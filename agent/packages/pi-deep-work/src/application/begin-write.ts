import type { RunAuthority } from "./run-authority.ts";
import { canonicalDigest } from "../policy/canonical-json.ts";
import type { ResolvedPolicy } from "../policy/catalog.ts";
import { changedPathsDigest } from "../subject/content.ts";
import { SubjectDriftError } from "../subject/drift.ts";
import type { GitCleanObservationSubject, JjObservationSubject } from "../subject/types.ts";
import {
	backendSnapshotDigest,
	type BackendObservationSnapshot,
	type BackendTreeService,
} from "../gates/tree-backend.ts";
import type { CommandResult, CommandRunner, DetectedRepository } from "../vcs/types.ts";

interface WriteBaselineBase {
	schemaVersion: 1;
	mainline: string;
	mainlineCommitId: string;
	snapshotDigest: string;
}

export interface GitWriteBaseline extends WriteBaselineBase {
	kind: "git";
	observation: GitCleanObservationSubject;
	headOid: string;
	symbolicRef: string;
	indexTree: string;
	treeId: string;
}

export interface JjWriteBaseline extends WriteBaselineBase {
	kind: "jj";
	observation: JjObservationSubject;
	operationId: string;
	workspaceId: string;
	changeId: string;
	commitId: string;
	parentCommitId: string;
	treeDigest: string;
}

export type WriteBaseline = GitWriteBaseline | JjWriteBaseline;

const mintedBaselines = new WeakMap<object, string>();

/** Every downstream consumer must call this immediately before reading baseline fields. */
export function assertWriteBaseline(baseline: WriteBaseline): void {
	if (mintedBaselines.get(baseline) !== canonicalDigest(baseline)) {
		throw new Error("Write baseline was not minted by WritePreflight or was modified");
	}
}

export class WritePreflightError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WritePreflightError";
	}
}

interface GitInspection {
	kind: "git";
	mainlineCommit: CommandResult;
	headTree: CommandResult;
}

interface JjInspection {
	kind: "jj";
	mutable: CommandResult;
	mainline: CommandResult;
	ancestry?: CommandResult;
}

type Inspection = GitInspection | JjInspection;

export class WritePreflight {
	constructor(
		private readonly authority: RunAuthority,
		private readonly trees: BackendTreeService,
		private readonly repository: DetectedRepository,
		private readonly policy: ResolvedPolicy,
		private readonly runner: CommandRunner,
	) {}

	async begin(): Promise<WriteBaseline> {
		const mainline = validateMainline(this.policy.mainline);
		try {
			this.trees.assertContext(this.authority, this.repository, this.policy.digest);
		} catch (error) {
			return this.failInvariant(error);
		}
		const initial = await this.trees.captureObservation();
		try {
			this.assertInitial(initial, mainline);
		} catch (error) {
			if (error instanceof WritePreflightError) throw error;
			return this.failInvariant(error);
		}
		const inspection = await this.authority.runEffect("vcs:write-preflight", (signal) =>
			this.inspect(initial, mainline, signal),
		);
		let baseline: WriteBaseline;
		try {
			baseline = this.interpret(initial, mainline, inspection);
		} catch (error) {
			if (error instanceof WritePreflightError) throw error;
			return this.failInvariant(error);
		}
		const final = await this.trees.captureObservation();
		const initialDigest = backendSnapshotDigest(initial);
		const finalDigest = backendSnapshotDigest(final);
		// Live drift stays retryable outside runEffect; coordinator identity mismatches fail through failInvariant.
		if (initialDigest !== finalDigest) throw new SubjectDriftError(initialDigest, finalDigest);
		// The stored canonical digest protects nested data; shallow freeze only prevents top-level replacement.
		Object.freeze(baseline);
		mintedBaselines.set(baseline, canonicalDigest(baseline));
		return baseline;
	}

	private assertInitial(snapshot: BackendObservationSnapshot, mainline: string): void {
		if (snapshot.kind !== this.repository.kind) throw new Error("Write preflight backend differs from repository");
		if (snapshot.observation.repositoryId !== this.repository.repositoryId) {
			throw new Error("Write preflight repository identity changed");
		}
		if (snapshot.observation.policyDigest !== this.policy.digest) {
			throw new Error("Write preflight policy digest changed");
		}
		if (snapshot.kind === "git") {
			if (snapshot.treeId === null || snapshot.observation.conflicted) {
				throw new WritePreflightError("Git checkout has unresolved conflicts");
			}
			const expectedRef = `refs/heads/${mainline}`;
			if (snapshot.observation.symbolicRef !== expectedRef) {
				throw new WritePreflightError(`Git checkout must be on configured mainline ${expectedRef}`);
			}
			if (snapshot.observation.changedPathsDigest !== changedPathsDigest([])) {
				throw new WritePreflightError("Git checkout is not empty");
			}
			return;
		}
		if (snapshot.observation.conflicted) throw new WritePreflightError("Jujutsu @ has unresolved conflicts");
		if (snapshot.observation.parentCommitIds.length !== 1) {
			throw new WritePreflightError("Jujutsu @ must have exactly one parent");
		}
		if (snapshot.observation.changedPathsDigest !== changedPathsDigest([])) {
			throw new WritePreflightError("Jujutsu @ is not empty");
		}
	}

	private async inspect(
		snapshot: BackendObservationSnapshot,
		mainline: string,
		signal: AbortSignal,
	): Promise<Inspection> {
		if (snapshot.kind === "git" && snapshot.treeId !== null && this.repository.kind === "git") {
			const mainlineCommit = await this.runner(
				"git",
				["rev-parse", "--verify", `refs/heads/${mainline}^{commit}`],
				{ cwd: this.repository.root, signal },
			);
			const headTree = await this.runner("git", ["rev-parse", "--verify", `${snapshot.observation.headOid}^{tree}`], {
				cwd: this.repository.root,
				signal,
			});
			return { kind: "git", mainlineCommit, headTree };
		}
		if (snapshot.kind === "jj" && this.repository.kind === "jj") {
			const mutable = await this.runner(
				"jj",
				[
					"--ignore-working-copy",
					"log",
					`--revisions=${snapshot.observation.commitId}`,
					"--no-graph",
					"-T",
					'if(immutable, "true", "false") ++ "\\n"',
				],
				{ cwd: this.repository.root, signal },
			);
			const mainlineResult = await this.runner(
				"jj",
				[
					"--ignore-working-copy",
					"log",
					`--revisions=bookmarks(exact:${JSON.stringify(mainline)})`,
					"--no-graph",
					"-T",
					'commit_id ++ "\\n"',
				],
				{ cwd: this.repository.root, signal },
			);
			const mainlineIds = outputLines(mainlineResult.stdout);
			let ancestry: CommandResult | undefined;
			if (mainlineResult.code === 0 && mainlineIds.length === 1) {
				ancestry = await this.runner(
					"jj",
					[
						"--ignore-working-copy",
						"log",
						`--revisions=${mainlineIds[0]} & ancestors(${snapshot.observation.commitId})`,
						"--no-graph",
						"-T",
						'commit_id ++ "\\n"',
					],
					{ cwd: this.repository.root, signal },
				);
			}
			return { kind: "jj", mutable, mainline: mainlineResult, ...(ancestry ? { ancestry } : {}) };
		}
		throw new Error("Write preflight inspection backend mismatch");
	}

	private interpret(
		snapshot: BackendObservationSnapshot,
		mainline: string,
		inspection: Inspection,
	): WriteBaseline {
		if (snapshot.kind === "git" && snapshot.treeId !== null && inspection.kind === "git") {
			// These equalities reject a ref/index/tree change between initial capture and raw inspection.
			const mainlineCommitId = oneSuccessfulLine("Git mainline", inspection.mainlineCommit);
			const headTree = oneSuccessfulLine("Git HEAD tree", inspection.headTree);
			if (mainlineCommitId !== snapshot.observation.headOid) {
				throw new WritePreflightError("Configured Git mainline does not resolve to captured HEAD");
			}
			if (headTree !== snapshot.observation.indexTree || headTree !== snapshot.treeId) {
				// This TOCTOU remains retryable preflight state; the final recapture independently reports continuing drift.
				throw new WritePreflightError("Git HEAD, index, and working tree do not agree");
			}
			return {
				schemaVersion: 1,
				kind: "git",
				mainline,
				mainlineCommitId,
				snapshotDigest: backendSnapshotDigest(snapshot),
				observation: snapshot.observation,
				headOid: snapshot.observation.headOid,
				symbolicRef: snapshot.observation.symbolicRef,
				indexTree: snapshot.observation.indexTree,
				treeId: snapshot.treeId,
			};
		}
		if (snapshot.kind === "jj" && inspection.kind === "jj") {
			const mutable = oneSuccessfulLine("Jujutsu mutability", inspection.mutable);
			if (mutable !== "false") throw new WritePreflightError("Jujutsu @ must be mutable");
			const mainlineIds = successfulLines("Jujutsu mainline bookmark", inspection.mainline);
			if (mainlineIds.length === 0) {
				throw new WritePreflightError("Configured Jujutsu mainline bookmark is missing");
			}
			if (mainlineIds.length > 1) {
				throw new WritePreflightError("Configured Jujutsu mainline bookmark is divergent");
			}
			if (!inspection.ancestry) throw new WritePreflightError("Jujutsu mainline ancestry was not inspected");
			const ancestryIds = successfulLines("Jujutsu mainline ancestry", inspection.ancestry);
			if (ancestryIds.length !== 1 || ancestryIds[0] !== mainlineIds[0]) {
				throw new WritePreflightError("Configured Jujutsu mainline bookmark is not an ancestor of @");
			}
			return {
				schemaVersion: 1,
				kind: "jj",
				mainline,
				mainlineCommitId: mainlineIds[0],
				snapshotDigest: backendSnapshotDigest(snapshot),
				observation: snapshot.observation,
				operationId: snapshot.observation.operationId,
				workspaceId: snapshot.observation.workspaceId,
				changeId: snapshot.observation.changeId,
				commitId: snapshot.observation.commitId,
				parentCommitId: snapshot.observation.parentCommitIds[0],
				treeDigest: snapshot.treeDigest,
			};
		}
		throw new Error("Write preflight interpretation backend mismatch");
	}

	private failInvariant(error: unknown): Promise<never> {
		// RunAuthority durably fails and rethrows this original cause; the foreign-binding test pins both behaviors.
		return this.authority.runEffect("vcs:write-preflight-invariant", async () => {
			throw error;
		});
	}
}

function validateMainline(value: string | undefined): string {
	if (!value) {
		throw new WritePreflightError("Write workflow requires a configured mainline name. Run /deep init in this repository.");
	}
	if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
		throw new WritePreflightError(`Unsafe configured mainline name: ${JSON.stringify(value)}`);
	}
	const segments = value.split("/");
	if (
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				segment.startsWith(".") ||
				segment.endsWith(".") ||
				segment.endsWith(".lock"),
		) ||
		value.includes("..") ||
		value.includes("@{") ||
		value === "HEAD"
	) {
		throw new WritePreflightError(`Unsafe configured mainline name: ${JSON.stringify(value)}`);
	}
	return value;
}

function successfulLines(label: string, result: CommandResult): string[] {
	if (result.code !== 0) {
		throw new WritePreflightError(`${label} inspection failed: ${result.stderr.trim() || result.errorCode || `exit ${result.code}`}`);
	}
	return outputLines(result.stdout);
}

function oneSuccessfulLine(label: string, result: CommandResult): string {
	const lines = successfulLines(label, result);
	if (lines.length !== 1) throw new WritePreflightError(`${label} inspection returned ${lines.length} values`);
	return lines[0];
}

function outputLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}
