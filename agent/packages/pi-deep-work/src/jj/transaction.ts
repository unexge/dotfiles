import { createHash, randomUUID } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { RunAuthority } from "../application/run-authority.ts";
import { completeRun } from "../application/lifecycle.ts";
import type { RecoveryLeaseGuard } from "../lease/repository-lease.ts";
import {
	assertCommitAuthorization,
	commitAuthorizationDigest,
	type CommitAuthorization,
} from "../authorization/authorize.ts";
import { BackendTreeService, backendTreeIdentity, jjNativeTreeDigest } from "../gates/tree-backend.ts";
import { canonicalDigest, canonicalJson } from "../policy/canonical-json.ts";
import { digestPaths, nulFields, observationSubjectDigest } from "../subject/content.ts";
import type { JjObservationSubject } from "../subject/types.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import {
	CommitRecordedSchema,
	JjCommitPreparedSchema,
	decode,
	type CommitPrepared,
	type CommitRecorded,
} from "../store/schemas.ts";
import { buildJjObservationSubject } from "../vcs/jj-backend.ts";
import type { CommandRunner, JjRepository } from "../vcs/types.ts";

export type JjCommitPrepared = Extract<CommitPrepared, { kind: "jj" }>;
export type JjCommitRecorded = Extract<CommitRecorded, { backend: "jj" }>;

interface RevisionState {
	changeId: string;
	commitId: string;
	parentCommitIds: string[];
	description: string;
	authorName: string;
	authorEmail: string;
	conflicted: boolean;
	treeDigest: string;
	changedPaths: string[];
}

const preparedToken = Symbol("prepared-jj-transaction");
const preparedTransactions = new WeakMap<object, string>();

export class PreparedJjTransaction {
	constructor(
		token: typeof preparedToken,
		readonly record: JjCommitPrepared,
		readonly recordPath: string,
		readonly recordDigest: string,
		readonly markerDigest: string,
		readonly authorization: CommitAuthorization,
	) {
		if (token !== preparedToken) throw new Error("PreparedJjTransaction lacks package authority");
		Object.freeze(this);
		preparedTransactions.set(this, canonicalDigest({ record, recordPath, recordDigest, markerDigest }));
	}
}

export class JjTransactionService {
	constructor(
		private readonly authority: RunAuthority | null,
		private readonly store: RunStore,
		private readonly ref: RunRef,
		private readonly repository: JjRepository,
		private readonly runner: CommandRunner,
		private readonly trees: BackendTreeService | null,
	) {}

	assertRun(authority: RunAuthority, store: RunStore, ref: RunRef, trees: BackendTreeService): void {
		if (
			this.authority !== authority ||
			this.store !== store ||
			this.trees !== trees ||
			this.ref.directory !== ref.directory ||
			this.ref.runId !== ref.runId ||
			this.ref.repositoryId !== ref.repositoryId ||
			this.ref.backend !== ref.backend
		) {
			throw new Error("JjTransactionService is bound to another authority, store, tree service, or run");
		}
	}

	static forRecovery(
		store: RunStore,
		ref: RunRef,
		repository: JjRepository,
		runner: CommandRunner,
	): JjTransactionService {
		return new JjTransactionService(null, store, ref, repository, runner, null);
	}

