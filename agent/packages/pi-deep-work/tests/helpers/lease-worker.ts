import { PortableLeaseManager } from "../../src/lease/repository-lease.ts";

const [agentDir, scope, repositoryId, runId, attemptId, holdMs] = process.argv.slice(2);
const manager = new PortableLeaseManager(agentDir);
try {
	const handle = await manager.acquire({
		scope: scope as "repository" | "run",
		...(repositoryId === "-" ? {} : { repositoryId }),
		runId,
		attemptId,
	});
	process.stdout.write("acquired\n");
	await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
	await handle.release();
	process.stdout.write("released\n");
} catch (error) {
	process.stdout.write(`blocked:${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}
