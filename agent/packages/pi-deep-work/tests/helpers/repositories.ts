import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export type RepositoryFixtureKind = "git" | "jj-native" | "jj-colocated";

export interface CommandResult {
	stdout: string;
	stderr: string;
}

export interface RepositoryFixture {
	kind: RepositoryFixtureKind;
	root: string;
	run(command: string, args: string[]): Promise<CommandResult>;
	write(path: string, content: string): Promise<void>;
	sharedRepositoryIdentity(): Promise<string>;
	cleanup(): Promise<void>;
}

export function isolatedVcsEnvironment(home: string): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (
			["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].includes(
				key,
			) ||
			key.startsWith("GIT_CONFIG_KEY_") ||
			key.startsWith("GIT_CONFIG_VALUE_") ||
			["JJ_REPO", "JJ_WORKSPACE", "JJ_OP_ID"].includes(key)
		) {
			delete environment[key];
		}
	}
	return {
		...environment,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		JJ_CONFIG: "",
		JJ_USER: "Deep Test",
		JJ_EMAIL: "deep@example.test",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "Deep Test",
		GIT_AUTHOR_EMAIL: "deep@example.test",
		GIT_COMMITTER_NAME: "Deep Test",
		GIT_COMMITTER_EMAIL: "deep@example.test",
	};
}

export interface JjAvailability {
	available: boolean;
	diagnostic: string;
}

export async function detectJjAvailability(executable = "jj"): Promise<JjAvailability> {
	try {
		const result = await executeFile(executable, ["--version"], {
			cwd: tmpdir(),
			env: isolatedVcsEnvironment(tmpdir()),
		});
		return { available: true, diagnostic: result.stdout.trim() };
	} catch (error) {
		const failure = error as NodeJS.ErrnoException;
		return {
			available: false,
			diagnostic: failure.code === "ENOENT" ? "jj binary is not installed" : `jj is unavailable: ${failure.message}`,
		};
	}
}

async function runAt(root: string, home: string, command: string, args: string[]): Promise<CommandResult> {
	const result = await executeFile(command, args, {
		cwd: root,
		env: isolatedVcsEnvironment(home),
		maxBuffer: 10 * 1024 * 1024,
	});
	return { stdout: result.stdout, stderr: result.stderr };
}

export async function createRepositoryFixture(kind: RepositoryFixtureKind): Promise<RepositoryFixture> {
	const container = await mkdtemp(join(tmpdir(), `pi-deep-${kind}-`));
	const repositoryPath = join(container, "repo");
	const home = join(container, "home");
	try {
		await mkdir(repositoryPath);
		await mkdir(home);
		const root = await realpath(repositoryPath);
		if (kind === "git") {
			await runAt(root, home, "git", ["init", "-b", "main"]);
			await runAt(root, home, "git", ["config", "user.name", "Deep Test"]);
			await runAt(root, home, "git", ["config", "user.email", "deep@example.test"]);
		} else {
			await runAt(root, home, "jj", [
				"git",
				"init",
				kind === "jj-native" ? "--no-colocate" : "--colocate",
				root,
			]);
		}
		await writeFile(join(root, "README.md"), `${kind}\n`, "utf8");
		if (kind === "git") {
			await runAt(root, home, "git", ["add", "README.md"]);
			await runAt(root, home, "git", ["commit", "-m", "initial"]);
		} else {
			await runAt(root, home, "jj", ["commit", "-m", "initial"]);
		}

		return {
			kind,
			root,
			run: (command, args) => runAt(root, home, command, args),
			write: async (path, content) => writeFile(join(root, path), content, "utf8"),
			sharedRepositoryIdentity: async () => {
				const output =
					kind === "git"
						? (await runAt(root, home, "git", ["rev-parse", "--git-common-dir"])).stdout.trim()
						: (await runAt(root, home, "jj", ["git", "root"])).stdout.trim();
				return realpath(isAbsolute(output) ? output : join(root, output));
			},
			cleanup: () => rm(container, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(container, { recursive: true, force: true });
		throw error;
	}
}
