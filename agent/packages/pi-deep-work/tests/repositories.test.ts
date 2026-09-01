import { access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createRepositoryFixture,
	detectJjAvailability,
	type RepositoryFixtureKind,
} from "./helpers/repositories.ts";

const kinds: RepositoryFixtureKind[] = ["git", "jj-native", "jj-colocated"];
const jjAvailability = await detectJjAvailability();

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("Jujutsu availability diagnostic", () => {
	it("reports a missing binary without throwing", async () => {
		const availability = await detectJjAvailability("pi-deep-missing-jj-binary");
		expect(availability.available).toBe(false);
		expect(availability.diagnostic).toContain("not installed");
	});
});

for (const kind of kinds) {
	const requiresJj = kind !== "git";
	const suite = requiresJj && !jjAvailability.available ? describe.skip : describe;
	const diagnostic = requiresJj ? ` (${jjAvailability.diagnostic})` : "";

	suite(`${kind} repository fixture${diagnostic}`, () => {
		it("creates a clean canonical repository with stable identity and history", async () => {
			const fixture = await createRepositoryFixture(kind);
			const root = fixture.root;
			try {
				expect(root).toBe(await realpath(root));
				const sharedIdentity = await fixture.sharedRepositoryIdentity();
				expect(sharedIdentity).toBeTruthy();
				expect(await fixture.sharedRepositoryIdentity()).toBe(sharedIdentity);
				if (kind === "git") {
					expect(await exists(join(root, ".git"))).toBe(true);
					expect(await exists(join(root, ".jj"))).toBe(false);
					expect(sharedIdentity).toBe(await realpath(join(root, ".git")));
					expect((await fixture.run("git", ["status", "--porcelain"])).stdout).toBe("");
					expect((await fixture.run("git", ["rev-parse", "HEAD"])).stdout.trim()).toMatch(/^[0-9a-f]{40,64}$/);
				} else {
					expect(await exists(join(root, ".jj"))).toBe(true);
					expect(await exists(join(root, ".git"))).toBe(kind === "jj-colocated");
					expect((await fixture.run("jj", ["diff", "--summary"])).stdout).toBe("");
					const description = await fixture.run("jj", [
						"log",
						"-r",
						"@-",
						"--no-graph",
						"-T",
						"description.first_line()",
					]);
					expect(description.stdout).toBe("initial");
					if (kind === "jj-colocated") expect(sharedIdentity).toBe(await realpath(join(root, ".git")));
					else expect(sharedIdentity).toContain(join(".jj", "repo", "store", "git"));
				}
			} finally {
				await fixture.cleanup();
			}
			expect(await exists(root)).toBe(false);
		});

		it("exposes backend working-copy changes without hiding them", async () => {
			const fixture = await createRepositoryFixture(kind);
			try {
				await fixture.write("README.md", `${kind} changed\n`);
				if (kind === "git") {
					expect((await fixture.run("git", ["status", "--porcelain"])).stdout).toContain("README.md");
				} else {
					expect((await fixture.run("jj", ["diff", "--summary"])).stdout).toContain("README.md");
				}
			} finally {
				await fixture.cleanup();
			}
		});
	});
}
