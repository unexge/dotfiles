import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunAuthority } from "../application/run-authority.ts";
import { completeRun } from "../application/lifecycle.ts";
import {
	assertCommitAuthorization,
	commitAuthorizationDigest,
	type CommitAuthorization,
} from "../authorization/authorize.ts";
import { canonicalDigest, canonicalJson } from "../policy/canonical-json.ts";
import type { RecoveryLeaseGuard } from "../lease/repository-lease.ts";
import { digestPaths, nulFields, observationSubjectDigest } from "../subject/content.ts";
import type { GitCandidateSubject } from "../subject/types.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import {
	CommitRecordedSchema,
	GitCommitPreparedSchema,
	decode,
	type CommitRecorded,
	type CommitPrepared,
} from "../store/schemas.ts";
import { captureGitObservation } from "../vcs/git-backend.ts";
import type { CommandRunner, GitRepository } from "../vcs/types.ts";
import { BackendTreeService, backendTreeIdentity } from "../gates/tree-backend.ts";

export type GitCommitPrepared = Extract<CommitPrepared, { kind: "git" }>;
export type GitCommitRecorded = Extract<CommitRecorded, { backend: "git" }>;

const preparedToken = Symbol("prepared-git-transaction");
const preparedTransactions = new WeakMap<object, string>();

export class PreparedGitTransaction {
	constructor(
		token: typeof preparedToken,
		readonly record: GitCommitPrepared,
		readonly recordPath: string,
		readonly recordDigest: string,
		readonly markerDigest: string,
		readonly authorization: CommitAuthorization,
	) {
		if (token !== preparedToken) throw new Error("PreparedGitTransaction lacks package authority");
		Object.freeze(this);
		preparedTransactions.set(this, canonicalDigest({ record, recordPath, recordDigest, markerDigest }));
	}
}

export class GitTransactionService {
	private readonly hooksDirectory: string;

	constructor(
		private readonly authority: RunAuthority | null,
		private readonly store: RunStore,
		private readonly ref: RunRef,
		private readonly repository: GitRepository,
		private readonly runner: CommandRunner,
		private readonly scratchDirectory: string,
	) {
		this.hooksDirectory = join(scratchDirectory, "empty-hooks");
	}

	assertRun(authority: RunAuthority, store: RunStore, ref: RunRef): void {
		if (
			this.authority !== authority ||
			this.store !== store ||
			this.ref.directory !== ref.directory ||
			this.ref.runId !== ref.runId ||
			this.ref.repositoryId !== ref.repositoryId ||
			this.ref.backend !== ref.backend
		) {
			throw new Error("GitTransactionService is bound to another authority, store, or run");
		}
	}

	static forRecovery(
		store: RunStore,
		ref: RunRef,
		repository: GitRepository,
		runner: CommandRunner,
		scratchDirectory: string,
	): GitTransactionService {
		return new GitTransactionService(null, store, ref, repository, runner, scratchDirectory);
	}

