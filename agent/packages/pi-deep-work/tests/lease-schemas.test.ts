import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LeaseDecodeError, decodeLeaseOwner } from "../src/lease/schemas.ts";

const owner = {
	schemaVersion: 1,
	scope: "repository",
	leaseId: "a".repeat(64),
	repositoryId: "a".repeat(64),
	runId: randomUUID(),
	attemptId: randomUUID(),
	pid: 123,
	token: randomUUID(),
	createdAt: "2026-08-25T00:00:00.000Z",
};

describe("lease owner schema", () => {
	it("requires repository identity only for repository leases", () => {
		expect(decodeLeaseOwner(owner)).toMatchObject({ scope: "repository" });
		expect(
			decodeLeaseOwner({ ...owner, scope: "run", leaseId: owner.runId, repositoryId: undefined }),
		).toMatchObject({ scope: "run" });
		expect(() => decodeLeaseOwner({ ...owner, repositoryId: undefined })).toThrow(LeaseDecodeError);
		expect(() => decodeLeaseOwner({ ...owner, scope: "run" })).toThrow(LeaseDecodeError);
	});

	it("rejects unknown keys and malformed identities", () => {
		expect(() => decodeLeaseOwner({ ...owner, unknown: true })).toThrow(LeaseDecodeError);
		expect(() => decodeLeaseOwner({ ...owner, token: "bad" })).toThrow(LeaseDecodeError);
		expect(() => decodeLeaseOwner({ ...owner, leaseId: "../escape" })).toThrow(LeaseDecodeError);
		expect(() => decodeLeaseOwner({ ...owner, schemaVersion: 2 })).toThrow(LeaseDecodeError);
		expect(() => decodeLeaseOwner({ ...owner, pid: 0 })).toThrow(LeaseDecodeError);
	});
});