	async prepare(authorization: CommitAuthorization): Promise<PreparedJjTransaction> {
		const authority = this.requireAuthority();
		const trees = this.requireTrees();
		assertCommitAuthorization(authorization);
		if (authorization.candidate.kind !== "jj") throw new Error("Jujutsu transaction requires a Jujutsu authorization");
		const version = (await this.effectCommand("version", ["--version"])).trim();
		if (!/^jj 0\.41\./.test(version)) throw new Error(`Unsupported Jujutsu publication version: ${version}`);
		const candidate = authorization.candidate;
		const snapshot = await trees.capture();
		if (
			snapshot.kind !== "jj" ||
			backendTreeIdentity(snapshot) !== candidate.treeDigest ||
			observationSubjectDigest(snapshot.observation) !== observationSubjectDigest(candidate.observation)
		) {
			throw new Error("Jujutsu candidate changed before preparation");
		}
		const prepared = await authority.runEffect("jj:prepare", async (signal) => {
			const identity = await this.resolveIdentity(signal);
			const workingPaths = await this.workingPaths(candidate.observation.commitId, authorization.candidateChangedPaths, signal);
			const workingDigest = await digestPaths(this.repository.root, workingPaths);
			const bookmarksDigest = canonicalDigest(await this.bookmarks(signal));
			const workspacesDigest = canonicalDigest(await this.workspaces(signal));
			const transactionId = randomUUID();
			const record = decode(JjCommitPreparedSchema, {
				schemaVersion: 1,
				kind: "jj",
				transactionId,
				authorizationDigest: commitAuthorizationDigest(authorization),
				subject: candidate,
				subjectDigest: authorization.candidateDigest,
				root: await realpath(this.repository.root),
				sharedRoot: await realpath(this.repository.sharedRoot),
				expectedOperationId: candidate.operationId,
				expectedWorkspaceId: candidate.observation.workspaceId,
				expectedChangeId: candidate.changeId,
				expectedCommitId: candidate.commitId,
				expectedParentCommitIds: candidate.parentCommitIds,
				treeDigest: candidate.treeDigest,
				candidatePaths: authorization.candidateChangedPaths,
				workingPaths,
				workingDigest,
				bookmarksDigest,
				workspacesDigest,
				messageDigest: authorization.message.digest,
				userName: identity.name,
				userEmail: identity.email,
				jjVersion: version,
				preparedAt: new Date().toISOString(),
			});
			const recordPath = `transactions/jj/${transactionId}/prepared.json`;
			const artifact = await this.store.writeImmutableArtifact(this.ref, recordPath, Buffer.from(canonicalJson(record)));
			return { record, recordPath, artifact };
		});
		const finalSnapshot = await trees.capture();
		if (
			finalSnapshot.kind !== "jj" ||
			finalSnapshot.observation.operationId !== prepared.record.expectedOperationId ||
			observationSubjectDigest(finalSnapshot.observation) !== observationSubjectDigest(candidate.observation) ||
			finalSnapshot.treeDigest !== candidate.treeDigest
		) {
			throw new Error("Jujutsu final qualification snapshot changed preparation");
		}
		const marker = await this.store.installPublicationMarker(this.ref, {
			kind: "jj",
			transactionId: prepared.record.transactionId,
			preparedPath: prepared.recordPath,
			preparedDigest: prepared.artifact.digest,
		});
		return new PreparedJjTransaction(
			preparedToken,
			prepared.record,
			prepared.recordPath,
			prepared.artifact.digest,
			marker.digest,
			authorization,
		);
	}

