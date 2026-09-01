import { createHash } from "node:crypto";
import { canonicalDigest } from "../policy/canonical-json.ts";

export interface MutationRecord {
	readonly path: string;
	readonly preimageDigest: string | null;
	readonly resultDigest: string;
}

export interface CompletedMutationPhase {
	readonly schemaVersion: 1;
	readonly phase: string;
	readonly mutations: readonly MutationRecord[];
	readonly mutationDigest: string;
}

interface PendingRecord {
	preimageDigest: string | null;
	resultDigest?: string;
}

interface MutationToken {
	path: string;
	createdRecord: boolean;
}

export class MutationPhaseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MutationPhaseError";
	}
}

function digest(content: Buffer | null): string | null {
	return content === null ? null : createHash("sha256").update(content).digest("hex");
}

export class MutationPhase {
	readonly phase: string;
	private readonly records = new Map<string, PendingRecord>();
	private readonly active = new Map<string, MutationToken>();
	private readonly unsafePaths = new Set<string>();
	private sealed = false;
	private completion?: CompletedMutationPhase;

	constructor(phase: string) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(phase)) throw new MutationPhaseError(`Invalid phase name: ${phase}`);
		this.phase = phase;
	}

	begin(path: string, preimage: Buffer | null): MutationToken {
		if (this.sealed) throw new MutationPhaseError("Mutation phase is already sealed");
		if (this.unsafePaths.size > 0) throw new MutationPhaseError("Mutation phase requires manual inspection");
		if (this.active.has(path)) throw new MutationPhaseError(`Concurrent mutation escaped the shared queue: ${path}`);
		const preimageDigest = digest(preimage);
		let record = this.records.get(path);
		const createdRecord = !record;
		if (!record) {
			record = { preimageDigest };
			this.records.set(path, record);
		} else if (record.resultDigest !== preimageDigest) {
			this.unsafePaths.add(path);
			throw new MutationPhaseError(`Workspace file changed outside the mutation queue: ${path}`);
		}
		const token = { path, createdRecord };
		this.active.set(path, token);
		return token;
	}

	finish(token: MutationToken, result: Buffer): void {
		this.assertToken(token);
		const record = this.records.get(token.path);
		if (!record) throw new MutationPhaseError(`Missing mutation record: ${token.path}`);
		record.resultDigest = digest(result)!;
		this.active.delete(token.path);
	}

	abort(token: MutationToken, mayHaveChanged: boolean): void {
		this.assertToken(token);
		this.active.delete(token.path);
		if (mayHaveChanged) this.unsafePaths.add(token.path);
		else if (token.createdRecord) this.records.delete(token.path);
	}

	hasMutations(): boolean {
		return this.records.size > 0;
	}

	requiresManualInspection(): boolean {
		return this.unsafePaths.size > 0 || this.active.size > 0;
	}

	complete(): CompletedMutationPhase {
		if (this.completion) return this.completion;
		if (this.requiresManualInspection()) throw new MutationPhaseError("Incomplete mutation requires manual inspection");
		const mutations = [...this.records.entries()]
			.map(([path, record]) => {
				if (!record.resultDigest) throw new MutationPhaseError(`Mutation has no result digest: ${path}`);
				return { path, preimageDigest: record.preimageDigest, resultDigest: record.resultDigest };
			})
			.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		this.sealed = true;
		for (const mutation of mutations) Object.freeze(mutation);
		this.completion = Object.freeze({
			schemaVersion: 1 as const,
			phase: this.phase,
			mutations: Object.freeze(mutations),
			mutationDigest: canonicalDigest(mutations),
		});
		return this.completion;
	}

	private assertToken(token: MutationToken): void {
		if (this.active.get(token.path) !== token) throw new MutationPhaseError(`Unknown mutation token: ${token.path}`);
	}
}
