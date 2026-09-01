import { describe, expect, it } from "vitest";
import { mapAgentsBounded } from "../src/agents/concurrency.ts";

describe("bounded agent concurrency", () => {
	it("bounds work and preserves input order", async () => {
		let active = 0;
		let maximum = 0;
		const results = await mapAgentsBounded(
			[3, 1, 2, 0],
			2,
			async (delay, index) => {
				active++;
				maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, delay * 5));
				active--;
				return index;
			},
			new AbortController().signal,
		);
		expect(results).toEqual([0, 1, 2, 3]);
		expect(maximum).toBe(2);
	});

	it("aborts siblings after the first failure", async () => {
		let siblingAborted = false;
		await expect(
			mapAgentsBounded(
				["wait", "fail", "never"],
				2,
				async (item, _index, signal) => {
					if (item === "fail") throw new Error("panel failed");
					await new Promise<void>((resolve) =>
						signal.addEventListener(
							"abort",
							() => {
								siblingAborted = true;
								resolve();
							},
							{ once: true },
						),
					);
				},
				new AbortController().signal,
			),
		).rejects.toThrow("panel failed");
		expect(siblingAborted).toBe(true);
	});

	it("rejects invalid limits before starting work", async () => {
		await expect(mapAgentsBounded([1], 0, async () => 1, new AbortController().signal)).rejects.toThrow(
			"Invalid agent concurrency",
		);
	});
});
