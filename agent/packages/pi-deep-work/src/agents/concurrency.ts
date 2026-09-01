function cancellationError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error("Bounded agent work was cancelled");
}

export async function mapAgentsBounded<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	parentSignal: AbortSignal,
): Promise<R[]> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error(`Invalid agent concurrency: ${limit}`);
	if (items.length === 0) return [];
	const controller = new AbortController();
	const abortFromParent = () => controller.abort(parentSignal.reason);
	if (parentSignal.aborted) abortFromParent();
	else parentSignal.addEventListener("abort", abortFromParent, { once: true });

	const results = new Array<R>(items.length);
	let cursor = 0;
	let firstError: unknown;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (!controller.signal.aborted) {
			const index = cursor++;
			if (index >= items.length) return;
			try {
				results[index] = await run(items[index], index, controller.signal);
			} catch (error) {
				firstError ??= error;
				controller.abort(error);
				return;
			}
		}
	});

	try {
		await Promise.all(workers);
		if (firstError !== undefined) throw firstError;
		if (controller.signal.aborted) throw cancellationError(controller.signal.reason);
		if (results.some((_result, index) => !(index in results))) throw new Error("Bounded agent work ended incomplete");
		return results;
	} finally {
		parentSignal.removeEventListener("abort", abortFromParent);
	}
}
