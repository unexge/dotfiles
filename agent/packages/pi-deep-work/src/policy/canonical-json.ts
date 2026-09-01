import { createHash } from "node:crypto";

function encode(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${encode(nested)}`).join(",")}}`;
	}
	throw new Error(`Canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
	return encode(value);
}

export function canonicalDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