	async publish(prepared: PreparedJjTransaction): Promise<JjCommitRecorded> {
		const authority = this.requireAuthority();
		const trees = this.requireTrees();
		this.assertPrepared(prepared);
		const record = prepared.record;
		const beforeWorkingDigest = await digestPaths(this.repository.root, record.workingPaths);
		if (
			beforeWorkingDigest !== record.workingDigest ||
			canonicalDigest(await this.bookmarks()) !== record.bookmarksDigest ||
			canonicalDigest(await this.workspaces()) !== record.workspacesDigest
		) {
			throw new Error("Jujutsu working bytes, bookmarks, or workspaces changed after preparation");
		}
		const result = await authority.publish({
			markerDigest: prepared.markerDigest,
			outcome: "LocalCommitCreated",
			summaryArtifact: `transactions/jj/${record.transactionId}/recorded.json`,
			at: new Date().toISOString(),
			publish: async (marker) => {
				this.assertMarker(marker, prepared);
				const before = await this.readOnlySnapshot(record.subject.observation.policyDigest);
				if (
					before.observation.operationId !== record.expectedOperationId ||
					before.treeDigest !== record.treeDigest ||
					observationSubjectDigest(before.observation) !== observationSubjectDigest(record.subject.observation)
				) {
					throw new Error("Jujutsu subject changed immediately before publication");
				}
				const commitEnvironment = sanitizedJjEnvironment(process.env, true);
				commitEnvironment.JJ_USER = record.userName;
				commitEnvironment.JJ_EMAIL = record.userEmail;
				await this.required(
					["commit", "--ignore-working-copy", "-m", prepared.authorization.message.text],
					undefined,
					commitEnvironment,
				);
				const operation = await this.operation();
				if (operation.parents.length !== 1 || operation.parents[0] !== record.expectedOperationId) {
					throw new Error("Jujutsu commit did not create the exact expected successor operation");
				}
				const finalized = await this.revision("@-");
				const child = await this.revision("@");
				this.verifySuccessor(record, finalized, child, prepared.authorization.message.text);
				await this.assertTopologyAndBytes(record);
				const recorded = decode(CommitRecordedSchema, {
					schemaVersion: 1,
					backend: "jj",
					transactionId: record.transactionId,
					authorizationDigest: record.authorizationDigest,
					subjectDigest: record.subjectDigest,
					commitId: finalized.commitId,
					operationId: operation.id,
					finalizedChangeId: finalized.changeId,
					childCommitId: child.commitId,
					childChangeId: child.changeId,
					treeDigest: finalized.treeDigest,
					messageDigest: record.messageDigest,
					recordedAt: new Date().toISOString(),
				}) as JjCommitRecorded;
				await this.store.writeImmutableArtifact(
					this.ref,
					`transactions/jj/${record.transactionId}/recorded.json`,
					Buffer.from(canonicalJson(recorded)),
				);
				return recorded;
			},
			abortPreparation: async (marker, kind) => {
				this.assertMarker(marker, prepared);
				await this.store.writeImmutableArtifact(
					this.ref,
					`transactions/jj/${record.transactionId}/aborted.json`,
					Buffer.from(canonicalJson({ schemaVersion: 1, transactionId: record.transactionId, control: kind })),
				);
			},
			align: async (recorded) => this.align(record, recorded),
		});
		return result;
	}

	async recover(guard: RecoveryLeaseGuard): Promise<{ status: "None" | "Aborted" | "Committed"; commitId?: string }> {
		let result: { status: "None" | "Aborted" | "Committed"; commitId?: string } | undefined;
		let recoveryError: unknown;
		try {
			guard.assert(this.repository.repositoryId, this.ref.runId);
			result = await this.recoverWithLeases();
		} catch (error) {
			recoveryError = error;
		}
		let releaseError: unknown;
		try {
			await guard.release();
		} catch (error) {
			releaseError = error;
		}
		if (recoveryError || releaseError) {
			throw new AggregateError(
				[recoveryError, releaseError].filter((error) => error !== undefined),
				"Jujutsu recovery or recovery-lease release failed",
			);
		}
		if (result === undefined) throw new Error("Jujutsu recovery completed without a result");
		return result;
	}

