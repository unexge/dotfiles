import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { ensureDirectoryDurable, syncParentDirectory, writeAtomic, writeImmutable } from "./atomic.ts";
import { canonicalDigest, canonicalJson } from "../policy/canonical-json.ts";
import {
	ControlRecordSchema,
	ControlsFileSchema,
	MutationArtifactSchema,
	PhaseCheckpointSchema,
	TransitionEventSchema,
	decode,
	decodeRunProjection,
	type ControlRecord,
	type ControlsFile,
	type MutationArtifact,
	type PhaseCheckpoint,
	type RunProjection,
	type TransitionEvent,
} from "./schemas.ts";

export type TransitionKind = TransitionEvent["kind"];

export interface RunRef {
	directory: string;
	runId: string;
	repositoryId: string;
	backend: "git" | "jj";
}

export interface PublicationControlContext {
	state: RunProjection;
	controls: ControlsFile;
	marker: unknown;
	markPublishing(): Promise<void>;
	markAligning(): Promise<string>;
	clearMarker(): Promise<void>;
}

interface PublicationMarkerEnvelope {
	schemaVersion: 1;
	phase: "prepared" | "publishing" | "aligning";
	payload: unknown;
}

export class AlreadyTerminalError extends Error {
	constructor() {
		super("Run is already terminal");
		this.name = "AlreadyTerminalError";
	}
}

export class PublicationRecoveryRequiredError extends Error {
	constructor(message = "Outstanding publication must be recovered before controls can be admitted", cause?: unknown) {
		super(message, { cause });
		this.name = "PublicationRecoveryRequiredError";
	}
}

