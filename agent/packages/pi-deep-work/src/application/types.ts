const brand = Symbol("pi-deep-work-brand");

type Brand<Name extends string> = { readonly [brand]: Name };

export type RunId = string & Brand<"RunId">;
export type AttemptId = string & Brand<"AttemptId">;
export type RepositoryId = string & Brand<"RepositoryId">;
export type PolicyDigest = string & Brand<"PolicyDigest">;
export type SubjectDigest = string & Brand<"SubjectDigest">;
export type DesignId = string & Brand<"DesignId">;
export type BehaviorContractId = string & Brand<"BehaviorContractId">;
export type ClaimKey = string & Brand<"ClaimKey">;

export const vcsKinds = ["git", "jj"] as const;
export type VcsKind = (typeof vcsKinds)[number];

export const workflowKinds = ["how", "design", "review", "fix", "build", "verify", "unslop"] as const;
export type WorkflowKind = (typeof workflowKinds)[number];

export const lifecycles = [
	"Queued",
	"Active",
	"Pausing",
	"Paused",
	"NeedsManualInspection",
	"Blocked",
	"Cancelled",
	"Failed",
	"Completed",
] as const;
export type Lifecycle = (typeof lifecycles)[number];

export const workflowOutcomes = [
	"ExplanationProduced",
	"UnslopReportProduced",
	"DesignApproved",
	"ReviewApproved",
	"ChangesRequired",
	"Verified",
	"NotVerified",
	"Inconclusive",
	"LocalCommitCreated",
] as const;
export type WorkflowOutcome = (typeof workflowOutcomes)[number];

export const uuidPatternSource = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
export const digestPatternSource = "^[0-9a-f]{64}$";
export const gitOidPatternSource = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";

const uuidPattern = new RegExp(uuidPatternSource);
const digestPattern = new RegExp(digestPatternSource);
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function parse<Name extends string>(value: string, pattern: RegExp, name: Name): string & Brand<Name> {
	if (!pattern.test(value)) throw new Error(`Invalid ${name}: ${value}`);
	return value as string & Brand<Name>;
}

export const runId = (value: string): RunId => parse(value, uuidPattern, "RunId");
export const attemptId = (value: string): AttemptId => parse(value, uuidPattern, "AttemptId");
export const repositoryId = (value: string): RepositoryId => parse(value, digestPattern, "RepositoryId");
export const policyDigest = (value: string): PolicyDigest => parse(value, digestPattern, "PolicyDigest");
export const subjectDigest = (value: string): SubjectDigest => parse(value, digestPattern, "SubjectDigest");
export const designId = (value: string): DesignId => parse(value, digestPattern, "DesignId");
export const behaviorContractId = (value: string): BehaviorContractId => parse(value, digestPattern, "BehaviorContractId");
export const claimKey = (value: string): ClaimKey => parse(value, identifierPattern, "ClaimKey");
