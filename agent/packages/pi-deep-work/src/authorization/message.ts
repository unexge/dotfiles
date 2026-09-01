import { createHash } from "node:crypto";

export interface ValidatedCommitMessage {
	text: string;
	digest: string;
	bytes: number;
}

export function validateCommitMessage(input: string): ValidatedCommitMessage {
	const content = Buffer.from(input, "utf8");
	if (content.length === 0 || content.length > 16 * 1024) throw new Error("Commit message must be 1 to 16384 UTF-8 bytes");
	if (input.endsWith("\n")) throw new Error("Commit message must not end with LF");
	for (const character of input) {
		const code = character.codePointAt(0)!;
		if ((code < 0x20 && code !== 0x0a) || code === 0x7f) throw new Error("Commit message contains a forbidden control byte");
	}
	const lines = input.split("\n");
	if (!lines[0] || Buffer.byteLength(lines[0]) > 72) throw new Error("Commit header must be 1 to 72 UTF-8 bytes");
	for (const line of lines) {
		if (/[ \t]$/.test(line)) throw new Error("Commit message lines must not have trailing whitespace");
	}
	if (lines.length > 1) {
		if (lines.length < 3 || lines[1] !== "" || lines[2] === "") {
			throw new Error("Commit body requires one empty separator and a nonempty first body line");
		}
		for (const line of lines.slice(2)) {
			if (Buffer.byteLength(line) > 100) throw new Error("Commit body lines must not exceed 100 UTF-8 bytes");
		}
	}
	return Object.freeze({
		text: input,
		digest: createHash("sha256").update(content).digest("hex"),
		bytes: content.length,
	});
}
