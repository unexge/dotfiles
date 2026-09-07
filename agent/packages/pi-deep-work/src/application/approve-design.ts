import type { AgentGateway } from "../agents/gateway.ts";
import type { UserOrigin } from "./user-origin.ts";
import { assertUserOrigin } from "./user-origin.ts";
import type { TrustedCommandCatalog } from "../gates/catalog.ts";
import { canonicalDigest, canonicalJson } from "../policy/canonical-json.ts";
import type { RunRef, RunStore } from "../store/run-store.ts";
import { observationSubjectDigest } from "../subject/content.ts";
import type { ObservationSubject } from "../subject/types.ts";
import {
	ApprovedDesignRecordSchema,
	BehaviorContractSchema,
	approvedDesignIdFor,
	decodeDesignData,
	type ApprovedDesignRecord,
	type BehaviorContract,
	type DesignSource,
} from "../review/design.ts";
import type { CanonicalFinding, PanelDiagnostic, ReviewPanel } from "../review/panel.ts";
import {
	digestFrozenArtifact,
	noBehaviorContractDigest,
	reviewSubjectDigest,
	type ReviewSubject,
} from "../review/subjects.ts";

interface ApproveDesignBase {
	design: string | Buffer;
	userOrigin: UserOrigin;
	expectedObservationDigest: string;
	approvedAt: string;
	priorFindings?: readonly CanonicalFinding[];
}

export type ApproveDesignInput =
	| (ApproveDesignBase & { caller: "design"; selectorProposals?: never; sourceDesign?: never })
	| (ApproveDesignBase & { caller: "fix"; selectorProposals: readonly unknown[]; sourceDesign?: never })
	| (ApproveDesignBase & { caller: "build"; selectorProposals?: readonly unknown[]; sourceDesign?: DesignSource });

type DesignReviewSubject = Extract<ReviewSubject, { kind: "standalone-design" | "behavior-design" }>;

export type ApproveDesignResult =
	| { status: "Blocked"; diagnostics: readonly PanelDiagnostic[] }
	| {
			status: "ChangesRequired";
			findings: readonly CanonicalFinding[];
			reviewSubject: DesignReviewSubject;
			subjectDigest: string;
	  }
	| { status: "Approved"; record: ApprovedDesignRecord; findings: readonly CanonicalFinding[] };

export class DesignApprover {
	constructor(
		private readonly panel: ReviewPanel,
		private readonly catalog: TrustedCommandCatalog,
		private readonly store: RunStore,
		private readonly ref: RunRef,
		private readonly captureObservation: () => Promise<ObservationSubject>,
	) {}

	assertRun(gateway: AgentGateway, store: RunStore, ref: RunRef): void {
		// The local check binds approver writes; the delegated checks independently bind panel writes and model effects.
		if (
			this.store !== store ||
			this.ref.directory !== ref.directory ||
			this.ref.runId !== ref.runId ||
			this.ref.repositoryId !== ref.repositoryId ||
			this.ref.backend !== ref.backend
		) {
			throw new Error("DesignApprover is bound to another run store or reference");
		}
		this.panel.assertGateway(gateway);
		this.panel.assertRun(store, ref);
	}