	private async recoverWithLeases(): Promise<{ status: "None" | "Aborted" | "Committed"; commitId?: string }> {
		const marker = await this.store.readPublicationMarker(this.ref);
		if (!marker) return this.recoverMarkerlessPrepared();
		const payload = marker.payload as Record<string, unknown>;
		if (
			payload?.kind !== "jj" ||
			typeof payload.transactionId !== "string" ||
			typeof payload.preparedPath !== "string" ||
			typeof payload.preparedDigest !== "string"
		) {
			throw new Error("Jujutsu publication marker payload is malformed");
		}
		const bytes = await this.store.readArtifact(this.ref, payload.preparedPath);
		if (createHash("sha256").update(bytes).digest("hex") !== payload.preparedDigest) {
			throw new Error("Jujutsu prepared artifact digest mismatch");
		}
		const prepared = decode(JjCommitPreparedSchema, JSON.parse(bytes.toString("utf8")));
		if (
			prepared.transactionId !== payload.transactionId ||
			(await realpath(this.repository.root)) !== prepared.root ||
			(await realpath(this.repository.sharedRoot)) !== prepared.sharedRoot
		) {
			throw new Error("Jujutsu preparation belongs to another repository");
		}
		const currentOperation = await this.operation();
		if (marker.phase === "prepared") {
			// Pre-operation abort intentionally leaves Active state so a fresh authorization may be created.
			if (currentOperation.id !== prepared.expectedOperationId) {
				throw new Error("Prepared Jujutsu operation changed before recovery");
			}
			await this.writeRecoveryArtifact(prepared, "aborted-pre-operation");
			await this.store.clearPreparedPublicationMarker(this.ref, marker.digest);
			return { status: "Aborted" };
		}
		if (marker.phase === "publishing" && currentOperation.id === prepared.expectedOperationId) {
			await this.store.withPublicationControl(this.ref, marker.digest, async (context) => {
				if (context.state.lifecycle !== "Active") throw new Error("Pre-operation recovery found non-active lifecycle");
				await this.writeRecoveryArtifact(prepared, "aborted-operation-not-created");
				await context.clearMarker();
			});
			return { status: "Aborted" };
		}
		let recorded: JjCommitRecorded;
		let alignmentMarkerDigest = marker.digest;
		if (marker.phase === "publishing") {
			if (currentOperation.parents.length !== 1 || currentOperation.parents[0] !== prepared.expectedOperationId) {
				throw new Error("Jujutsu operation graph diverged from the prepared successor");
			}
			recorded = await this.verifyAndBuildRecorded(prepared, currentOperation.id);
			alignmentMarkerDigest = await this.store.withPublicationControl(this.ref, marker.digest, async (context) => {
				const durable = await this.ensureRecorded(prepared, recorded);
				if (context.state.lifecycle === "Active") {
					const completed = completeRun(
						context.state,
						"LocalCommitCreated",
						`transactions/jj/${prepared.transactionId}/recorded.json`,
						new Date().toISOString(),
					);
					await this.store.appendTransition(this.ref, "OutcomeRecorded", completed, completed.updatedAt);
				} else if (context.state.lifecycle !== "Completed" || context.state.outcome !== "LocalCommitCreated") {
					throw new Error("Jujutsu successor has contradictory lifecycle state");
				}
				if (durable.operationId !== currentOperation.id) throw new Error("Jujutsu record operation mismatch");
				return context.markAligning();
			});
		} else {
			const state = await this.store.load(this.ref);
			if (state.lifecycle !== "Completed" || state.outcome !== "LocalCommitCreated") {
				throw new Error("Aligning Jujutsu transaction is not terminal");
			}
			recorded = await this.verifyAndBuildRecorded(prepared, currentOperation.id);
			await this.ensureRecorded(prepared, recorded);
		}
		await this.alignReadOnly(prepared, recorded);
		await this.store.clearAligningPublicationMarker(this.ref, alignmentMarkerDigest);
		return { status: "Committed", commitId: recorded.commitId };
	}

	private async align(prepared: JjCommitPrepared, recorded: JjCommitRecorded): Promise<void> {
		const beforeOperation = (await this.operation()).id;
		await this.required(["status"]);
		const afterOperation = (await this.operation()).id;
		if (beforeOperation !== recorded.operationId || afterOperation !== beforeOperation) {
			throw new Error("Jujutsu status changed the publication successor operation");
		}
		const finalized = await this.revision("@-");
		const child = await this.revision("@");
		this.verifySuccessor(prepared, finalized, child, undefined);
		await this.assertTopologyAndBytes(prepared);
	}

	/** Recovery alignment calls only helpers whose jj argv includes --ignore-working-copy. */
	private async alignReadOnly(prepared: JjCommitPrepared, recorded: JjCommitRecorded): Promise<void> {
		const operation = await this.operation();
		if (operation.id !== recorded.operationId) throw new Error("Jujutsu operation advanced before recovery alignment");
		const finalized = await this.revision("@-");
		const child = await this.revision("@");
		this.verifySuccessor(prepared, finalized, child, undefined);
		await this.assertTopologyAndBytes(prepared);
	}

