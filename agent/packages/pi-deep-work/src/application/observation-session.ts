import type { AgentGateway, AgentJob, AgentResult } from "../agents/gateway.ts";
import type { AgentJobKind } from "../agents/schemas.ts";
import type { RunAuthority } from "./run-authority.ts";
import {
	backendSnapshotDigest,
	type BackendObservationSnapshot,
	type BackendTreeService,
	type ObservedDiff,
} from "../gates/tree-backend.ts";
import { SubjectDriftError } from "../subject/drift.ts";

export { SubjectDriftError } from "../subject/drift.ts";

export class ObservationSession {
	private constructor(
		private readonly gateway: AgentGateway,
		private readonly trees: BackendTreeService,
		readonly subject: BackendObservationSnapshot,
		readonly subjectDigest: string,
	) {}

	static async begin(
		gateway: AgentGateway,
		trees: BackendTreeService,
		authority: RunAuthority,
	): Promise<ObservationSession> {
		gateway.assertAuthority(authority);
		const subject = await trees.captureObservation();
		return new ObservationSession(gateway, trees, subject, backendSnapshotDigest(subject));
	}

	async run<K extends AgentJobKind>(job: Extract<AgentJob, { kind: K }>): Promise<AgentResult<K>> {
		await this.assertCurrent();
		const result = await this.gateway.run(job);
		await this.assertCurrent();
		return result;
	}

	async runMany<K extends AgentJobKind>(
		jobs: readonly Extract<AgentJob, { kind: K }>[],
		limit: number,
	): Promise<AgentResult<K>[]> {
		await this.assertCurrent();
		const results = await this.gateway.runMany(jobs, limit);
		await this.assertCurrent();
		return results;
	}

	async renderDiff(base?: string): Promise<ObservedDiff> {
		return this.trees.renderObservedDiff(this.subject, base);
	}

	async assertCurrent(): Promise<void> {
		const current = await this.trees.captureObservation();
		const digest = backendSnapshotDigest(current);
		if (digest !== this.subjectDigest) throw new SubjectDriftError(this.subjectDigest, digest);
	}
}
