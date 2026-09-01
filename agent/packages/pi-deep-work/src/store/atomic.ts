import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function syncParentDirectory(path: string): Promise<void> {
	await syncDirectory(dirname(path));
}

export async function ensureDirectoryDurable(directory: string): Promise<void> {
	try {
		if ((await stat(directory)).isDirectory()) return;
		throw new Error(`Path exists and is not a directory: ${directory}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const parent = dirname(directory);
	if (parent !== directory) await ensureDirectoryDurable(parent);
	try {
		await mkdir(directory, { mode: 0o700 });
		await syncDirectory(parent);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

async function writeTemporary(path: string, content: string | Buffer): Promise<string> {
	await ensureDirectoryDurable(dirname(path));
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return temporary;
}

export async function writeAtomic(path: string, content: string | Buffer): Promise<void> {
	const temporary = await writeTemporary(path, content);
	try {
		await rename(temporary, path);
		await syncParentDirectory(path);
	} finally {
		await unlink(temporary).catch((error) => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}
}

export async function writeImmutable(path: string, content: string | Buffer): Promise<void> {
	const temporary = await writeTemporary(path, content);
	try {
		await link(temporary, path);
		await syncParentDirectory(path);
	} finally {
		await unlink(temporary).catch((error) => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}
}
