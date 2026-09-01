import { createHash } from "node:crypto";
import type { RunAuthority } from "../application/run-authority.ts";
import type { ResolvedPolicy } from "../policy/catalog.ts";
import type { NormalizerSpec } from "../policy/schemas.ts";
import { runSupervisedCommand } from "./supervised-command.ts";
import {
	BackendTreeService,
	backendSnapshotDigest,
	backendTreeIdentity,
	type BackendTreeSnapshot,
} from "./tree-backend.ts";

export interface NormalizerCommandRecord {
	pass: 1 | 2;
	normalizerId: string;
	beforeSnapshotDigest: string;
	afterSnapshotDigest: string;
	changedPaths: readonly string[];
	stdoutDigest: string;
	stderrDigest: string;
}

const normalizationToken = Symbol("normalization-result");
const completedNormalizations = new WeakSet<NormalizationResult>();

export class NormalizationResult {
	readonly #trustedBrand = true;
	readonly schemaVersion = 2 as const;

	constructor(
		token: typeof normalizationToken,
		readonly initial: BackendTreeSnapshot,
		readonly passOne: BackendTreeSnapshot,
		readonly passTwo: BackendTreeSnapshot,
		readonly fixedPointTree: string,
		readonly commands: readonly NormalizerCommandRecord[],
	) {
		if (token !== normalizationToken) throw new NormalizationError("Normalization result lacks package authority");
		completedNormalizations.add(this);
		Object.freeze(this);
	}
}

export function assertNormalizationResult(result: NormalizationResult): void {
	if (!completedNormalizations.has(result)) throw new NormalizationError("Normalization result was not minted by Normalizer");
}

export class NormalizationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NormalizationError";
	}
}

function outputDigest(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function snapshotMatches(left: BackendTreeSnapshot, right: BackendTreeSnapshot): boolean {
	return backendSnapshotDigest(left) === backendSnapshotDigest(right);
}

export class Normalizer {
	constructor(
		private readonly authority: RunAuthority,
		private readonly policy: ResolvedPolicy,
		private readonly trees: BackendTreeService,
	) {}

	assertRun(authority: RunAuthority, policy: ResolvedPolicy, trees: BackendTreeService): void {
		if (this.authority !== authority || this.policy !== policy || this.trees !== trees) {
			throw new Error("Normalizer is bound to another authority, policy, or tree service");
		}
	}

	async runExactlyTwoPasses(): Promise<NormalizationResult> {
		const records: NormalizerCommandRecord[] = [];
		const initial = await this.trees.capture();
		let current = initial;
		current = await this.runPass(1, current, records);
		const passOne = current;
		current = await this.runPass(2, current, records);
		const passTwo = current;
		if (backendTreeIdentity(passTwo) !== backendTreeIdentity(passOne)) {
			throw new NormalizationError("Normalizer pass 2 did not reach a fixed point");
		}
		for (const record of records) Object.freeze(record);
		return new NormalizationResult(
			normalizationToken,
			initial,
			passOne,
			passTwo,
			backendTreeIdentity(passTwo),
			Object.freeze(records),
		);
	}

	private async runPass(
		pass: 1 | 2,
		expected: BackendTreeSnapshot,
		records: NormalizerCommandRecord[],
	): Promise<BackendTreeSnapshot> {
		let current = expected;
		for (const spec of this.policy.normalizers) {
			const before = await this.trees.capture();
			if (!snapshotMatches(before, current)) throw new NormalizationError(`Subject drift before normalizer ${spec.id}`);
			const processResult = await this.runCommand(spec, pass, before.observation.root);
			if (processResult.status !== "exited" || processResult.exitCode !== 0) {
				throw new NormalizationError(
					`Normalizer ${spec.id} pass ${pass} did not complete successfully: ${processResult.status}/${processResult.exitCode}`,
				);
			}
			if (!processResult.stdoutComplete || !processResult.stderrComplete) {
				throw new NormalizationError(`Normalizer ${spec.id} pass ${pass} produced incomplete output`);
			}
			const after = await this.trees.capture();
			const changedPaths = await this.trees.diffPaths(before, after);
			const unexpected = changedPaths.filter((path) => !spec.allowedChangedPaths.includes(path));
			if (unexpected.length > 0) {
				throw new NormalizationError(`Normalizer ${spec.id} changed undeclared paths: ${unexpected.join(", ")}`);
			}
			if (pass === 2 && changedPaths.length > 0) {
				throw new NormalizationError(`Normalizer ${spec.id} changed state during pass 2`);
			}
			records.push({
				pass,
				normalizerId: spec.id,
				beforeSnapshotDigest: backendSnapshotDigest(before),
				afterSnapshotDigest: backendSnapshotDigest(after),
				changedPaths: Object.freeze([...changedPaths]),
				stdoutDigest: outputDigest(processResult.stdout),
				stderrDigest: outputDigest(processResult.stderr),
			});
			current = after;
		}
		return current;
	}

	private runCommand(spec: NormalizerSpec, pass: 1 | 2, root: string) {
		return this.authority.runEffect(`normalizer:${pass}:${spec.id}`, async (signal) => {
			const result = await runSupervisedCommand(
				spec.argv as [string, ...string[]],
				root,
				spec.timeoutMs,
				signal,
			);
			if (signal.aborted) throw signal.reason ?? new Error("Normalizer cancelled");
			return result;
		});
	}
}
