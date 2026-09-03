import type { ResolvedPolicy } from "../policy/catalog.ts";
import { canonicalDigest } from "../policy/canonical-json.ts";
import { resolveSelector } from "../policy/selectors.ts";
import type { SelectorProposal } from "../policy/schemas.ts";
import type { PackageLanguage } from "./languages.ts";

const trustedCommandToken = Symbol("trusted-command");
const trustedCommands = new WeakSet<TrustedCommand>();

export type CommandSource = "machine" | "project" | "package";
export type CommandCategory = "quick" | "full" | "observation";

export class TrustedCommand {
	readonly #trustedBrand = true;
	readonly argv: readonly [string, ...string[]];
	readonly claimKeys: readonly string[];

	constructor(
		token: typeof trustedCommandToken,
		readonly id: string,
		readonly source: CommandSource,
		readonly category: CommandCategory,
		argv: readonly [string, ...string[]],
		readonly timeoutMs: number,
		claimKeys: readonly string[] = [],
	) {
		if (token !== trustedCommandToken) throw new Error("TrustedCommand can only be minted by the package catalog");
		this.argv = Object.freeze([...argv]) as readonly [string, ...string[]];
		this.claimKeys = Object.freeze([...claimKeys]);
		trustedCommands.add(this);
		Object.freeze(this);
	}

	argvDigest(): string {
		return canonicalDigest(this.argv);
	}
}

export function assertTrustedCommand(command: TrustedCommand): void {
	if (!trustedCommands.has(command)) throw new Error("Command was not minted by the trusted package catalog");
}

export interface TrustedSelectorGuide {
	selectorId: string;
	language: PackageLanguage;
	valuePattern: string;
	scopes: readonly string[];
}

export interface TrustedSelectorResolution {
	selectorId: string;
	value: string;
	language: PackageLanguage;
	command: TrustedCommand;
}

function safeSelectorPath(value: string, language: PackageLanguage): string {
	if (
		!value ||
		value.length > 1024 ||
		value.startsWith("-") ||
		value.startsWith("/") ||
		value.includes("\\") ||
		/[\0\n\r\t ]/.test(value)
	) {
		throw new Error(`Unsafe ${language} selector path: ${JSON.stringify(value)}`);
	}
	const segments = value.split("/").map((segment) => segment.normalize("NFC"));
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`Unsafe ${language} selector path: ${JSON.stringify(value)}`);
	}
	const normalized = segments.join("/");
	const accepted =
		(language === "rust" && normalized.endsWith(".rs")) ||
		(language === "zig" && normalized.endsWith(".zig")) ||
		(language === "python" && normalized.endsWith(".py")) ||
		(language === "typescript" && /\.(?:ts|tsx)$/.test(normalized));
	if (!accepted) throw new Error(`Selector path does not match ${language}: ${normalized}`);
	return normalized;
}

function activeProjectLanguages(policy: ResolvedPolicy): ReadonlySet<PackageLanguage> {
	const values = new Set<PackageLanguage>();
	for (const gate of [...(policy.project?.quickGates ?? []), ...(policy.project?.fullGates ?? [])]) {
		for (const language of gate.languages) values.add(language);
	}
	for (const selector of policy.project?.selectors ?? []) values.add(selector.language);
	for (const scope of policy.project?.languageScopes ?? []) values.add(scope.language);
	return values;
}

function makeCommand(
	id: string,
	source: CommandSource,
	category: CommandCategory,
	argv: readonly string[],
	timeoutMs: number,
	claimKeys: readonly string[] = [],
): TrustedCommand {
	if (argv.length === 0) throw new Error(`Trusted command ${id} has empty argv`);
	return new TrustedCommand(
		trustedCommandToken,
		id,
		source,
		category,
		argv as readonly [string, ...string[]],
		timeoutMs,
		claimKeys,
	);
}

export class TrustedCommandCatalog {
	private readonly commands: ReadonlyMap<string, TrustedCommand>;

	private constructor(
		private readonly policy: ResolvedPolicy,
		commands: Map<string, TrustedCommand>,
	) {
		this.commands = commands;
		Object.freeze(this);
	}

