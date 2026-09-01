import { runSupervisedCommand } from "../../src/gates/supervised-command.ts";

const [startedPath, latePath] = process.argv.slice(2);
await runSupervisedCommand(
	[
		process.execPath,
		"-e",
		`const fs=require("fs"); fs.writeFileSync(${JSON.stringify(startedPath)}, "started"); setTimeout(() => fs.writeFileSync(${JSON.stringify(latePath)}, "late"), 2000); setInterval(() => {}, 1000)`,
	],
	process.cwd(),
	10_000,
	new AbortController().signal,
);
