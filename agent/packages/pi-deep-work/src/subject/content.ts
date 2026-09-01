import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDigest } from "../policy/canonical-json.ts";
import type { CandidateSubject, EvidenceSubject, ObservationSubject, RegressionSubject } from "./types.ts";

function addField(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
	const bytes = typeof value === "string" ? Buffer.from(value) : value;
	hash.update(String(bytes.length));
	hash.update(":");
	hash.update(bytes);
}

export function nulFields(value: string): string[] {
	const fields = value.split("\0");
	if (fields.at(-1) === "") fields.pop();
	return fields.filter((field) => field.length > 0);
}

export async function digestPaths(root: string, paths: string[]): Promise<string> {
	const hash = createHash("sha256");
	for (const path of [...paths].sort()) {
		addField(hash, path);
		const absolute = join(root, path);
		try {
			const metadata = await lstat(absolute);
			addField(hash, String(metadata.mode & 0o7777));
			if (metadata.isSymbolicLink()) {
				addField(hash, "symlink");
				addField(hash, await readlink(absolute, { encoding: "buffer" }));
			} else if (metadata.isFile()) {
				addField(hash, "file");
				addField(hash, await readFile(absolute));
			} else {
				addField(hash, "other");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			addField(hash, "deleted");
		}
	}
	return hash.digest("hex");
}

export function observationSubjectDigest(subject: ObservationSubject): string {
	return canonicalDigest(subject);
}

export function evidenceObservation(subject: EvidenceSubject): ObservationSubject {
	if ("observation" in subject) return subject.observation;
	return subject;
}

export function evidenceBackend(subject: EvidenceSubject): "git" | "jj" {
	return subject.kind === "git" || subject.kind === "git-regression" ? "git" : "jj";
}

export function evidenceSubjectDigest(subject: EvidenceSubject): string {
	return canonicalDigest(subject);
}

export function isCandidateSubject(subject: EvidenceSubject): subject is CandidateSubject {
	return "observation" in subject && (subject.kind === "git" || subject.kind === "jj") && "approvedDesignId" in subject;
}

export function isRegressionSubject(subject: EvidenceSubject): subject is RegressionSubject {
	return subject.kind === "git-regression" || subject.kind === "jj-regression";
}

export function changedPathsDigest(paths: string[]): string {
	return canonicalDigest([...new Set(paths)].sort());
}

export function combineDigests(values: string[]): string {
	const hash = createHash("sha256");
	for (const value of values) addField(hash, value);
	return hash.digest("hex");
}