	static async build(policy: ResolvedPolicy, _repositoryRoot: string): Promise<TrustedCommandCatalog> {
		const commands = new Map<string, TrustedCommand>();
		const activeLanguages = activeProjectLanguages(policy);
		const machineGateApplies = (languages: readonly PackageLanguage[]) =>
			activeLanguages.size === 0 || languages.some((language) => activeLanguages.has(language));
		const add = (command: TrustedCommand) => {
			const key = `${command.category}:${command.id}`;
			if (commands.has(key)) throw new Error(`Duplicate trusted command: ${key}`);
			commands.set(key, command);
		};
		for (const gate of policy.machine.minimumQuickGates) {
			if (machineGateApplies(gate.languages)) {
				add(makeCommand(gate.id, "machine", "quick", gate.argv, gate.timeoutMs));
			}
		}
		for (const gate of policy.machine.minimumFullGates) {
			if (machineGateApplies(gate.languages)) {
				add(makeCommand(gate.id, "machine", "full", gate.argv, gate.timeoutMs));
			}
		}
		for (const gate of policy.project?.quickGates ?? []) {
			add(makeCommand(gate.id, "project", "quick", gate.argv, gate.timeoutMs));
		}
		for (const gate of policy.project?.fullGates ?? []) {
			add(makeCommand(gate.id, "project", "full", gate.argv, gate.timeoutMs));
		}
		const machineObservationIds = new Set(policy.machine.observations.map((observation) => observation.id));
		for (const observation of policy.observations) {
			add(
				makeCommand(
					observation.id,
					machineObservationIds.has(observation.id) ? "machine" : "project",
					"observation",
					observation.argv,
					observation.timeoutMs,
					observation.claimKeys,
				),
			);
		}
		return new TrustedCommandCatalog(policy, commands);
	}

	assertPolicy(policy: ResolvedPolicy): void {
		if (this.policy !== policy) throw new Error("TrustedCommandCatalog is bound to another resolved policy");
	}

	assertWriteReady(): void {
		const missing: string[] = [];
		if (!this.policy.mainline) missing.push("mainline");
		if (this.commandsFor("quick").length === 0) missing.push("quick gate");
		if (this.commandsFor("full").length === 0) missing.push("full gate");
		if (this.commandsFor("observation").length === 0) missing.push("behavior observation");
		if (this.policy.selectors.length === 0) missing.push("behavior selector");
		if (missing.length > 0) {
			throw new Error(`Write workflow policy is missing ${missing.join(", ")}. Run /deep init --refresh.`);
		}
	}

	gate(category: "quick" | "full", id: string): TrustedCommand {
		return this.required(`${category}:${id}`);
	}

	observation(id: string): TrustedCommand {
		return this.required(`observation:${id}`);
	}

	observations(ids: readonly string[]): TrustedCommand[] {
		return ids.map((id) => this.observation(id));
	}

	commandsFor(category: "quick" | "full" | "observation"): TrustedCommand[] {
		return [...this.commands.values()].filter((command) => command.category === category);
	}

	selectorGuide(): readonly TrustedSelectorGuide[] {
		return this.policy.selectors
			.map((selector) => ({
				selectorId: selector.id,
				language: selector.language,
				valuePattern: selector.valuePattern,
				scopes: this.policy.languageScopes
					.filter((scope) => scope.language === selector.language)
					.flatMap((scope) => [...scope.paths])
					.sort(),
			}))
			.sort((left, right) =>
				left.selectorId < right.selectorId ? -1 : left.selectorId > right.selectorId ? 1 : 0,
			);
	}

	resolveSelector(input: unknown): TrustedSelectorResolution {
		const proposal = input as SelectorProposal;
		const resolved = resolveSelector(this.policy, proposal);
		const selector = this.policy.selectors.find((entry) => entry.id === resolved.selectorId);
		if (!selector) throw new Error(`Unknown selector: ${resolved.selectorId}`);
		const value = safeSelectorPath(resolved.value, selector.language);
		const scopes = this.policy.languageScopes.filter((scope) => scope.language === selector.language).flatMap((scope) => scope.paths);
		if (scopes.length > 0 && !scopes.some((scope) => value === scope || value.startsWith(`${scope}/`))) {
			throw new Error(`Selector path is outside trusted ${selector.language} scopes: ${value}`);
		}
		return Object.freeze({
			selectorId: resolved.selectorId,
			value,
			language: selector.language,
			command: this.observation(resolved.observationId),
		});
	}

	private required(key: string): TrustedCommand {
		const command = this.commands.get(key);
		if (!command) throw new Error(`Unknown trusted command: ${key}`);
		return command;
	}
}
