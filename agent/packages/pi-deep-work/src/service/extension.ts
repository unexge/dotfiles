import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { userOriginFromRegisteredCommand } from "../application/user-origin.ts";
import { configurePolicy } from "../policy/config-command.ts";
import { initializeProjectPolicy } from "../policy/project-init.ts";
import { parseCommand, commandNames, usage, type ParsedCommand } from "./command.ts";
import { registerDeepWorkPresentation } from "./presentation.ts";
import { DeepWorkService } from "./service.ts";

export interface CommandExecutor {
	execute(command: ParsedCommand, origin: ReturnType<typeof userOriginFromRegisteredCommand>, ctx: ExtensionCommandContext): Promise<void>;
	shutdown(): Promise<void>;
}

export function commandCompletions(prefix: string): AutocompleteItem[] | null {
	if (prefix.includes(" ")) return null;
	const values = commandNames
		.filter((name) => name.startsWith(prefix))
		.map((name) => ({ value: name, label: name }));
	return values.length > 0 ? values : null;
}

export function registerDeepWork(pi: ExtensionAPI, injected?: CommandExecutor): void {
	registerDeepWorkPresentation(pi);
	const service = injected ?? new DeepWorkService(pi);
	pi.registerCommand("deep", {
		description: "Run explicit local high-rigor engineering workflows",
		getArgumentCompletions: commandCompletions,
		handler: async (raw, ctx) => {
			let command: ParsedCommand;
			try {
				command = parseCommand(raw);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (command.kind === "help") {
				ctx.ui.notify(usage, "info");
				return;
			}
			if (command.kind === "config") {
				try {
					const path = join(getAgentDir(), "pi-deep-work", "config.json");
					if (await configurePolicy(ctx, path)) ctx.ui.notify(`Deep-work policy written to ${path}`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (command.kind === "init") {
				try {
					const result = await initializeProjectPolicy(ctx);
					if (result.status === "created") {
						ctx.ui.notify(
							`Repository policy written to ${result.path} with mainline ${result.mainline}. Add trusted gates and behavior observations as needed, then commit it before /deep build or /deep fix.`,
							"info",
						);
					} else if (result.status === "existing") {
						ctx.ui.notify(
							`Repository policy already exists at ${result.path} with mainline ${result.mainline}; it was not changed.`,
							"info",
						);
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			// Control origins carry command provenance only; resumed workflows re-mint the immutable persisted goal.
			const goal =
				command.kind === "start"
					? command.goal
					: [
						"/deep",
						command.kind,
						"runId" in command ? command.runId : undefined,
						"challenge" in command ? command.challenge : undefined,
					].filter(Boolean).join(" ");
			try {
				await service.execute(command, userOriginFromRegisteredCommand(goal.trim()), ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.on("session_shutdown", async () => {
		await service.shutdown();
	});
}
