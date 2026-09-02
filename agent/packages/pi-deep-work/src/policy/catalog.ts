import { canonicalDigest } from "./canonical-json.ts";
import { normalizeClaim } from "./normalize-claim.ts";
import type {
	GateSpec,
	MachinePolicy,
	NormalizerSpec,
	ObservationSpec,
	ProjectPolicy,
	SelectorSpec,
	VerificationContract,
} from "./schemas.ts";

class ReadonlyLookup<K, V> implements ReadonlyMap<K, V> {
	readonly #values: Map<K, V>;

	constructor(values: Iterable<readonly [K, V]>) {
		this.#values = new Map(values);
		Object.freeze(this);
	}

	get size(): number {
		return this.#values.size;
	}

	get(key: K): V | undefined {
		return this.#values.get(key);
	}

	has(key: K): boolean {
		return this.#values.has(key);
	}

	entries(): MapIterator<[K, V]> {
		return this.#values.entries();
	}

	keys(): MapIterator<K> {
		return this.#values.keys();
	}

	values(): MapIterator<V> {
		return this.#values.values();
	}

	forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
		this.#values.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries();
	}
}

export interface ResolvedPolicy {
	machine: MachinePolicy;
	project?: ProjectPolicy;
	mainline?: string;
	quickGates: GateSpec[];
	fullGates: GateSpec[];
	normalizers: NormalizerSpec[];
	observations: ObservationSpec[];
	verificationContracts: VerificationContract[];
	selectors: readonly SelectorSpec[];
	languageScopes: ProjectPolicy["languageScopes"];
	normalizedClaims: ReadonlyMap<string, VerificationContract>;
	selectorPatterns: ReadonlyMap<string, RegExp>;
	digest: string;
}

function uniqueById<T extends { id: string }>(values: T[], label: string): Map<string, T> {
	const result = new Map<string, T>();
	for (const value of values) {
		if (result.has(value.id)) throw new Error(`Duplicate ${label} ID: ${value.id}`);
		result.set(value.id, value);
	}
	return result;
}

function validateContracts(
	contracts: VerificationContract[],
	observations: Map<string, ObservationSpec>,
): ReadonlyMap<string, VerificationContract> {
	const normalizedClaims = new Map<string, VerificationContract>();
	for (const contract of contracts) {
		const normalized = normalizeClaim(contract.claim);
		if (!normalized) throw new Error(`Verification contract ${contract.id} has an empty normalized claim`);
		if (normalizedClaims.has(normalized)) throw new Error(`Duplicate normalized verification claim: ${normalized}`);
		const covered = new Set<string>();
		for (const observationId of contract.observationIds) {
			const observation = observations.get(observationId);
			if (!observation) throw new Error(`Verification contract ${contract.id} references unknown observation ${observationId}`);
			for (const key of observation.claimKeys) covered.add(key);
		}
		const missing = contract.requiredClaimKeys.filter((key) => !covered.has(key));
		if (missing.length > 0) {
			throw new Error(`Verification contract ${contract.id} lacks observation coverage for: ${missing.join(", ")}`);
		}
		normalizedClaims.set(normalized, contract);
	}
	return new ReadonlyLookup(normalizedClaims);
}

function compileSelectorPatterns(
	selectors: SelectorSpec[],
	observations: Map<string, ObservationSpec>,
): ReadonlyMap<string, RegExp> {
	const patterns = new Map<string, RegExp>();
	for (const selector of selectors) {
		if (!observations.has(selector.observationId)) {
			throw new Error(`Selector ${selector.id} references unknown observation ${selector.observationId}`);
		}
		if (/\\[1-9]|\(\?/.test(selector.valuePattern) || /\([^)]*[+*][^)]*\)[+*{]/.test(selector.valuePattern)) {
			throw new Error(`Selector ${selector.id} has an unsafe valuePattern`);
		}
		try {
			patterns.set(selector.id, new RegExp(`^(?:${selector.valuePattern})$`, "u"));
		} catch {
			throw new Error(`Selector ${selector.id} has an invalid valuePattern`);
		}
	}
	return new ReadonlyLookup(patterns);
}

function validateTimeouts(machine: MachinePolicy, values: Array<{ id: string; timeoutMs: number }>): void {
	for (const value of values) {
		if (value.timeoutMs > machine.commandTimeoutMs) {
			throw new Error(`${value.id} timeout exceeds machine commandTimeoutMs`);
		}
	}
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		if (value instanceof Map) {
			for (const [key, nested] of value) {
				deepFreeze(key);
				deepFreeze(nested);
			}
		} else {
			for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
		}
		Object.freeze(value);
	}
	return value;
}

export function resolvePolicy(machineInput: MachinePolicy, projectInput?: ProjectPolicy): ResolvedPolicy {
	const machine = structuredClone(machineInput);
	const project = projectInput ? structuredClone(projectInput) : undefined;
	const quickGates = [...machine.minimumQuickGates, ...(project?.quickGates ?? [])];
	const fullGates = [...machine.minimumFullGates, ...(project?.fullGates ?? [])];
	const observations = [...machine.observations, ...(project?.observations ?? [])];
	const contracts = [...machine.verificationContracts, ...(project?.verificationContracts ?? [])];
	const selectors = [...machine.selectors, ...(project?.selectors ?? [])];

	uniqueById(quickGates, "quick gate");
	uniqueById(fullGates, "full gate");
	const observationMap = uniqueById(observations, "observation");
	uniqueById(contracts, "verification contract");
	uniqueById(selectors, "selector");
	const normalizers = project?.normalizers ?? [];
	uniqueById(normalizers, "normalizer");
	const selectorPatterns = compileSelectorPatterns(selectors, observationMap);
	const normalizedClaims = validateContracts(contracts, observationMap);
	validateTimeouts(machine, [...quickGates, ...fullGates, ...observations, ...normalizers]);

	const digestInput = {
		schemaVersion: 2,
		models: machine.models,
		concurrency: machine.concurrency,
		maxRepairRounds: machine.maxRepairRounds,
		commandTimeoutMs: machine.commandTimeoutMs,
		...(project ? { mainline: project.mainline } : {}),
		quickGates,
		fullGates,
		normalizers,
		observations,
		verificationContracts: contracts,
		selectors,
		languageScopes: project?.languageScopes ?? [],
	};
	return deepFreeze({
		machine,
		project,
		mainline: project?.mainline,
		quickGates,
		fullGates,
		normalizers,
		observations,
		verificationContracts: contracts,
		selectors,
		languageScopes: project?.languageScopes ?? [],
		normalizedClaims,
		selectorPatterns,
		digest: canonicalDigest(digestInput),
	});
}