	async approve(input: ApproveDesignInput): Promise<ApproveDesignResult> {
		assertUserOrigin(input.userOrigin);
		const designDigest = digestFrozenArtifact(input.design);
		const behavior = this.resolveBehavior(input);
		const observation = await this.captureObservation();
		// The opaque capture closure is content-bound to its caller through this required digest, not object identity.
		const observedDigest = observationSubjectDigest(observation);
		if (observedDigest !== input.expectedObservationDigest) {
			return {
				status: "Blocked",
				diagnostics: [
					{
						cause: "subject_drift",
						retryable: true,
						detail: `Design observation differs from expected subject: ${input.expectedObservationDigest} != ${observedDigest}`,
					},
				],
			};
		}
		const reviewSubject = this.reviewSubject(input.caller, observation, designDigest, behavior?.id);
		const expectedSubjectDigest = reviewSubjectDigest(reviewSubject);
		const obligations = behavior
			? canonicalJson({
					claimKeys: behavior.claimKeys,
					observationIds: behavior.observationIds,
					selectors: behavior.selectors,
				})
			: "No behavior contract applies to standalone design.";
		const reviewMode = input.priorFindings?.length
			? [
					"Re-review the revised design against these prior findings:",
					canonicalJson(input.priorFindings),
					"Confirm whether each prior failure remains. Do not introduce a new important finding. Report a new blocker only when this revision introduced a concrete correctness, safety, or data-loss failure.",
				]
			: ["This is the initial review. Report all substantive findings together."];
		const panelResult = await this.panel.review({
			subject: reviewSubject,
			frozenArtifact: input.design,
			task: [
				`Review the ${input.caller} design against the original operator goal:`,
				input.userOrigin.goal,
				"Coordinator-minted trusted behavior obligations:",
				obligations,
				...reviewMode,
			].join("\n\n"),
			recaptureSubjectDigest: async () => {
				const current = await this.captureObservation();
				return reviewSubjectDigest(this.reviewSubject(input.caller, current, designDigest, behavior?.id));
			},
		});
		if (!panelResult.complete) return { status: "Blocked", diagnostics: panelResult.diagnostics };
		if (panelResult.subjectDigest !== expectedSubjectDigest) throw new Error("Design panel returned a foreign subject");
		if (!panelResult.record.approved) {
			return {
				status: "ChangesRequired",
				findings: panelResult.findings,
				reviewSubject,
				subjectDigest: expectedSubjectDigest,
			};
		}
		// This is the approval point-in-time check. Candidate sealing performs the next mandatory freshness check.
		const current = await this.captureObservation();
		if (reviewSubjectDigest(this.reviewSubject(input.caller, current, designDigest, behavior?.id)) !== expectedSubjectDigest) {
			return {
				status: "Blocked",
				diagnostics: [
					{ cause: "subject_drift", retryable: true, detail: "Design subject changed after panel publication" },
				],
			};
		}
		const behaviorDigest = behavior?.id ?? noBehaviorContractDigest;
		const approvedDesignId = approvedDesignIdFor({
			reviewSubjectDigest: expectedSubjectDigest,
			panelArtifactDigest: panelResult.panelArtifact.digest,
			designDigest,
			behaviorDigest,
			...(input.sourceDesign ? { sourceDesignDigest: canonicalDigest(input.sourceDesign) } : {}),
		});
		const base = `approved-designs/${approvedDesignId}`;
		const designPath = `${base}/design.json`;
		await this.writeImmutableOrVerify(designPath, input.design);
		let behaviorValue: ApprovedDesignRecord["behavior"];
		if (behavior) {
			const behaviorPath = `${base}/behavior-contract.json`;
			const behaviorBytes = Buffer.from(canonicalJson(behavior));
			await this.writeImmutableOrVerify(behaviorPath, behaviorBytes);
			behaviorValue = {
				kind: "contract",
				digest: behavior.id,
				contract: behavior,
				artifactPath: behaviorPath,
				artifactDigest: digestFrozenArtifact(behaviorBytes),
			};
		} else {
			behaviorValue = { kind: "none", digest: noBehaviorContractDigest };
		}
		const record = decodeDesignData(ApprovedDesignRecordSchema, {
			schemaVersion: 1,
			approvedDesignId,
			caller: input.caller,
			reviewSubject,
			reviewSubjectDigest: expectedSubjectDigest,
			design: { artifactPath: designPath, artifactDigest: designDigest },
			behavior: behaviorValue,
			panel: {
				recordPath: panelResult.recordArtifact.path,
				recordDigest: panelResult.recordArtifact.digest,
				artifactPath: panelResult.panelArtifact.path,
				artifactDigest: panelResult.panelArtifact.digest,
			},
			approvedAt: input.approvedAt,
			...(input.sourceDesign ? { sourceDesign: input.sourceDesign } : {}),
		});
		await this.writeImmutableOrVerify(`${base}/record.json`, Buffer.from(canonicalJson(record)));
		return { status: "Approved", record, findings: panelResult.findings };
	}

	private async writeImmutableOrVerify(path: string, content: string | Buffer): Promise<void> {
		const expectedDigest = digestFrozenArtifact(content);
		try {
			const written = await this.store.writeImmutableArtifact(this.ref, path, content);
			if (written.digest !== expectedDigest) throw new Error(`Artifact digest mismatch after writing ${path}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await this.store.readArtifact(this.ref, path);
			if (digestFrozenArtifact(existing) !== expectedDigest) {
				throw new Error(`Existing immutable artifact contradicts approved design: ${path}`);
			}
		}
	}

	private resolveBehavior(input: ApproveDesignInput): BehaviorContract | undefined {
		if (input.caller === "design") {
			if ("selectorProposals" in input && input.selectorProposals !== undefined) {
				throw new Error("Standalone design cannot supply behavior selectors");
			}
			return undefined;
		}
		const bySelector = new Map<string, { selectorId: string; value: string; observationId: string }>();
		const commands = new Map<string, ReturnType<TrustedCommandCatalog["observation"]>>();
		if (input.caller === "build") {
			for (const command of this.catalog.commandsFor("observation")) commands.set(command.id, command);
		} else {
			if (!Array.isArray(input.selectorProposals) || input.selectorProposals.length === 0) {
				throw new Error("fix design requires behavior selectors");
			}
			for (const proposal of input.selectorProposals) {
				const resolved = this.catalog.resolveSelector(proposal);
				const previous = bySelector.get(resolved.selectorId);
				if (previous && previous.value !== resolved.value) {
					throw new Error(`Behavior selector ${resolved.selectorId} has conflicting values`);
				}
				if (!previous) {
					bySelector.set(resolved.selectorId, {
						selectorId: resolved.selectorId,
						value: resolved.value,
						observationId: resolved.command.id,
					});
				}
				commands.set(resolved.command.id, resolved.command);
			}
		}
		const selectors = [...bySelector.values()].sort((left, right) =>
			left.selectorId < right.selectorId ? -1 : left.selectorId > right.selectorId ? 1 : 0,
		);
		const observationIds = [...commands.keys()].sort();
		const claimKeys = [...new Set([...commands.values()].flatMap((command) => [...command.claimKeys]))].sort();
		if (claimKeys.length === 0) throw new Error(`${input.caller} design resolves to no trusted behavior claims`);
		const core = { schemaVersion: 1 as const, selectors, observationIds, claimKeys };
		return decodeDesignData(BehaviorContractSchema, { ...core, id: canonicalDigest(core) });
	}

	private reviewSubject(
		caller: ApproveDesignInput["caller"],
		observation: ObservationSubject,
		designDigest: string,
		behaviorDigest?: string,
	): DesignReviewSubject {
		return caller === "design"
			? {
					schemaVersion: 1,
					kind: "standalone-design",
					observation,
					designDigest,
					behaviorContractDigest: noBehaviorContractDigest,
				}
			: {
					schemaVersion: 1,
					kind: "behavior-design",
					observation,
					designDigest,
					behaviorContractDigest: behaviorDigest!,
				};
	}
}
