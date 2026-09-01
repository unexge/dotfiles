import {
	lstat as fsLstat,
	mkdir as fsMkdir,
	readFile as fsReadFile,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool, withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkspaceAgentTools } from "../agents/gateway.ts";
import { WorkspaceBoundary, type WorkspacePath } from "./boundary.ts";
import { MutationPhase } from "./mutation-phase.ts";

const pathSchema = Type.String({ minLength: 1, maxLength: 1024 });
const editSchema = Type.Object(
	{
		path: pathSchema,
		edits: Type.Array(
			Type.Object(
				{
					oldText: Type.String({ minLength: 1, maxLength: 1_000_000 }),
					newText: Type.String({ maxLength: 1_000_000 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 64 },
		),
	},
	{ additionalProperties: false },
);

export interface WorkspaceOperations {
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, content: Buffer): Promise<void>;
	mkdir(path: string): Promise<void>;
	lstat(path: string): Promise<Awaited<ReturnType<typeof fsLstat>>>;
}

const defaultOperations: WorkspaceOperations = {
	readFile: fsReadFile,
	// Interrupted source writes remain in place so subject drift forces explicit manual inspection instead of hidden rollback.
	writeFile: (path, content) => fsWriteFile(path, content),
	mkdir: (path) => fsMkdir(path, { recursive: true }).then(() => undefined),
	lstat: fsLstat,
};

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("Workspace operation was cancelled");
}

function decodeText(content: Buffer, path: string): string {
	if (content.includes(0)) throw new Error(`Workspace text tool does not support binary file: ${path}`);
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
}

function applyEdits(content: string, edits: Array<{ oldText: string; newText: string }>): string {
	const replacements = edits.map((edit) => {
		const index = content.indexOf(edit.oldText);
		if (index < 0) throw new Error("Edit oldText was not found");
		if (content.indexOf(edit.oldText, index + 1) >= 0) throw new Error("Edit oldText is not unique");
		return { ...edit, index, end: index + edit.oldText.length };
	});
	replacements.sort((left, right) => left.index - right.index);
	for (let index = 1; index < replacements.length; index++) {
		if (replacements[index].index < replacements[index - 1].end) throw new Error("Edits overlap");
	}
	let output = "";
	let cursor = 0;
	for (const replacement of replacements) {
		output += content.slice(cursor, replacement.index);
		output += replacement.newText;
		cursor = replacement.end;
	}
	return output + content.slice(cursor);
}

async function regularFile(
	path: WorkspacePath,
	operations: WorkspaceOperations,
): Promise<Awaited<ReturnType<WorkspaceOperations["lstat"]>>> {
	const stat = await operations.lstat(path.absolute);
	if (!stat.isFile()) throw new Error(`Workspace path is not a regular file: ${path.relative}`);
	return stat;
}

async function mutate(
	boundary: WorkspaceBoundary,
	phase: MutationPhase,
	operations: WorkspaceOperations,
	inputPath: string,
	signal: AbortSignal | undefined,
	transform: (before: Buffer | null) => Promise<Buffer>,
): Promise<WorkspacePath> {
	const queueKey = boundary.mutationQueueKey(inputPath);
	return withFileMutationQueue(queueKey, async () => {
		throwIfAborted(signal);
		const path = await boundary.admit(inputPath);
		let before: Buffer | null;
		try {
			const stat = await regularFile(path, operations);
			if (stat.size > 10 * 1024 * 1024) throw new Error(`Workspace mutation input exceeds 10MB: ${path.relative}`);
			before = await operations.readFile(path.absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			before = null;
		}
		const token = phase.begin(path.relative, before);
		let writeStarted = false;
		let finished = false;
		try {
			const result = await transform(before);
			throwIfAborted(signal);
			await operations.mkdir(dirname(path.absolute));
			await boundary.admit(inputPath);
			throwIfAborted(signal);
			writeStarted = true;
			await operations.writeFile(path.absolute, result);
			const actual = await operations.readFile(path.absolute);
			phase.finish(token, actual);
			finished = true;
			throwIfAborted(signal);
			return path;
		} catch (error) {
			if (!finished) phase.abort(token, writeStarted);
			throw error;
		}
	});
}

export function createWorkspaceTools(
	boundary: WorkspaceBoundary,
	phase: MutationPhase,
	operations: WorkspaceOperations = defaultOperations,
): WorkspaceAgentTools {
	const read = defineTool({
		name: "workspace_read",
		label: "Read repository file",
		description: "Read one nonignored repository-relative text file",
		parameters: Type.Object(
			{
				path: pathSchema,
				offset: Type.Optional(Type.Integer({ minimum: 1 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, input, signal) {
			throwIfAborted(signal);
			const path = await boundary.admit(input.path);
			const stat = await regularFile(path, operations);
			if (stat.size > 10 * 1024 * 1024) throw new Error(`Workspace read input exceeds 10MB: ${path.relative}`);
			const content = await operations.readFile(path.absolute);
			const text = decodeText(content, path.relative);
			const lines = text.split("\n");
			const offset = input.offset ?? 1;
			const limit = input.limit ?? 2000;
			const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n");
			if (Buffer.byteLength(selected) > 50 * 1024) throw new Error("Workspace read exceeds 50KB; use offset and limit");
			throwIfAborted(signal);
			return { content: [{ type: "text" as const, text: selected }], details: { path: path.relative } };
		},
	}) as ToolDefinition;

	const search = defineTool({
		name: "workspace_search",
		label: "Search repository",
		description: "Search literal text in nonignored repository files",
		parameters: Type.Object(
			{
				query: Type.String({ minLength: 1, maxLength: 500 }),
				path: Type.Optional(pathSchema),
				maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, input, signal) {
			if (input.query.includes("\0")) throw new Error("Workspace search query contains NUL");
			const files = await boundary.searchableFiles(input.path);
			const matches: string[] = [];
			let scanned = 0;
			for (const path of files) {
				if (matches.length >= (input.maxResults ?? 100)) break;
				throwIfAborted(signal);
				let stat: Awaited<ReturnType<WorkspaceOperations["lstat"]>>;
				try {
					stat = await operations.lstat(path.absolute);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
				scanned++;
				let text: string;
				try {
					text = decodeText(await operations.readFile(path.absolute), path.relative);
				} catch {
					continue;
				}
				for (const [index, line] of text.split("\n").entries()) {
					if (line.includes(input.query)) matches.push(`${path.relative}:${index + 1}:${line}`);
					if (matches.length >= (input.maxResults ?? 100)) break;
				}
			}
			return { content: [{ type: "text" as const, text: matches.join("\n") || "No matches." }], details: { scanned } };
		},
	}) as ToolDefinition;

	const edit = defineTool({
		name: "workspace_edit",
		label: "Edit repository file",
		description: "Apply unique exact replacements to one nonignored repository-relative text file",
		parameters: editSchema,
		async execute(_id, input, signal) {
			const path = await mutate(boundary, phase, operations, input.path, signal, async (before) => {
				if (before === null) throw new Error(`Cannot edit missing file: ${input.path}`);
				return Buffer.from(applyEdits(decodeText(before, input.path), input.edits));
			});
			return { content: [{ type: "text" as const, text: `Edited ${path.relative}` }], details: { path: path.relative } };
		},
	}) as ToolDefinition;

	const write = defineTool({
		name: "workspace_write",
		label: "Write repository file",
		description: "Create or replace one nonignored repository-relative text file",
		parameters: Type.Object(
			{
				path: pathSchema,
				content: Type.String({ maxLength: 2_000_000 }),
			},
			{ additionalProperties: false },
		),
		async execute(_id, input, signal) {
			const path = await mutate(boundary, phase, operations, input.path, signal, async () => Buffer.from(input.content));
			return { content: [{ type: "text" as const, text: `Wrote ${path.relative}` }], details: { path: path.relative } };
		},
	}) as ToolDefinition;

	return { read, search, edit, write };
}
