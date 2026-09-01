import type { ResolvedPolicy } from "./catalog.ts";
import { decodeSelectorProposal, type SelectorProposal } from "./schemas.ts";

export interface ResolvedSelector {
	selectorId: string;
	observationId: string;
	value: string;
}

export function resolveSelector(policy: ResolvedPolicy, input: unknown): ResolvedSelector {
	const proposal: SelectorProposal = decodeSelectorProposal(input);
	const selector = policy.selectors.find((entry) => entry.id === proposal.selectorId);
	if (!selector) throw new Error(`Unknown selector: ${proposal.selectorId}`);
	const pattern = policy.selectorPatterns.get(selector.id);
	if (!pattern || !pattern.test(proposal.value)) {
		throw new Error(`Selector ${selector.id} rejected value: ${proposal.value}`);
	}
	return {
		selectorId: selector.id,
		observationId: selector.observationId,
		value: proposal.value,
	};
}
