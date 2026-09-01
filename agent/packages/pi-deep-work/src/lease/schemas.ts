import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { digestPatternSource, uuidPatternSource } from "../application/types.ts";

const uuid = Type.String({ pattern: uuidPatternSource });
const digest = Type.String({ pattern: digestPatternSource });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const leaseId = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" });

export const LeaseOwnerSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		scope: Type.Union([Type.Literal("repository"), Type.Literal("run")]),
		leaseId,
		repositoryId: Type.Optional(digest),
		runId: uuid,
		attemptId: uuid,
		pid: Type.Integer({ minimum: 1 }),
		token: uuid,
		createdAt: timestamp,
	},
	{ additionalProperties: false },
);
export type LeaseOwner = Static<typeof LeaseOwnerSchema>;

export class LeaseDecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LeaseDecodeError";
	}
}

export function decodeLeaseOwner(value: unknown): LeaseOwner {
	if (!Check(LeaseOwnerSchema, value)) {
		const issues = [...Errors(LeaseOwnerSchema, value)].map((error) => error.message).join("; ");
		throw new LeaseDecodeError(`Invalid lease owner: ${issues}`);
	}
	if (value.scope === "repository") {
		if (!value.repositoryId) throw new LeaseDecodeError("Repository lease owner requires repositoryId");
		if (value.leaseId !== value.repositoryId) throw new LeaseDecodeError("Repository leaseId must equal repositoryId");
	}
	if (value.scope === "run") {
		if (value.repositoryId !== undefined) throw new LeaseDecodeError("Run lease owner cannot carry repositoryId");
		if (value.leaseId !== value.runId) throw new LeaseDecodeError("Run leaseId must equal runId");
	}
	return value;
}
