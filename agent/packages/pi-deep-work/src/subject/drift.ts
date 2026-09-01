export class SubjectDriftError extends Error {
	constructor(readonly beforeDigest: string, readonly afterDigest: string) {
		super(`Observation subject drifted: ${beforeDigest} != ${afterDigest}`);
		this.name = "SubjectDriftError";
	}
}
