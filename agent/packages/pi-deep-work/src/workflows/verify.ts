import type { AgentGateway } from "../agents/gateway.ts";
import { ObservationSession } from "../application/observation-session.ts";
import {
	ControlAcceptedError,
	RunAuthorityClosedError,
	type RunAuthority,
} from "../application/run-authority.ts";
import type { UserOrigin } from "../application/user-origin.ts";
import { assertUserOrigin } from "../application/user-origin.ts";
import type { TrustedCommandCatalog } from "../gates/catalog.ts";
import type { ObservationExecution } from "../gates/coverage.ts";
import type { GateExecution, GateExecutor } from "../gates/executor.ts";
import type { BackendTreeService } from "../gates/tree-backend.ts";
import type { ResolvedPolicy } from "../policy/catalog.ts";
import { normalizeClaim } from "../policy/normalize-claim.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { evidenceSubjectDigest, observationSubjectDigest } from "../subject/content.ts";
import { SubjectDriftError } from "../subject/drift.ts";
import {
	standaloneVerificationContractId,
	verifyObservedBehavior,
} from "../verification/behavior.ts";
import { canonicalJson } from "../policy/canonical-json.ts";

export interface VerifyWorkflowResult {
	outcome: "Verified" | "NotVerified" | "Inconclusive" | "Blocked" | "Failed";
	artifactPath: string;
	reason?: string;
}

interface VerifyWorkflowInput {
	origin: UserOrigin;
	policy: ResolvedPolicy;
	catalog: TrustedCommandCatalog;
	authority: RunAuthority;
	gateway: AgentGateway;
	trees: BackendTreeService;
	executor: GateExecutor;
	store: RunStore;
	ref: RunRef;
	repositoryKind: "git" | "jj";
	completedAt: string;
}

export async function runVerifyWorkflow(input: VerifyWorkflowInput): Promise<VerifyWorkflowResult> {
	const artifactPath = "outputs/verify.json";
	try {
		assertUserOrigin(input.origin);
		input.catalog.assertPolicy(input.policy);
		input.executor.assertRun(input.authority, input.store, input.ref, input.repositoryKind);
		const observed = await ObservationSession.begin(input.gateway, input.trees, input.authority);
		if (observed.subject.observation.policyDigest !== input.policy.digest) {
			throw new Error("Observed subject policy digest differs from resolved verification policy");
		}
		const normalizedClaim = normalizeClaim(input.origin.goal);
		if (!normalizedClaim) throw new VerifyPreconditionError("Verification claim cannot be empty");
		const contract = input.policy.normalizedClaims.get(normalizedClaim);
		if (!contract) throw new VerifyPreconditionError("No trusted verification contract matches the exact claim");
		const commands = input.catalog.observations(contract.observationIds);
		const initialObservation = observed.subject.observation;
		const initialSubjectDigest = observationSubjectDigest(initialObservation);
		const executions: ObservationExecution[] = [];
		const artifacts: ReturnType<typeof executionArtifact>[] = [];
		for (const command of commands) {
			await observed.assertCurrent();
			// GateExecutor owns the command's own before/after capture; these checks bind the boundaries between commands.
			const execution = await input.executor.run(command);
			const executionSubjectDigest = evidenceSubjectDigest(execution.record.subject);
			if (executionSubjectDigest !== initialSubjectDigest) {
				throw new SubjectDriftError(initialSubjectDigest, executionSubjectDigest);
			}
			executions.push({
				command,
				record: execution.record,
				...(execution.receipt ? { receipt: execution.receipt, receiptArtifact: execution.receiptArtifact } : {}),
			});
			artifacts.push(executionArtifact(execution));
			if (execution.record.outcome === "drifted") break;
			await observed.assertCurrent();
		}
		const result = verifyObservedBehavior(initialObservation, contract, commands, executions);
		if (result.verdict === "Blocked") {
			const afterDigest = executions.find((execution) => execution.record.outcome === "drifted")?.record
				.afterObservationDigest;
			if (!afterDigest) throw new Error("Drift verdict lacks an after-observation digest");
			throw new SubjectDriftError(initialSubjectDigest, afterDigest);
		}
		const contractId = standaloneVerificationContractId(contract);
		const artifact = {
			schemaVersion: 1,
			proposedOutcome: result.verdict,
			authoritative: false,
			lifecycleAuthority: "state.json",
			assertionScope: "observed-subject",
			approvedDesignSeal: false,
			consumerRequirement: "Resolve this contract under the observation subject policyDigest.",
			claim: input.origin.goal,
			normalizedClaim,
			observationSubjectDigest: initialSubjectDigest,
			policyDigest: initialObservation.policyDigest,
			contract: {
				kind: "standalone-verification-contract",
				id: contract.id,
				digest: contractId,
				requiredClaimKeys: contract.requiredClaimKeys,
				observationIds: contract.observationIds,
			},
			record: result.record,
			executions: artifacts,
		};
		await input.store.writeArtifact(input.ref, artifactPath, Buffer.from(canonicalJson(artifact)));
		await observed.assertCurrent();
		await input.authority.complete(result.verdict, artifactPath, input.completedAt);
		return { outcome: result.verdict, artifactPath };
	} catch (error) {
		if (error instanceof ControlAcceptedError || error instanceof RunAuthorityClosedError) throw error;
		if (error instanceof VerifyPreconditionError) {
			await input.authority.block(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Blocked", error.message);
			return { outcome: "Blocked", artifactPath, reason: error.message };
		}
		if (error instanceof SubjectDriftError) {
			await input.authority.block(error.message, input.completedAt);
			await writeDiagnostic(input, artifactPath, "Blocked", error.message, {
				beforeSubjectDigest: error.beforeDigest,
				afterSubjectDigest: error.afterDigest,
			});
			return { outcome: "Blocked", artifactPath, reason: error.message };
		}
		const reason = error instanceof Error ? error.message : String(error);
		let state = await input.store.load(input.ref);
		if (state.lifecycle === "Active") {
			await input.authority.fail(reason, input.completedAt);
			state = await input.store.load(input.ref);
		}
		if (state.lifecycle !== "Failed") throw error;
		await writeDiagnostic(input, artifactPath, "Failed", reason, { lifecycle: state.lifecycle });
		return { outcome: "Failed", artifactPath, reason };
	}
}

function executionArtifact(execution: GateExecution) {
	return {
		commandId: execution.record.commandId,
		outcome: execution.record.outcome,
		record: { path: execution.recordArtifact.path, digest: execution.recordArtifact.digest },
		...(execution.receipt && execution.receiptArtifact
			? {
					receipt: {
						receiptId: execution.receipt.receiptId,
						path: execution.receiptArtifact.path,
						digest: execution.receiptArtifact.digest,
					},
				}
			: {}),
	};
}

async function writeDiagnostic(
	input: VerifyWorkflowInput,
	artifactPath: string,
	outcome: "Blocked" | "Failed",
	reason: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	await input.store.writeArtifact(
		input.ref,
		artifactPath,
		Buffer.from(
			canonicalJson({
				schemaVersion: 1,
				proposedOutcome: outcome,
				authoritative: false,
				lifecycleAuthority: "state.json",
				claim: input.origin.goal,
				reason,
				...extra,
			}),
		),
	);
}

class VerifyPreconditionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerifyPreconditionError";
	}
}