export class StoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StoreError";
	}
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function safeRelativePath(path: string): string {
	const clean = normalize(path);
	if (isAbsolute(clean) || clean === ".." || clean.startsWith(`..${sep}`)) {
		throw new StoreError(`Artifact path escapes run directory: ${path}`);
	}
	return clean;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function eventName(revision: number): string {
	return `${String(revision).padStart(12, "0")}.json`;
}

async function directories(path: string): Promise<string[]> {
	try {
		return (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export class RunStore {
	readonly root: string;

	constructor(agentDir: string) {
		this.root = join(agentDir, "pi-deep-work", "runs");
	}

	async create(backend: "git" | "jj", queued: RunProjection): Promise<RunRef> {
		if (queued.lifecycle !== "Queued" || queued.lastEventRevision !== 0) {
			throw new StoreError("New runs must start as Queued at event revision 0");
		}
		const repositoryDirectory = `${backend}-${queued.repositoryId}`;
		const directory = join(this.root, repositoryDirectory, queued.runId);
		await ensureDirectoryDurable(join(directory, "events"));
		const projection = decodeRunProjection({ ...queued, lastEventRevision: 1 });
		const event = decode(TransitionEventSchema, {
			schemaVersion: 1,
			runId: queued.runId,
			revision: 1,
			previousRevision: 0,
			kind: "RunCreated",
			at: queued.updatedAt,
			projection,
		});
		await writeImmutable(join(directory, "events", eventName(1)), json(event));
		await writeAtomic(join(directory, "state.json"), json(projection));
		await writeImmutable(
			join(directory, "controls.json"),
			json({ schemaVersion: 1, runId: queued.runId, revision: 0, requests: [] }),
		);
		return { directory, runId: queued.runId, repositoryId: queued.repositoryId, backend };
	}

	async appendTransition(ref: RunRef, kind: TransitionKind, next: RunProjection, at: string): Promise<RunProjection> {
		const current = await this.load(ref);
		const revision = current.lastEventRevision + 1;
		if (next.runId !== current.runId || next.repositoryId !== current.repositoryId) {
			throw new StoreError("Transition cannot change run or repository identity");
		}
		if (next.lastEventRevision !== revision) {
			throw new StoreError(`Transition projection must use event revision ${revision}`);
		}
		const projection = decodeRunProjection(next);
		const event = decode(TransitionEventSchema, {
			schemaVersion: 1,
			runId: current.runId,
			revision,
			previousRevision: current.lastEventRevision,
			kind,
			at,
			projection,
		});
		try {
			await writeImmutable(join(ref.directory, "events", eventName(revision)), json(event));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new StoreError(`Concurrent transition attempted event revision ${revision}`);
			}
			throw error;
		}
		await writeAtomic(join(ref.directory, "state.json"), json(projection));
		return projection;
	}

	async load(ref: RunRef): Promise<RunProjection> {
		const stateText = await readOptional(join(ref.directory, "state.json"));
		const eventFiles = (await readdir(join(ref.directory, "events"))).filter((name) => name.endsWith(".json")).sort();
		if (eventFiles.length === 0) throw new StoreError(`run has no events: ${ref.runId}`);
		const events: TransitionEvent[] = [];
		for (const file of eventFiles) {
			const value = JSON.parse(await readFile(join(ref.directory, "events", file), "utf8"));
			events.push(decode(TransitionEventSchema, value));
		}
		for (let index = 0; index < events.length; index++) {
			const event = events[index];
			const expected = index + 1;
			if (
				event.revision !== expected ||
				event.previousRevision !== index ||
				event.runId !== ref.runId ||
				event.projection.runId !== ref.runId ||
				event.projection.repositoryId !== ref.repositoryId ||
				event.projection.lastEventRevision !== event.revision
			) {
				throw new StoreError(`Contradictory event history at revision ${event.revision}`);
			}
		}
		const latest = events.at(-1)!;
		if (!stateText) {
			await writeAtomic(join(ref.directory, "state.json"), json(latest.projection));
			await this.ensureControls(ref);
			return latest.projection;
		}
		const state = decodeRunProjection(JSON.parse(stateText));
		if (state.runId !== ref.runId || state.repositoryId !== ref.repositoryId) {
			throw new StoreError("projection identity does not match its run directory");
		}
		await this.ensureControls(ref);
		if (state.lastEventRevision === latest.revision) {
			if (canonicalJson(state) !== canonicalJson(latest.projection)) {
				throw new StoreError("projection does not match the authoritative event at the same revision");
			}
			return latest.projection;
		}
		if (state.lastEventRevision + 1 === latest.revision && latest.previousRevision === state.lastEventRevision) {
			await writeAtomic(join(ref.directory, "state.json"), json(latest.projection));
			return latest.projection;
		}
		throw new StoreError(
			`projection/event gap is not safely reconcilable: state ${state.lastEventRevision}, event ${latest.revision}`,
		);
	}

	async writeCheckpoint(ref: RunRef, checkpoint: PhaseCheckpoint): Promise<string> {
		const value = decode(PhaseCheckpointSchema, checkpoint);
		if (value.runId !== ref.runId) throw new StoreError("Checkpoint run ID mismatch");
		if ("mutation" in value) {
			const artifactPath = join(ref.directory, "artifacts", safeRelativePath(value.mutation.artifact));
			let bytes: Buffer;
			try {
				bytes = await readFile(artifactPath);
			} catch (error) {
				throw new StoreError(`Mutation checkpoint artifact is unavailable: ${String(error)}`);
			}
			const artifactDigest = createHash("sha256").update(bytes).digest("hex");
			if (artifactDigest !== value.mutation.artifactDigest) {
				throw new StoreError("Mutation checkpoint artifact digest mismatch");
			}
			let artifact: MutationArtifact;
			try {
				artifact = decode(MutationArtifactSchema, JSON.parse(bytes.toString("utf8")));
			} catch (error) {
				throw new StoreError(`Mutation checkpoint artifact is invalid: ${String(error)}`);
			}
			const paths = artifact.mutations.map((mutation) => mutation.path);
			const sortedPaths = [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
			if (
				artifact.phase !== value.phase ||
				artifact.mutationDigest !== value.mutation.mutationDigest ||
				artifact.mutations.length !== value.mutation.fileCount ||
				new Set(paths).size !== paths.length ||
				paths.some((path, index) => path !== sortedPaths[index]) ||
				canonicalDigest(artifact.mutations) !== artifact.mutationDigest
			) {
				throw new StoreError("Mutation checkpoint metadata contradicts its artifact");
			}
		}
		const path = join(
			ref.directory,
			"checkpoints",
			value.attemptId,
			`${String(value.sequence).padStart(8, "0")}-${value.phase}.json`,
		);
		const content = json(value);
		try {
			await writeImmutable(path, content);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await readFile(path, "utf8");
			if (canonicalJson(JSON.parse(existing)) !== canonicalJson(value)) {
				throw new StoreError(`Checkpoint already exists with contradictory content: ${path}`);
			}
		}
		return path;
	}

	async readCheckpoint(
		ref: RunRef,
		attemptId: string,
		sequence: number,
		phase: string,
	): Promise<PhaseCheckpoint | undefined> {
		const path = join(
			ref.directory,
			"checkpoints",
			attemptId,
			`${String(sequence).padStart(8, "0")}-${phase}.json`,
		);
		const text = await readOptional(path);
		return text ? decode(PhaseCheckpointSchema, JSON.parse(text)) : undefined;
	}

	async appendControl(ref: RunRef, kind: ControlRecord["kind"], requestedAt: string): Promise<ControlRecord> {
		return this.withControlLock(ref, async () => {
			const state = await this.load(ref);
			// Terminal lifecycle always wins over a stale publishing/alignment marker; recovery must never republish it.
			if (state.lifecycle === "Completed" || state.lifecycle === "Cancelled" || state.lifecycle === "Failed") {
				throw new AlreadyTerminalError();
			}
			let publication: Awaited<ReturnType<RunStore["readPublicationMarker"]>>;
			try {
				publication = await this.readPublicationMarker(ref);
			} catch (error) {
				throw new PublicationRecoveryRequiredError("Cannot inspect outstanding publication marker", error);
			}
			if (publication?.phase === "publishing") throw new PublicationRecoveryRequiredError();
			const path = join(ref.directory, "controls.json");
			const current = await this.controls(ref);
			const request = decode(ControlRecordSchema, {
				schemaVersion: 1,
				runId: ref.runId,
				revision: current.revision + 1,
				kind,
				requestedAt,
			});
			const next: ControlsFile = {
				schemaVersion: 1,
				runId: ref.runId,
				revision: request.revision,
				requests: [...current.requests, request],
			};
			await writeAtomic(path, json(next));
			return request;
		});
	}

	async installPublicationMarker(ref: RunRef, marker: unknown): Promise<{ path: string; digest: string }> {
		return this.withControlLock(ref, async () => {
			const state = await this.load(ref);
			if (state.lifecycle !== "Active") throw new StoreError("Publication marker requires an Active run");
			const path = this.publicationMarkerPath(ref);
			if (await readOptional(path)) throw new PublicationRecoveryRequiredError();
			const bytes = Buffer.from(json({ schemaVersion: 1, phase: "prepared", payload: marker }));
			await writeImmutable(path, bytes);
			return { path, digest: createHash("sha256").update(bytes).digest("hex") };
		});
	}

	async readPublicationMarker(
		ref: RunRef,
	): Promise<{ phase: PublicationMarkerEnvelope["phase"]; payload: unknown; digest: string } | undefined> {
		const text = await readOptional(this.publicationMarkerPath(ref));
		if (!text) return undefined;
		const value = JSON.parse(text) as Partial<PublicationMarkerEnvelope>;
		if (
			value.schemaVersion !== 1 ||
			(value.phase !== "prepared" && value.phase !== "publishing" && value.phase !== "aligning") ||
			!("payload" in value)
		) {
			throw new StoreError("Publication marker is malformed");
		}
		return { phase: value.phase, payload: value.payload, digest: createHash("sha256").update(text).digest("hex") };
	}

	async withPublicationControl<T>(
		ref: RunRef,
		expectedMarkerDigest: string,
		action: (context: PublicationControlContext) => Promise<T>,
	): Promise<T> {
		return this.withControlLock(ref, async () => {
			const marker = await this.readPublicationMarker(ref);
			if (!marker || marker.digest !== expectedMarkerDigest) {
				throw new PublicationRecoveryRequiredError();
			}
			const state = await this.load(ref);
			const controls = await this.controls(ref);
			let currentDigest = marker.digest;
			let cleared = false;
			const markPublishing = async () => {
				if (cleared) throw new StoreError("Publication marker is already cleared");
				const current = await this.readPublicationMarker(ref);
				if (!current || current.digest !== currentDigest || current.phase !== "prepared") {
					throw new StoreError("Publication marker changed before publishing");
				}
				const bytes = Buffer.from(json({ schemaVersion: 1, phase: "publishing", payload: current.payload }));
				await writeAtomic(this.publicationMarkerPath(ref), bytes);
				currentDigest = createHash("sha256").update(bytes).digest("hex");
			};
			const markAligning = async (): Promise<string> => {
				if (cleared) throw new StoreError("Publication marker is already cleared");
				const current = await this.readPublicationMarker(ref);
				if (!current || current.digest !== currentDigest || current.phase !== "publishing") {
					throw new StoreError("Publication marker changed before alignment");
				}
				const bytes = Buffer.from(json({ schemaVersion: 1, phase: "aligning", payload: current.payload }));
				await writeAtomic(this.publicationMarkerPath(ref), bytes);
				currentDigest = createHash("sha256").update(bytes).digest("hex");
				return currentDigest;
			};
			const clearMarker = async () => {
				if (cleared) return;
				const current = await this.readPublicationMarker(ref);
				if (!current || current.digest !== currentDigest) {
					throw new StoreError("Publication marker changed before clear");
				}
				await unlink(this.publicationMarkerPath(ref));
				await syncParentDirectory(this.publicationMarkerPath(ref));
				cleared = true;
			};
			return action({ state, controls, marker: marker.payload, markPublishing, markAligning, clearMarker });
		});
	}

	async clearAligningPublicationMarker(ref: RunRef, expectedDigest: string): Promise<void> {
		await this.withControlLock(ref, async () => {
			const marker = await this.readPublicationMarker(ref);
			if (!marker || marker.phase !== "aligning" || marker.digest !== expectedDigest) {
				throw new PublicationRecoveryRequiredError();
			}
			await unlink(this.publicationMarkerPath(ref));
			await syncParentDirectory(this.publicationMarkerPath(ref));
		});
	}

	async clearPreparedPublicationMarker(ref: RunRef, expectedDigest: string): Promise<void> {
		await this.withControlLock(ref, async () => {
			const marker = await this.readPublicationMarker(ref);
			if (!marker || marker.phase !== "prepared" || marker.digest !== expectedDigest) {
				throw new PublicationRecoveryRequiredError();
			}
			await unlink(this.publicationMarkerPath(ref));
			await syncParentDirectory(this.publicationMarkerPath(ref));
		});
	}

	async assertNoPublicationMarker(ref: RunRef): Promise<void> {
		try {
			if (await this.readPublicationMarker(ref)) throw new PublicationRecoveryRequiredError();
		} catch (error) {
			if (error instanceof PublicationRecoveryRequiredError) throw error;
			throw new PublicationRecoveryRequiredError();
		}
	}

	async latestObservedControlRevision(ref: RunRef): Promise<number> {
		const eventFiles = (await readdir(join(ref.directory, "events"))).filter((name) => name.endsWith(".json")).sort().reverse();
		for (const name of eventFiles) {
			const event = decode(TransitionEventSchema, JSON.parse(await readFile(join(ref.directory, "events", name), "utf8")));
			if ("observedControlRevision" in event.projection) return event.projection.observedControlRevision;
		}
		return 0;
	}

	async controls(ref: RunRef): Promise<ControlsFile> {
		await this.ensureControls(ref);
		const controls = decode(ControlsFileSchema, JSON.parse(await readFile(join(ref.directory, "controls.json"), "utf8")));
		if (controls.runId !== ref.runId || controls.revision !== controls.requests.length) {
			throw new StoreError("Control file revision or run identity is inconsistent");
		}
		for (let index = 0; index < controls.requests.length; index++) {
			const request = controls.requests[index];
			if (request.runId !== ref.runId || request.revision !== index + 1) {
				throw new StoreError(`Control history is contradictory at revision ${request.revision}`);
			}
		}
		return controls;
	}

	async readArtifact(ref: RunRef, path: string): Promise<Buffer> {
		return readFile(join(ref.directory, "artifacts", safeRelativePath(path)));
	}

	async readOptionalArtifact(ref: RunRef, path: string): Promise<Buffer | undefined> {
		try {
			return await readFile(join(ref.directory, "artifacts", safeRelativePath(path)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async writeArtifact(ref: RunRef, path: string, content: string | Buffer): Promise<{ path: string; digest: string }> {
		return this.writeArtifactWith(ref, path, content, writeAtomic);
	}

	async writeImmutableArtifact(
		ref: RunRef,
		path: string,
		content: string | Buffer,
	): Promise<{ path: string; digest: string }> {
		return this.writeArtifactWith(ref, path, content, writeImmutable);
	}

	private async writeArtifactWith(
		ref: RunRef,
		path: string,
		content: string | Buffer,
		write: (path: string, content: string | Buffer) => Promise<void>,
	): Promise<{ path: string; digest: string }> {
		const target = join(ref.directory, "artifacts", safeRelativePath(path));
		const bytes = typeof content === "string" ? Buffer.from(content) : content;
		await write(target, bytes);
		return { path: target, digest: createHash("sha256").update(bytes).digest("hex") };
	}

	async list(repositoryId?: string): Promise<Array<{ ref: RunRef; state: RunProjection }>> {
		const values: Array<{ ref: RunRef; state: RunProjection }> = [];
		for (const repositoryDirectory of await directories(this.root)) {
			// Repository directories are `<git|jj>-<64 lowercase hex>`; the digest schema excludes further dashes.
			const separator = repositoryDirectory.indexOf("-");
			const backend = repositoryDirectory.slice(0, separator);
			const directoryRepositoryId = repositoryDirectory.slice(separator + 1);
			if (backend !== "git" && backend !== "jj") continue;
			if (repositoryId && directoryRepositoryId !== repositoryId) continue;
			for (const candidate of await directories(join(this.root, repositoryDirectory))) {
				const ref: RunRef = {
					directory: join(this.root, repositoryDirectory, candidate),
					runId: candidate,
					repositoryId: directoryRepositoryId,
					backend,
				};
				try {
					values.push({ ref, state: await this.load(ref) });
				} catch {
					// One malformed or partial run must not hide other valid runs in the repository listing.
				}
			}
		}
		return values.sort((left, right) => right.state.updatedAt.localeCompare(left.state.updatedAt));
	}

	async find(runId: string): Promise<RunRef> {
		const matches: RunRef[] = [];
		for (const repositoryDirectory of await directories(this.root)) {
			for (const candidate of await directories(join(this.root, repositoryDirectory))) {
				if (candidate !== runId && !candidate.startsWith(runId)) continue;
				const directory = join(this.root, repositoryDirectory, candidate);
				const separator = repositoryDirectory.indexOf("-");
				const backend = repositoryDirectory.slice(0, separator);
				if (backend !== "git" && backend !== "jj") continue;
				let stateText = await readOptional(join(directory, "state.json"));
				if (!stateText) {
					const firstEvent = await readOptional(join(directory, "events", eventName(1)));
					if (!firstEvent) continue;
					stateText = JSON.stringify(decode(TransitionEventSchema, JSON.parse(firstEvent)).projection);
				}
				const state = decodeRunProjection(JSON.parse(stateText));
				matches.push({
					directory,
					runId: candidate,
					repositoryId: state.repositoryId,
					backend,
				});
			}
		}
		if (matches.length === 0) throw new StoreError(`run not found: ${runId}`);
		if (matches.length > 1) throw new StoreError(`run ID is ambiguous: ${runId}`);
		return matches[0];
	}

	private publicationMarkerPath(ref: RunRef): string {
		return join(ref.directory, "publication", "current.json");
	}

	private async ensureControls(ref: RunRef): Promise<void> {
		const path = join(ref.directory, "controls.json");
		if (await readOptional(path)) return;
		try {
			await writeImmutable(path, json({ schemaVersion: 1, runId: ref.runId, revision: 0, requests: [] }));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}

	private async withControlLock<T>(ref: RunRef, action: () => Promise<T>): Promise<T> {
		const lock = join(ref.directory, "controls.lock");
		for (let attempt = 0; attempt < 12_000; attempt++) {
			const token = randomUUID();
			let acquired = false;
			try {
				await writeImmutable(lock, json({ pid: process.pid, token, createdAt: new Date().toISOString() }));
				acquired = true;
				try {
					return await action();
				} finally {
					const owner = await readOptional(lock);
					if (owner && (JSON.parse(owner) as { token?: string }).token === token) {
						await unlink(lock);
						await syncParentDirectory(lock);
					}
				}
			} catch (error) {
				if (acquired) throw error;
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const ownerText = await readOptional(lock);
				let stale = false;
				if (ownerText) {
					try {
						const owner = JSON.parse(ownerText) as { pid?: number };
						stale = typeof owner.pid === "number" && !processIsAlive(owner.pid);
					} catch {
						stale = false;
					}
				}
				if (stale) {
					const quarantine = `${lock}.stale.${randomUUID()}`;
					try {
						await rename(lock, quarantine);
						await syncParentDirectory(lock);
						await unlink(quarantine);
						continue;
					} catch (renameError) {
						if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		const age = await stat(lock).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
		throw new StoreError(`Timed out waiting for control lock (${age}ms old)`);
	}
}
