import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { digestPatternSource } from "../application/types.ts";
import { canonicalDigest } from "../policy/canonical-json.ts";
import { CandidateSubjectSchema, ObservationSubjectSchema } from "../subject/types.ts";

const digest = Type.String({ pattern: digestPatternSource });
export const noBehaviorContractDigest = canonicalDigest({ schemaVersion: 1, kind: "no-behavior-contract" });

export const StandaloneDesignReviewSubjectSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: Type.Literal("standalone-design"),
		observation: ObservationSubjectSchema,
		designDigest: digest,
		behaviorContractDigest: Type.Literal(noBehaviorContractDigest),
	},
	{ additionalProperties: false },
);

const BehaviorDesignReviewSubjectObject = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: Type.Literal("behavior-design"),
		observation: ObservationSubjectSchema,
		designDigest: digest,
		behaviorContractDigest: digest,
	},
	{ additionalProperties: false },
);
export const BehaviorDesignReviewSubjectSchema = Type.Refine(
	BehaviorDesignReviewSubjectObject,
	(value) => value.behaviorContractDigest !== noBehaviorContractDigest,
);

export const ObservedCodeReviewSubjectSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: Type.Literal("observed-code"),
		observation: ObservationSubjectSchema,
		diffDigest: digest,
	},
	{ additionalProperties: false },
);

export const CandidateCodeReviewSubjectSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: Type.Literal("candidate-code"),
		candidate: CandidateSubjectSchema,
	},
	{ additionalProperties: false },
);

export const ReviewSubjectSchema = Type.Union([
	StandaloneDesignReviewSubjectSchema,
	BehaviorDesignReviewSubjectSchema,
	ObservedCodeReviewSubjectSchema,
	CandidateCodeReviewSubjectSchema,
]);

export type ReviewSubject = Static<typeof ReviewSubjectSchema>;

export function decodeReviewSubject(value: unknown): ReviewSubject {
	if (!Check(ReviewSubjectSchema, value)) {
		const issues = [...Errors(ReviewSubjectSchema, value)].map((error) => {
			const path = "path" in error && typeof error.path === "string" ? error.path : "/";
			return `${path}: ${error.message}`;
		});
		throw new Error(`Invalid review subject: ${issues.join("; ")}`);
	}
	return value as ReviewSubject;
}

export function reviewSubjectDigest(subject: ReviewSubject): string {
	return canonicalDigest(subject);
}

export function reviewedArtifactDigest(subject: ReviewSubject): string {
	switch (subject.kind) {
		case "standalone-design":
		case "behavior-design":
			return subject.designDigest;
		case "observed-code":
			return subject.diffDigest;
		case "candidate-code":
			return subject.candidate.patchDigest;
	}
}

export function digestFrozenArtifact(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export function reviewJobKind(subject: ReviewSubject): "review-design" | "review-code" {
	return subject.kind === "standalone-design" || subject.kind === "behavior-design" ? "review-design" : "review-code";
}
