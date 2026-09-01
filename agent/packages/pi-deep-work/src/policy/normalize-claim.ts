const asciiWhitespace = /[\t\n\r ]+/g;

export function normalizeClaim(value: unknown): string {
	if (typeof value !== "string") throw new Error("Verification claim must be a string");
	if (value.includes("\0")) throw new Error("Verification claim cannot contain NUL");
	return value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "").replace(asciiWhitespace, " ");
}
