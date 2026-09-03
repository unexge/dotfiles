import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assertUserOrigin } from "../src/application/user-origin.ts";
import { registerDeepWork, commandCompletions, type CommandExecutor } from "../src/service/extension.ts";

function fixture() {
	let command: { handler: (raw: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	let shutdown: (() => Promise<void>) | undefined;
	const execute = vi.fn(async (_command, origin) => assertUserOrigin(origin));
	const registerTool = vi.fn();
	const registerEntryRenderer = vi.fn();
	const service = { execute, shutdown: vi.fn(async () => undefined) } as unknown as CommandExecutor;
	const pi = {
		registerCommand: (_name: string, value: typeof command) => (command = value),
		registerTool,
		registerEntryRenderer,
		on: (_event: string, handler: () => Promise<void>) => (shutdown = handler),
	} as unknown as ExtensionAPI;
	registerDeepWork(pi, service);
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
	} as unknown as ExtensionCommandContext;
	return {
		command: command!,
		shutdown: shutdown!,
		service,
		execute,
		registerTool,
		registerEntryRenderer,
		notifications,
		ctx,
	};
}

describe("installed extension boundary", () => {
	it("registers only /deep and mints UserOrigin for starts and controls", async () => {
		const values = fixture();
		await values.command.handler("how explain this", values.ctx);
		await values.command.handler("cancel 12345678", values.ctx);
		expect(values.execute).toHaveBeenCalledTimes(2);
		expect(values.registerTool).not.toHaveBeenCalled();
		expect(values.registerEntryRenderer).toHaveBeenCalledTimes(2);
		expect(values.execute.mock.calls[0][0]).toEqual({ kind: "start", workflow: "how", goal: "explain this" });
		expect(values.execute.mock.calls[1][0]).toEqual({ kind: "cancel", runId: "12345678" });
		await values.shutdown();
		expect(values.service.shutdown).toHaveBeenCalledTimes(1);
	});

	it("handles help and parse errors without entering the service", async () => {
		const values = fixture();
		await values.command.handler("help", values.ctx);
		await values.command.handler("build", values.ctx);
		expect(values.execute).not.toHaveBeenCalled();
		expect(values.notifications).toEqual([
			expect.objectContaining({ level: "info", message: expect.stringContaining("/deep recover") }),
			expect.objectContaining({ level: "error", message: expect.stringContaining("requires a goal") }),
		]);
	});

	it("renders one error notification for an escaping service failure", async () => {
		const values = fixture();
		values.execute.mockRejectedValueOnce(new Error("broken metadata"));
		await values.command.handler("status", values.ctx);
		expect(values.notifications).toEqual([{ level: "error", message: "broken metadata" }]);
	});

	it("publishes no LLM-callable prompt or tool surface", async () => {
		const manifest = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"));
		expect(manifest.pi.extensions).toEqual(["./extensions/deep-work/index.ts"]);
		expect(manifest.pi.prompts).toBeUndefined();
		expect(fixture().registerTool).not.toHaveBeenCalled();
	});

	it("provides stable command completions without expanding arguments", () => {
		expect(commandCompletions("re")).toEqual([
			{ value: "review", label: "review" },
			{ value: "resume", label: "resume" },
			{ value: "recover", label: "recover" },
		]);
		expect(commandCompletions("review ")).toBeNull();
	});
});