	async prepare(authorization: CommitAuthorization): Promise<PreparedGitTransaction> {
		const authority = this.requireAuthority();
		assertCommitAuthorization(authorization);
		if (authorization.candidate.kind !== "git") throw new Error("Git transaction requires a Git authorization");
		const candidate = authorization.candidate;
		const root = await realpath(this.repository.root);
		const commonDir = await realpath(this.repository.commonDir);
		if (root !== candidate.observation.root || candidate.observation.symbolicRef === "DETACHED") {
			throw new Error("Git authorization is not attached to its canonical worktree ref");
		}
		const transactionTrees = new BackendTreeService(
			authority,
			this.repository,
			candidate.observation.policyDigest,
			this.safeCommandRunner(),
			join(this.scratchDirectory, "tree-capture"),
		);
		const snapshot = await transactionTrees.capture();
		if (
			snapshot.kind !== "git" ||
			backendTreeIdentity(snapshot) !== candidate.treeOid ||
			observationSubjectDigest(snapshot.observation) !== observationSubjectDigest(candidate.observation)
		) {
			throw new Error("Git candidate changed before commit preparation");
		}
		const prepared = await authority.runEffect("git:prepare-commit", async (signal) => {
			await this.assertExpectedState(candidate, signal);
			await mkdir(this.scratchDirectory, { recursive: true });
			await mkdir(this.hooksDirectory, { recursive: true, mode: 0o700 });
			const identity = await this.resolveIdentity(signal);
			const transactionId = randomUUID();
			const messagePath = join(this.scratchDirectory, `${transactionId}.message`);
			const message = authorization.message.text;
			const handle = await open(messagePath, "wx", 0o600);
			try {
				await handle.writeFile(message, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			let proposedCommitId: string;
			try {
				proposedCommitId = (
					await this.required(
						[
							...this.safeGitArgs(),
							"-c",
							"commit.gpgSign=false",
							"commit-tree",
							candidate.treeOid,
							"-p",
							candidate.observation.headOid,
							"-F",
							messagePath,
						],
						this.publicationEnvironment({
							GIT_AUTHOR_NAME: identity.name,
							GIT_AUTHOR_EMAIL: identity.email,
							GIT_AUTHOR_DATE: authorization.authorizedAt,
							GIT_COMMITTER_NAME: identity.name,
							GIT_COMMITTER_EMAIL: identity.email,
							GIT_COMMITTER_DATE: authorization.authorizedAt,
						}),
						signal,
					)
				).trim();
			} finally {
				await rm(messagePath, { force: true });
			}
			await this.verifyCommit(
				proposedCommitId,
				candidate,
				authorization.message.text,
				identity,
				authorization.authorizedAt,
				signal,
			);
			const authorizationDigest = commitAuthorizationDigest(authorization);
			const workingPaths = await this.workingPaths(authorization.candidateChangedPaths);
			const workingDigest = await digestPaths(this.repository.root, workingPaths);
			const otherRefsDigest = canonicalDigest(await this.otherRefs(candidate.observation.symbolicRef));
			const worktreesDigest = canonicalDigest(await this.worktrees());
			const record = decode(GitCommitPreparedSchema, {
				schemaVersion: 1,
				kind: "git",
				transactionId,
				authorizationDigest,
				subject: candidate,
				subjectDigest: authorization.candidateDigest,
				root,
				commonDir,
				expectedHead: candidate.observation.headOid,
				expectedRef: candidate.observation.symbolicRef,
				expectedIndexTree: candidate.observation.indexTree,
				treeOid: candidate.treeOid,
				candidatePaths: authorization.candidateChangedPaths,
				workingPaths,
				workingDigest,
				otherRefsDigest,
				worktreesDigest,
				proposedCommitId,
				messageDigest: authorization.message.digest,
				authorName: identity.name,
				authorEmail: identity.email,
				authorDate: authorization.authorizedAt,
				committerName: identity.name,
				committerEmail: identity.email,
				committerDate: authorization.authorizedAt,
				preparedAt: new Date().toISOString(),
			});
			const recordPath = `transactions/git/${transactionId}/prepared.json`;
			const recordArtifact = await this.store.writeImmutableArtifact(
				this.ref,
				recordPath,
				Buffer.from(canonicalJson(record)),
			);
			return { record, recordPath, recordArtifact };
		});
		const marker = await this.store.installPublicationMarker(this.ref, {
			kind: "git",
			transactionId: prepared.record.transactionId,
			preparedPath: prepared.recordPath,
			preparedDigest: prepared.recordArtifact.digest,
		});
		return new PreparedGitTransaction(
			preparedToken,
			prepared.record,
			prepared.recordPath,
			prepared.recordArtifact.digest,
			marker.digest,
			authorization,
		);
	}

	async publish(prepared: PreparedGitTransaction): Promise<GitCommitRecorded> {
		const authority = this.requireAuthority();
		this.assertPrepared(prepared);
		const record = prepared.record;
		if (record.expectedIndexTree !== record.subject.observation.indexTree) {
			throw new Error("Prepared Git index baseline contradicts its candidate subject");
		}
		const beforeRefs = await this.otherRefs(record.expectedRef);
		const beforeWorktrees = await this.worktrees();
		if (canonicalDigest(beforeRefs) !== record.otherRefsDigest || canonicalDigest(beforeWorktrees) !== record.worktreesDigest) {
			throw new Error("Git refs or worktree topology changed after preparation");
		}
		const workingPaths = await this.workingPaths(prepared.authorization.candidateChangedPaths);
		const beforeWorkingDigest = await digestPaths(this.repository.root, workingPaths);
		if (
			canonicalDigest(workingPaths) !== canonicalDigest(record.workingPaths) ||
			beforeWorkingDigest !== record.workingDigest
		) {
			throw new Error("Git working path set or bytes changed after preparation");
		}
		const result = await authority.publish({
			markerDigest: prepared.markerDigest,
			outcome: "LocalCommitCreated",
			summaryArtifact: `transactions/git/${record.transactionId}/recorded.json`,
			at: new Date().toISOString(),
			publish: async (marker) => {
				this.assertMarker(marker, prepared);
				await this.assertExpectedState(record.subject);
				await this.verifyCommit(
					record.proposedCommitId,
					record.subject,
					prepared.authorization.message.text,
					{ name: record.authorName, email: record.authorEmail },
					record.authorDate,
				);
				const current = await captureGitObservation(
					this.repository,
					record.subject.observation.policyDigest,
					this.safeCommandRunner(),
				);
				if (observationSubjectDigest(current) !== observationSubjectDigest(record.subject.observation)) {
					throw new Error("Git subject changed immediately before ref CAS");
				}
				await this.required(
					[
						...this.safeGitArgs(),
						"update-ref",
						record.expectedRef,
						record.proposedCommitId,
						record.expectedHead,
					],
					this.publicationEnvironment(),
				);
				const recorded = decode(CommitRecordedSchema, {
					schemaVersion: 1,
					backend: "git",
					transactionId: record.transactionId,
					authorizationDigest: record.authorizationDigest,
					subjectDigest: record.subjectDigest,
					commitId: record.proposedCommitId,
					ref: record.expectedRef,
					treeOid: record.treeOid,
					messageDigest: record.messageDigest,
					recordedAt: new Date().toISOString(),
				}) as GitCommitRecorded;
				await this.store.writeImmutableArtifact(
					this.ref,
					`transactions/git/${record.transactionId}/recorded.json`,
					Buffer.from(canonicalJson(recorded)),
				);
				return recorded;
			},
			abortPreparation: async (marker, kind) => {
				this.assertMarker(marker, prepared);
				await this.store.writeImmutableArtifact(
					this.ref,
					`transactions/git/${record.transactionId}/aborted.json`,
					Buffer.from(canonicalJson({ schemaVersion: 1, transactionId: record.transactionId, control: kind })),
				);
			},
			align: async () => {
				await this.align(
					record,
					beforeWorkingDigest,
					record.otherRefsDigest,
					record.worktreesDigest,
					workingPaths,
				);
			},
		});
		return result;
	}

	/** `None` means no outstanding work remains; durable recorded/recovery artifacts retain prior classification. */
	async recover(guard: RecoveryLeaseGuard): Promise<{ status: "None" | "Aborted" | "Committed"; commitId?: string }> {
		try {
			guard.assert(this.repository.repositoryId, this.ref.runId);
			return await this.recoverWithLeases();
		} finally {
			await guard.release();
		}
	}

	private async recoverWithLeases(): Promise<{ status: "None" | "Aborted" | "Committed"; commitId?: string }> {
		const marker = await this.store.readPublicationMarker(this.ref);
		if (!marker) return this.recoverMarkerlessPrepared();
		const payload = marker.payload as Record<string, unknown>;
		if (
			payload?.kind !== "git" ||
			typeof payload.transactionId !== "string" ||
			typeof payload.preparedPath !== "string" ||
			typeof payload.preparedDigest !== "string"
		) {
			throw new Error("Git publication marker payload is malformed");
		}
		const preparedBytes = await this.store.readArtifact(this.ref, payload.preparedPath);
		if (createHash("sha256").update(preparedBytes).digest("hex") !== payload.preparedDigest) {
			throw new Error("Git prepared artifact digest mismatch");
		}
		const record = decode(GitCommitPreparedSchema, JSON.parse(preparedBytes.toString("utf8")));
		if (
			record.transactionId !== payload.transactionId ||
			(await realpath(this.repository.root)) !== record.root ||
			(await realpath(this.repository.commonDir)) !== record.commonDir
		) {
			throw new Error("Git prepared transaction belongs to another repository");
		}
		const refOid = await this.refOid(record.expectedRef);
		if (marker.phase === "prepared") {
			if (refOid !== record.expectedHead) throw new Error("Prepared Git ref changed before recovery");
			await this.writeRecoveryArtifact(record, "aborted-pre-cas");
			await this.store.clearPreparedPublicationMarker(this.ref, marker.digest);
			return { status: "Aborted" };
		}
		if (marker.phase === "publishing" && refOid === record.expectedHead) {
			await this.store.withPublicationControl(this.ref, marker.digest, async (context) => {
				if (context.state.lifecycle !== "Active") throw new Error("Pre-CAS recovery found non-active lifecycle");
				await this.writeRecoveryArtifact(record, "aborted-cas-not-applied");
				await context.clearMarker();
			});
			return { status: "Aborted" };
		}
		if (refOid !== record.proposedCommitId) throw new Error("Git publication diverged from prepared expected-old/successor refs");
		await this.verifyPreparedCommit(record);
		const beforeWorkingDigest = await digestPaths(this.repository.root, record.workingPaths);
		if (beforeWorkingDigest !== record.workingDigest) {
			throw new Error("Git working bytes no longer match the prepared candidate");
		}
		let alignmentMarkerDigest = marker.digest;
		if (marker.phase === "publishing") {
			alignmentMarkerDigest = await this.store.withPublicationControl(this.ref, marker.digest, async (context) => {
				const recorded = await this.ensureRecorded(record);
				if (context.state.lifecycle === "Active") {
					const completed = completeRun(
						context.state,
						"LocalCommitCreated",
						`transactions/git/${record.transactionId}/recorded.json`,
						new Date().toISOString(),
					);
					await this.store.appendTransition(this.ref, "OutcomeRecorded", completed, completed.updatedAt);
				} else if (context.state.lifecycle !== "Completed" || context.state.outcome !== "LocalCommitCreated") {
					throw new Error("Git published successor has contradictory lifecycle state");
				}
				if (recorded.commitId !== record.proposedCommitId) throw new Error("Git recorded commit contradicts preparation");
				return context.markAligning();
			});
		} else {
			const state = await this.store.load(this.ref);
			if (state.lifecycle !== "Completed" || state.outcome !== "LocalCommitCreated") {
				throw new Error("Aligning Git transaction is not terminal");
			}
			await this.ensureRecorded(record);
		}
		await this.align(record, beforeWorkingDigest, record.otherRefsDigest, record.worktreesDigest, record.workingPaths);
		await this.store.clearAligningPublicationMarker(this.ref, alignmentMarkerDigest);
		return { status: "Committed", commitId: record.proposedCommitId };
	}

	private async recoverMarkerlessPrepared(): Promise<{ status: "None" | "Aborted" }> {
		const root = join(this.ref.directory, "artifacts", "transactions", "git");
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "None" };
			throw error;
		}
		let recovered = false;
		for (const transactionId of entries.sort()) {
			const files = await readdir(join(root, transactionId));
			if (
				files.includes("recorded.json") ||
				files.includes("aborted.json") ||
				files.some((file) => file.startsWith("recovery-"))
			) {
				continue;
			}
			const path = `transactions/git/${transactionId}/prepared.json`;
			let record: GitCommitPrepared;
			try {
				record = decode(GitCommitPreparedSchema, JSON.parse((await this.store.readArtifact(this.ref, path)).toString("utf8")));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if ((await this.refOid(record.expectedRef)) !== record.expectedHead) {
				// Stop before later orphan cleanup: one unexplained moved ref makes the whole recovery set unsafe.
				throw new Error("Markerless Git preparation has a moved ref and requires manual inspection");
			}
			await this.writeRecoveryArtifact(record, "aborted-markerless-pre-cas");
			recovered = true;
		}
		return { status: recovered ? "Aborted" : "None" };
	}

	private async ensureRecorded(record: GitCommitPrepared): Promise<GitCommitRecorded> {
		const path = `transactions/git/${record.transactionId}/recorded.json`;
		try {
			const existing = decode(CommitRecordedSchema, JSON.parse((await this.store.readArtifact(this.ref, path)).toString("utf8")));
			if (
				existing.backend !== "git" ||
				existing.transactionId !== record.transactionId ||
				existing.authorizationDigest !== record.authorizationDigest ||
				existing.subjectDigest !== record.subjectDigest ||
				existing.commitId !== record.proposedCommitId ||
				existing.ref !== record.expectedRef ||
				existing.treeOid !== record.treeOid ||
				existing.messageDigest !== record.messageDigest
			) {
				throw new Error("Existing Git commit record contradicts preparation");
			}
			return existing;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const recorded = decode(CommitRecordedSchema, {
			schemaVersion: 1,
			backend: "git",
			transactionId: record.transactionId,
			authorizationDigest: record.authorizationDigest,
			subjectDigest: record.subjectDigest,
			commitId: record.proposedCommitId,
			ref: record.expectedRef,
			treeOid: record.treeOid,
			messageDigest: record.messageDigest,
			recordedAt: new Date().toISOString(),
		}) as GitCommitRecorded;
		await this.store.writeImmutableArtifact(this.ref, path, Buffer.from(canonicalJson(recorded)));
		return recorded;
	}

	private async writeRecoveryArtifact(record: GitCommitPrepared, outcome: string): Promise<void> {
		const path = `transactions/git/${record.transactionId}/recovery-${outcome}.json`;
		const bytes = Buffer.from(canonicalJson({ schemaVersion: 1, transactionId: record.transactionId, outcome }));
		try {
			await this.store.writeImmutableArtifact(this.ref, path, bytes);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await this.store.readArtifact(this.ref, path);
			if (!existing.equals(bytes)) throw new Error("Git recovery artifact contradicts prior recovery");
		}
	}

	private async refOid(ref: string): Promise<string> {
		return (await this.required(["rev-parse", ref], this.publicationEnvironment())).trim();
	}

	private assertPrepared(prepared: PreparedGitTransaction): void {
		if (
			preparedTransactions.get(prepared) !==
			canonicalDigest({
				record: prepared.record,
				recordPath: prepared.recordPath,
				recordDigest: prepared.recordDigest,
				markerDigest: prepared.markerDigest,
			})
		) {
			throw new Error("Git preparation was not minted by this package or was modified");
		}
		assertCommitAuthorization(prepared.authorization);
	}

	private assertMarker(marker: unknown, prepared: PreparedGitTransaction): void {
		const value = marker as Record<string, unknown>;
		if (
			value?.kind !== "git" ||
			value.transactionId !== prepared.record.transactionId ||
			value.preparedPath !== prepared.recordPath ||
			value.preparedDigest !== prepared.recordDigest
		) {
			throw new Error("Publication marker does not match Git preparation");
		}
	}

	private requireAuthority(): RunAuthority {
		if (!this.authority) throw new Error("Git transaction recovery service cannot prepare or publish");
		return this.authority;
	}

	private async assertExpectedState(candidate: GitCandidateSubject, signal?: AbortSignal): Promise<void> {
		const symbolicRef = (
			await this.required(["symbolic-ref", "--quiet", "HEAD"], this.publicationEnvironment(), signal)
		).trim();
		if (symbolicRef !== candidate.observation.symbolicRef) throw new Error("Git symbolic HEAD changed");
		const head = (await this.required(["rev-parse", "HEAD"], this.publicationEnvironment(), signal)).trim();
		const ref = (
			await this.required(["rev-parse", candidate.observation.symbolicRef], this.publicationEnvironment(), signal)
		).trim();
		const indexTree = (await this.required(["write-tree"], this.publicationEnvironment(), signal)).trim();
		if (head !== candidate.observation.headOid || ref !== head || indexTree !== candidate.observation.indexTree) {
			throw new Error("Git expected HEAD/ref/index baseline changed");
		}
	}

	private async align(
		record: GitCommitPrepared,
		beforeWorkingDigest: string,
		expectedOtherRefsDigest: string,
		expectedWorktreesDigest: string,
		paths: readonly string[],
	): Promise<void> {
		await this.verifyPreparedCommit(record);
		await this.required([...this.safeGitArgs(), "read-tree", record.proposedCommitId], this.publicationEnvironment());
		const indexTree = (await this.required(["write-tree"], this.publicationEnvironment())).trim();
		if (indexTree !== record.treeOid) throw new Error("Git real index did not align to committed tree");
		if ((await digestPaths(this.repository.root, [...paths])) !== beforeWorkingDigest) {
			throw new Error("Git publication changed working bytes, modes, or symlinks");
		}
		const untracked = nulFields(
			await this.required(["ls-files", "--others", "--exclude-standard", "-z"], this.publicationEnvironment()),
		);
		if (untracked.length > 0) throw new Error(`Git alignment left untracked files: ${untracked.join(", ")}`);
		if (
			canonicalDigest(await this.otherRefs(record.expectedRef)) !== expectedOtherRefsDigest ||
			canonicalDigest(await this.worktrees()) !== expectedWorktreesDigest
		) {
			throw new Error("Git publication changed other refs or worktrees");
		}
		await this.assertPublishedRef(record);
	}


	private async assertPublishedRef(record: GitCommitPrepared): Promise<void> {
		const symbolic = (await this.required(["symbolic-ref", "--quiet", "HEAD"], this.publicationEnvironment())).trim();
		const head = (await this.required(["rev-parse", "HEAD"], this.publicationEnvironment())).trim();
		if (symbolic !== record.expectedRef || head !== record.proposedCommitId) throw new Error("Git published ref is not current HEAD");
	}

	private async verifyCommit(
		commitId: string,
		candidate: GitCandidateSubject,
		message: string,
		identity: { name: string; email: string },
		date: string,
		signal?: AbortSignal,
	): Promise<void> {
		const tree = (
			await this.required(["rev-parse", `${commitId}^{tree}`], this.publicationEnvironment(), signal)
		).trim();
		const parent = (await this.required(["rev-parse", `${commitId}^`], this.publicationEnvironment(), signal)).trim();
		const raw = await this.required(["cat-file", "commit", commitId], this.publicationEnvironment(), signal);
		const separator = raw.indexOf("\n\n");
		// validateCommitMessage forbids terminal LF, and commit-tree -F preserves those exact message bytes.
		const body = separator < 0 ? "" : raw.slice(separator + 2);
		const metadata = (
			await this.required(
				["show", "-s", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", commitId],
				this.publicationEnvironment(),
				signal,
			)
		).trimEnd().split("\0");
		const milliseconds = Math.floor(Date.parse(date) / 1000) * 1000;
		const isoDate = new Date(milliseconds).toISOString().replace(/\.000Z$/, "+00:00");
		if (
			tree !== candidate.treeOid ||
			parent !== candidate.observation.headOid ||
			body !== message ||
			metadata.length !== 6 ||
			metadata[0] !== identity.name ||
			metadata[1] !== identity.email ||
			metadata[2] !== isoDate ||
			metadata[3] !== identity.name ||
			metadata[4] !== identity.email ||
			metadata[5] !== isoDate
		) {
			throw new Error("Prepared Git commit does not match authorization");
		}
	}

	private async verifyPreparedCommit(record: GitCommitPrepared): Promise<void> {
		const tree = (await this.required(["rev-parse", `${record.proposedCommitId}^{tree}`], this.publicationEnvironment())).trim();
		const parent = (await this.required(["rev-parse", `${record.proposedCommitId}^`], this.publicationEnvironment())).trim();
		const raw = await this.required(["cat-file", "commit", record.proposedCommitId], this.publicationEnvironment());
		const separator = raw.indexOf("\n\n");
		const body = separator < 0 ? "" : raw.slice(separator + 2);
		const metadata = (
			await this.required(
				["show", "-s", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", record.proposedCommitId],
				this.publicationEnvironment(),
			)
		).trimEnd().split("\0");
		const authorMilliseconds = Math.floor(Date.parse(record.authorDate) / 1000) * 1000;
		const committerMilliseconds = Math.floor(Date.parse(record.committerDate) / 1000) * 1000;
		const authorIsoDate = new Date(authorMilliseconds).toISOString().replace(/\.000Z$/, "+00:00");
		const committerIsoDate = new Date(committerMilliseconds).toISOString().replace(/\.000Z$/, "+00:00");
		if (
			tree !== record.treeOid ||
			parent !== record.expectedHead ||
			createHash("sha256").update(Buffer.from(body)).digest("hex") !== record.messageDigest ||
			metadata.join("\0") !==
				[
					record.authorName,
					record.authorEmail,
					authorIsoDate,
					record.committerName,
					record.committerEmail,
					committerIsoDate,
				].join("\0")
		) {
			throw new Error("Prepared Git commit record does not match its commit object");
		}
	}

	private async resolveIdentity(signal?: AbortSignal): Promise<{ name: string; email: string }> {
		const env = sanitizedGitEnvironment(process.env, false);
		const name = (await this.required(["config", "--get", "user.name"], env, signal)).trim();
		const email = (await this.required(["config", "--get", "user.email"], env, signal)).trim();
		if (!name || !email) throw new Error("Git user.name/user.email is missing; configure a repository or global identity");
		return { name, email };
	}

	private safeCommandRunner(): CommandRunner {
		return async (command, args, options) => {
			if (command !== "git") return this.runner(command, args, options);
			const env = this.publicationEnvironment();
			const index = options.env?.GIT_INDEX_FILE;
			if (index) {
				const prefix = `${this.scratchDirectory}/`;
				if (!index.startsWith(prefix)) throw new Error("Temporary Git index escapes transaction scratch directory");
				env.GIT_INDEX_FILE = index;
			}
			return this.runner("git", [...this.safeGitArgs(), ...args], { ...options, env });
		};
	}

	private safeGitArgs(): string[] {
		return ["-c", `core.hooksPath=${this.hooksDirectory}`, "-c", "core.fsmonitor=false"];
	}

	private publicationEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
		return sanitizedGitEnvironment({ ...process.env, ...overrides }, true);
	}

	private required(args: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
		const safeArgs = [...this.safeGitArgs(), ...args];
		return this.runner("git", safeArgs, { cwd: this.repository.root, timeoutMs: 60_000, env, signal }).then((result) => {
			if (result.code !== 0) throw new Error(`git ${safeArgs.join(" ")} failed: ${result.stderr.trim()}`);
			return result.stdout;
		});
	}

	/** Any unrelated ref drift is intentionally fail-closed so this transaction cannot claim another writer's ref changes. */
	private async otherRefs(expectedRef: string): Promise<string> {
		return (
			await this.required(["for-each-ref", "--format=%(refname)%09%(objectname)"], this.publicationEnvironment())
		)
			.split("\n")
			.filter((line) => line && !line.startsWith(`${expectedRef}\t`))
			.sort()
			.join("\n");
	}

	private async worktrees(): Promise<string> {
		const canonicalRoot = await realpath(this.repository.root);
		const output = await this.required(["worktree", "list", "--porcelain"], this.publicationEnvironment());
		return output
			.trimEnd()
			.split("\n\n")
			.map((block) => {
				const lines = block.split("\n");
				return lines[0] === `worktree ${canonicalRoot}`
					? lines.filter((line) => !line.startsWith("HEAD ")).join("\n")
					: lines.join("\n");
			})
			.sort()
			.join("\n\n");
	}

	private async workingPaths(candidatePaths: readonly string[]): Promise<string[]> {
		const listed = nulFields(
			await this.required(
				["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
				this.publicationEnvironment(),
			),
		);
		// Candidate paths are always included, including deletions, so an authorized deletion-only change is nonempty.
		return [...new Set([...listed, ...candidatePaths])].sort((left, right) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
	}

}

export function sanitizedGitEnvironment(environment: NodeJS.ProcessEnv, disableGlobalConfig: boolean): NodeJS.ProcessEnv {
	const denied = new Set([
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_CONFIG_COUNT",
		"GIT_CONFIG_PARAMETERS",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
		"GIT_COMMON_DIR",
	]);
	const result: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(environment)) {
		if (value === undefined || denied.has(name) || name.startsWith("GIT_CONFIG_")) {
			continue;
		}
		result[name] = value;
	}
	if (disableGlobalConfig) {
		result.GIT_CONFIG_NOSYSTEM = "1";
		result.GIT_CONFIG_GLOBAL = "/dev/null";
		result.GIT_CONFIG_SYSTEM = "/dev/null";
	}
	return result;
}