	private async verifyAndBuildRecorded(
		prepared: JjCommitPrepared,
		operationId: string,
	): Promise<JjCommitRecorded> {
		const finalized = await this.revision("@-");
		const child = await this.revision("@");
		this.verifySuccessor(prepared, finalized, child, undefined);
		await this.assertTopologyAndBytes(prepared);
		return decode(CommitRecordedSchema, {
			schemaVersion: 1,
			backend: "jj",
			transactionId: prepared.transactionId,
			authorizationDigest: prepared.authorizationDigest,
			subjectDigest: prepared.subjectDigest,
			commitId: finalized.commitId,
			operationId,
			finalizedChangeId: finalized.changeId,
			childCommitId: child.commitId,
			childChangeId: child.changeId,
			treeDigest: finalized.treeDigest,
			messageDigest: prepared.messageDigest,
			recordedAt: new Date().toISOString(),
		}) as JjCommitRecorded;
	}

	private async ensureRecorded(
		prepared: JjCommitPrepared,
		expected: JjCommitRecorded,
	): Promise<JjCommitRecorded> {
		const path = `transactions/jj/${prepared.transactionId}/recorded.json`;
		try {
			const existing = decode(CommitRecordedSchema, JSON.parse((await this.store.readArtifact(this.ref, path)).toString("utf8")));
			if (
				existing.backend !== "jj" ||
				existing.transactionId !== expected.transactionId ||
				existing.authorizationDigest !== expected.authorizationDigest ||
				existing.subjectDigest !== expected.subjectDigest ||
				existing.commitId !== expected.commitId ||
				existing.operationId !== expected.operationId ||
				existing.finalizedChangeId !== expected.finalizedChangeId ||
				existing.childCommitId !== expected.childCommitId ||
				existing.childChangeId !== expected.childChangeId ||
				existing.treeDigest !== expected.treeDigest ||
				existing.messageDigest !== expected.messageDigest
			) {
				throw new Error("Existing Jujutsu commit record contradicts successor");
			}
			return existing;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await this.store.writeImmutableArtifact(this.ref, path, Buffer.from(canonicalJson(expected)));
		return expected;
	}

	private async recoverMarkerlessPrepared(): Promise<{ status: "None" | "Aborted" }> {
		const root = join(this.ref.directory, "artifacts", "transactions", "jj");
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
			const path = `transactions/jj/${transactionId}/prepared.json`;
			let prepared: JjCommitPrepared;
			try {
				prepared = decode(
					JjCommitPreparedSchema,
					JSON.parse((await this.store.readArtifact(this.ref, path)).toString("utf8")),
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (
				(await realpath(this.repository.root)) !== prepared.root ||
				(await realpath(this.repository.sharedRoot)) !== prepared.sharedRoot
			) {
				throw new Error("Markerless Jujutsu preparation belongs to another repository");
			}
			if ((await this.operation()).id !== prepared.expectedOperationId) {
				throw new Error("Markerless Jujutsu preparation has a moved operation and requires manual inspection");
			}
			await this.writeRecoveryArtifact(prepared, "aborted-markerless-pre-operation");
			recovered = true;
		}
		return { status: recovered ? "Aborted" : "None" };
	}

	private async writeRecoveryArtifact(prepared: JjCommitPrepared, outcome: string): Promise<void> {
		const path = `transactions/jj/${prepared.transactionId}/recovery-${outcome}.json`;
		const bytes = Buffer.from(canonicalJson({ schemaVersion: 1, transactionId: prepared.transactionId, outcome }));
		try {
			await this.store.writeImmutableArtifact(this.ref, path, bytes);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!(await this.store.readArtifact(this.ref, path)).equals(bytes)) {
				throw new Error("Jujutsu recovery artifact contradicts prior recovery");
			}
		}
	}

	private verifySuccessor(
		prepared: JjCommitPrepared,
		finalized: RevisionState,
		child: RevisionState,
		message: string | undefined,
	): void {
		const normalizedDescription = finalized.description.endsWith("\n")
			? finalized.description.slice(0, -1)
			: undefined;
		if (
			finalized.changeId !== prepared.expectedChangeId ||
			finalized.commitId === prepared.expectedCommitId ||
			finalized.treeDigest !== prepared.treeDigest ||
			finalized.conflicted ||
			finalized.parentCommitIds.join("\0") !== prepared.expectedParentCommitIds.join("\0") ||
			finalized.authorName !== prepared.userName ||
			finalized.authorEmail !== prepared.userEmail ||
			normalizedDescription === undefined ||
			createHash("sha256").update(normalizedDescription).digest("hex") !== prepared.messageDigest ||
			(message !== undefined && normalizedDescription !== message) ||
			child.description !== "" ||
			child.conflicted ||
			child.parentCommitIds.length !== 1 ||
			child.parentCommitIds[0] !== finalized.commitId ||
			child.treeDigest !== finalized.treeDigest ||
			child.changedPaths.length !== 0 ||
			child.changeId === finalized.changeId ||
			child.commitId === finalized.commitId
		) {
			throw new Error("Jujutsu finalized commit or empty child contradicts preparation");
		}
	}

	private async assertTopologyAndBytes(record: JjCommitPrepared): Promise<void> {
		if (
			canonicalDigest(await this.bookmarks()) !== record.bookmarksDigest ||
			canonicalDigest(await this.workspaces()) !== record.workspacesDigest ||
			(await digestPaths(this.repository.root, record.workingPaths)) !== record.workingDigest
		) {
			throw new Error("Jujutsu publication changed bookmarks, workspaces, or working bytes");
		}
	}

	private async readOnlySnapshot(policyDigest: string): Promise<{ observation: JjObservationSubject; treeDigest: string }> {
		const operation = await this.operation();
		const revision = await this.revision("@");
		const observation: JjObservationSubject = buildJjObservationSubject({
			repository: this.repository,
			root: await realpath(this.repository.root),
			policyDigest,
			operationId: operation.id,
			identity: revision,
			changedPaths: revision.changedPaths,
		});
		return { observation, treeDigest: revision.treeDigest };
	}

	private async revision(revset: string): Promise<RevisionState> {
		const fields = (
			await this.required([
				"--ignore-working-copy",
				"log",
				"-r",
				revset,
				"--no-graph",
				"-T",
				'change_id.normal_hex() ++ "\\t" ++ commit_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ if(conflict, "true", "false") ++ "\\t" ++ author.name() ++ "\\t" ++ author.email() ++ "\\n"',
			])
		).trimEnd().split("\t", 6);
		if (fields.length !== 6) throw new Error(`Malformed Jujutsu revision output for ${revset}`);
		const [changeId, commitId, parents, conflict, authorName, authorEmail] = fields;
		const descriptionWithNul = await this.required([
			"--ignore-working-copy",
			"log",
			"-r",
			commitId,
			"--no-graph",
			"-T",
			'description ++ "\\0"',
		]);
		const tree = await this.required(["--ignore-working-copy", "debug", "tree", "-r", commitId]);
		const changed = await this.required([
			"--ignore-working-copy",
			"diff",
			"-r",
			commitId,
			"-T",
			'path ++ "\\0"',
		]);
		return {
			changeId,
			commitId,
			parentCommitIds: parents ? parents.split(",") : [],
			description: descriptionWithNul.endsWith("\0") ? descriptionWithNul.slice(0, -1) : descriptionWithNul,
			authorName,
			authorEmail,
			conflicted: conflict === "true",
			treeDigest: jjNativeTreeDigest(tree),
			changedPaths: nulFields(changed).sort(),
		};
	}

	private async operation(): Promise<{ id: string; parents: string[] }> {
		const output = (
			await this.required([
				"--ignore-working-copy",
				"op",
				"log",
				"-n",
				"1",
				"--no-graph",
				"-T",
				'id ++ "\\t" ++ parents.map(|p| p.id()).join(",") ++ "\\n"',
			])
		).trim();
		const [id, parents = ""] = output.split("\t", 2);
		if (!id) throw new Error("Malformed Jujutsu operation output");
		return { id, parents: parents ? parents.split(",") : [] };
	}

	private async workingPaths(commitId: string, candidatePaths: readonly string[], signal?: AbortSignal): Promise<string[]> {
		const listed = nulFields(
			await this.required(
				["--ignore-working-copy", "file", "list", "-r", commitId, "-T", 'path ++ "\\0"'],
				signal,
			),
		);
		return [...new Set([...listed, ...candidatePaths])].sort();
	}

	private async bookmarks(signal?: AbortSignal): Promise<string> {
		return this.required(
			[
				"--ignore-working-copy",
				"bookmark",
				"list",
				"--all",
				"-T",
				'name ++ "\\t" ++ remote ++ "\\t" ++ normal_target.commit_id() ++ "\\n"',
			],
			signal,
		);
	}

	private async workspaces(signal?: AbortSignal): Promise<string> {
		return this.required(
			["--ignore-working-copy", "workspace", "list", "-T", 'name ++ "\\t" ++ root ++ "\\n"'],
			signal,
		);
	}

	private assertPrepared(prepared: PreparedJjTransaction): void {
		if (
			preparedTransactions.get(prepared) !==
			canonicalDigest({
				record: prepared.record,
				recordPath: prepared.recordPath,
				recordDigest: prepared.recordDigest,
				markerDigest: prepared.markerDigest,
			})
		) {
			throw new Error("Jujutsu preparation was not minted by this package or was modified");
		}
		assertCommitAuthorization(prepared.authorization);
	}

	private assertMarker(marker: unknown, prepared: PreparedJjTransaction): void {
		const value = marker as Record<string, unknown>;
		if (
			value?.kind !== "jj" ||
			value.transactionId !== prepared.record.transactionId ||
			value.preparedPath !== prepared.recordPath ||
			value.preparedDigest !== prepared.recordDigest
		) {
			throw new Error("Publication marker does not match Jujutsu preparation");
		}
	}

	private async resolveIdentity(signal?: AbortSignal): Promise<{ name: string; email: string }> {
		const env = sanitizedJjEnvironment(process.env, false);
		const name = (await this.required(["config", "get", "user.name"], signal, env)).trim();
		const email = (await this.required(["config", "get", "user.email"], signal, env)).trim();
		if (!name || !email) throw new Error("Jujutsu user.name/user.email is missing; configure a jj identity");
		return { name, email };
	}

	private requireAuthority(): RunAuthority {
		if (!this.authority) throw new Error("Jujutsu transaction recovery service cannot prepare or publish");
		return this.authority;
	}

	private requireTrees(): BackendTreeService {
		if (!this.trees) throw new Error("Jujutsu transaction recovery service cannot prepare or publish");
		return this.trees;
	}

	private effectCommand(label: string, args: readonly string[]): Promise<string> {
		return this.requireAuthority().runEffect(`jj:${label}`, (signal) => this.required(args, signal));
	}

	private required(
		args: readonly string[],
		signal?: AbortSignal,
		env: NodeJS.ProcessEnv = sanitizedJjEnvironment(process.env, true),
	): Promise<string> {
		const safeArgs = ["--color", "never", "--no-pager", ...args];
		return this.runner("jj", safeArgs, {
			cwd: this.repository.root,
			timeoutMs: 60_000,
			signal,
			env,
		}).then((result) => {
			if (result.code !== 0) throw new Error(`jj ${safeArgs.join(" ")} failed: ${result.stderr.trim()}`);
			return result.stdout;
		});
	}
}

export function sanitizedJjEnvironment(
	environment: NodeJS.ProcessEnv,
	disableConfig: boolean,
): NodeJS.ProcessEnv {
	const denied = new Set([
		"JJ_REPO",
		"JJ_WORKSPACE",
		"JJ_OP_ID",
		"JJ_CONFIG",
		"JJ_TIMESTAMP",
		"JJ_RANDOMNESS_SEED",
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	]);
	const result: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(environment)) {
		if (
			value === undefined ||
			denied.has(name) ||
			name.startsWith("GIT_CONFIG_") ||
			name.startsWith("JJ_OP_") ||
			(disableConfig && (name === "JJ_USER" || name === "JJ_EMAIL"))
		) {
			continue;
		}
		result[name] = value;
	}
	if (disableConfig) result.JJ_CONFIG = "";
	return result;
}
