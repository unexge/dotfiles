import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentGateway, AgentResult, WorkspaceAgentTools } from "../src/agents/gateway.ts";
import type { RunAuthority } from "../src/application/run-authority.ts";
import { userOriginFromRegisteredCommand } from "../src/application/user-origin.ts";
import type { ResolvedModels } from "../src/policy/models.ts";
import { WorkflowRuntime } from "../src/service/runtime.ts";
import { DeepWorkService } from "../src/service/service.ts";
import { loadApprovedDesignContent } from "../src/service/continuation.ts";
import { canonicalJson } from "../src/policy/canonical-json.ts";
import { digestFrozenArtifact } from "../src/review/subjects.ts";
import { readBuildContext, readFixContext } from "../src/service/write-context.ts";
import type { RunRef } from "../src/store/run-store.ts";
import type { CommandRunner, DetectedRepository } from "../src/vcs/types.ts";
import { createRepositoryFixture, detectJjAvailability, isolatedVcsEnvironment, type RepositoryFixtureKind } from "./helpers/repositories.ts";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((f) => f())); });
const jj = await detectJjAvailability();
const runner: CommandRunner = async (command, args, options) => {
	try {
		const result = await exec(command, [...args], { cwd: options.cwd, env: { ...isolatedVcsEnvironment(tmpdir()), ...options.env }, maxBuffer: 20 * 1024 * 1024 });
		return { code: 0, ...result };
	} catch (error) {
		const e = error as Error & { code?: number; stdout?: string; stderr?: string };
		return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
	}
};

class ContinuationRuntime extends WorkflowRuntime {
	workflow: "build" | "fix" = "build";
	designReject = false;
	designBlock = false;
	designRejections = 0;
	codeMode: "reject" | "block" | "approve" = "reject";
	blockAfterRepair = false;
	mutations: string[] = [];
	tasks: string[] = [];
	reviewTasks: Array<{ kind: string; task: string }> = [];
	designCount = 0;
	protected override createGateway(authority: RunAuthority, _repo: DetectedRepository, _models: ResolvedModels, _tools: WorkspaceAgentTools): AgentGateway {
		return {
			assertAuthority: (value: RunAuthority) => { expect(value).toBe(authority); },
			run: async (job: { kind: string; task: string }) => {
				this.tasks.push(job.task);
				const common = { status: "ok", summary: "fixture", citations: [] };
				if (job.kind === "plan") return { report: { value: { ...common, interpretation: "feature", successCriteria: ["works"], steps: ["implement"] } } };
				if (job.kind === "explore") return { report: { value: { ...common, components: ["feature"], flow: ["bug"], constraints: [], unknowns: [] } } };
				return { report: { value: { ...common, summary: `design-${++this.designCount}`, usage: "feature", constraints: [], decisions: [{ decision: "fix state", rationale: "owns bug" }], dataShape: "state", interfaces: [], modules: ["feature.txt"], invariants: ["passes"], alternatives: [], tradeoffs: [], verification: ["behavior"], openQuestions: [], testSelectors: this.workflow === "fix" ? [{ selectorId: "regression-path", value: "tests/behavior.rs" }] : [] } } };
			},
			withWorkspaceTools: (tools: WorkspaceAgentTools) => ({
				runMutation: async (job: { kind: string; label: string; task: string }) => {
					this.tasks.push(job.task);
					const regression = job.label.includes("regression");
					this.mutations.push(regression ? "regression" : job.kind);
					const path = regression ? "tests/behavior.rs" : job.kind === "repair" ? "repair.txt" : "feature.txt";
					const content = regression ? "regression\n" : job.kind === "repair" ? `repair-${this.mutations.length}\n` : "fixed\n";
					await tools.write.execute("mutation", { path, content }, undefined, () => undefined, undefined as never);
					if (job.kind === "repair" && this.blockAfterRepair) this.codeMode = "block";
					return { report: { value: { status: "ok", summary: "changed", citations: [], changes: [{ path, detail: "changed" }], testSelectors: [] } } };
				},
			}),
			runManySettled: async (jobs: Array<{ kind: "review-design" | "review-code"; task: string }>) => jobs.map((job) => {
				this.reviewTasks.push(job);
				if (job.kind === "review-code" && this.codeMode === "block") return { ok: false, error: "reviewer unavailable" };
				if (job.kind === "review-design" && this.designBlock) return { ok: false, error: "design reviewer unavailable" };
				const reject = job.kind === "review-design" ? this.designReject || this.designRejections-- > 0 : this.codeMode === "reject";
				const result: AgentResult<typeof job.kind> = {
					kind: job.kind, role: job.kind === "review-design" ? "design-reviewer" : "code-reviewer", model: "test/reviewer", turns: 1,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
					report: { source: "untrusted-agent", value: { status: "ok", summary: "review", citations: [], verdict: reject ? "changes_required" : "approve", findings: reject ? [{ id: "gap", severity: "important", title: "Gap", detail: "repair required", evidence: ["fixture"], recommendation: "fix" }] : [] } },
				};
				return { ok: true, result };
			}),
			runSettled: async () => ({ ok: false, error: "unused" }),
		} as unknown as AgentGateway;
	}
}

async function fixture(workflow: "build" | "fix", kind: RepositoryFixtureKind = "git", rounds = 0) {
	const repo = await createRepositoryFixture(kind);
	const agentDir = await mkdtemp(join(tmpdir(), "deep-continuation-"));
	cleanup.push(repo.cleanup, () => rm(agentDir, { recursive: true, force: true }));
	if (kind !== "git") await repo.run("jj", ["bookmark", "create", "main", "-r", "@-"]);
	await mkdir(join(repo.root, ".pi"));
	await writeFile(join(repo.root, ".pi/pi-deep-work.json"), JSON.stringify({ schemaVersion: 1, mainline: "main", quickGates: [], fullGates: [], normalizers: [], observations: [], verificationContracts: [], selectors: [], languageScopes: [] }));
	if (kind === "git") { await repo.run("git", ["add", ".pi"]); await repo.run("git", ["commit", "-m", "policy"]); }
	else { await repo.run("jj", ["commit", "-m", "policy"]); await repo.run("jj", ["bookmark", "set", "main", "-r", "@-"]); }
	await mkdir(join(agentDir, "pi-deep-work"));
	const pass = [process.execPath, "-e", "process.exit(0)"];
	await writeFile(join(agentDir, "pi-deep-work/config.json"), JSON.stringify({ schemaVersion: 2, models: { orchestrator: { provider: "test", id: "orchestrator", thinkingLevel: "high" }, reviewers: [{ provider: "test", id: "reviewer", thinkingLevel: "high" }] }, concurrency: 1, maxRepairRounds: rounds, commandTimeoutMs: 10000, minimumQuickGates: [{ id: "quick", languages: ["rust"], argv: pass, timeoutMs: 2000 }], minimumFullGates: [{ id: "full", languages: ["rust"], argv: pass, timeoutMs: 2000 }], observations: [{ id: "behavior", claimKeys: ["behavior.ok"], argv: [process.execPath, "-e", "const fs=require('fs'); process.exit(fs.existsSync('feature.txt') ? 0 : 1)"], timeoutMs: 2000 }], selectors: [{ id: "regression-path", language: "rust", observationId: "behavior", valuePattern: ".+\\.rs" }], verificationContracts: [] }));
	const runtime = new ContinuationRuntime(agentDir, runner, () => ({}) as ResolvedModels);
	runtime.workflow = workflow;
	const ui = { theme: { fg: (_color: string, value: string) => value }, select: vi.fn(async () => "Edit all at once"), editor: vi.fn(async () => "Keep the exact design and repair the gap."), confirm: vi.fn(async () => true), notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() };
	const ctx = { cwd: repo.root, hasUI: true, isProjectTrusted: () => true, modelRegistry: {}, ui } as unknown as ExtensionCommandContext;
	const messages: Array<{ details: { runId: string } }> = [];
	const service = new DeepWorkService({ appendEntry() {}, sendMessage(message: { details: { runId: string } }) { messages.push(message); } } as unknown as ExtensionAPI, runtime);
	const origin = userOriginFromRegisteredCommand("feature goal");
	const resolve = async (ref: RunRef) => {
		await service.execute({ kind: "resolve", runId: ref.runId, accept: false }, origin, ctx);
		return runtime.store.find(messages.at(-1)!.details.runId);
	};
	return { repo, runtime, service, ctx, ui, origin, resolve, start: () => runtime.start({ workflow, origin }, ctx) };
}

describe("durable public continuation", () => {
	for (const workflow of ["build", "fix"] as const) {
		it(`${workflow} resolves multiple implemented generations without reimplementing`, async () => {
			const f = await fixture(workflow);
			const first = await f.start();
			expect(first.state).toMatchObject({ lifecycle: "Completed", outcome: "ChangesRequired" });
			f.ui.editor.mockResolvedValueOnce("First decision: preserve cancellation");
			const second = await f.resolve(first.ref);
			f.ui.editor.mockResolvedValueOnce("Second decision: no scheduler");
			const third = await f.resolve(second);
			const review = f.runtime.reviewTasks.at(-1)!.task;
			expect(review).toContain("First decision: preserve cancellation");
			expect(review).toContain("Second decision: no scheduler");
			expect(review).toContain('"decision":"fix state"');
			expect(review).toContain('"claimKeys":["behavior.ok"]');
			expect(await f.runtime.store.load(third)).toMatchObject({ lifecycle: "Completed", outcome: "ChangesRequired" });
			expect(f.runtime.mutations.filter((kind) => kind === "implement")).toHaveLength(1);
			const context = workflow === "build" ? await readBuildContext(f.runtime.store, third) : await readFixContext(f.runtime.store, third);
			expect(context?.stage).toBe("implemented");
		}, 60000);

		it(`${workflow} resumes a linked blocked repair from its own newest checkpoint`, async () => {
			const f = await fixture(workflow, "git", 1);
			const first = await f.start();
			expect(first.state).toMatchObject({ outcome: "ChangesRequired" });
			f.runtime.blockAfterRepair = true;
			f.ui.editor.mockResolvedValueOnce("Keep cancellation during repair.");
			const linked = await f.resolve(first.ref);
			expect(await f.runtime.store.load(linked)).toMatchObject({ lifecycle: "Blocked" });
			f.runtime.codeMode = "approve";
			await f.service.execute({ kind: "resume", runId: linked.runId }, f.origin, f.ctx);
			expect(await f.runtime.store.load(linked)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
			expect(f.runtime.reviewTasks.at(-1)!.task).toContain("Keep cancellation during repair.");
			expect(f.runtime.mutations.filter((kind) => kind === "implement")).toHaveLength(1);
		}, 60000);
	}

	it("red fix resolves preserve each rejected design and eventually implement", async () => {
		const f = await fixture("fix", "git", 1);
		f.runtime.designReject = true;
		const first = await f.start();
		expect(first.state).toMatchObject({ outcome: "ChangesRequired" });
		const second = await f.resolve(first.ref);
		const output = JSON.parse((await f.runtime.store.readArtifact(second, "outputs/fix.json")).toString());
		expect(output.design.summary).toBe("design-4");
		const reviews = f.runtime.reviewTasks.filter((job) => job.kind === "review-design");
		expect(reviews.at(-1)!.task).toContain("Keep the exact design and repair the gap.");
		expect(reviews.at(-1)!.task).toContain('"summary":"design-3"');
		expect((await readFixContext(f.runtime.store, second))?.stage).toBe("red");
		f.runtime.designReject = false;
		f.runtime.designRejections = 1;
		const third = await f.resolve(second);
		expect(f.runtime.tasks.some((task) => task.includes('"summary":"design-4"'))).toBe(true);
		expect(await f.runtime.store.load(third)).toMatchObject({ outcome: "ChangesRequired" });
		const context = (await readFixContext(f.runtime.store, third))!;
		if (context.stage === "red") throw new Error("expected approved fix");
		const approved = await loadApprovedDesignContent(f.runtime.store, third, context.approvedDesign);
		expect(JSON.parse(approved).summary).toBe("design-6");
		expect(context.approvedDesign.design.artifactDigest).toBe(digestFrozenArtifact(approved));
		expect(f.runtime.mutations.filter((kind) => kind === "implement")).toHaveLength(1);
	}, 60000);

	for (const workflow of ["build", "fix"] as const) {
		it(`${workflow} recovers missing linked contexts without rewriting ancestors`, async () => {
			const f = await fixture(workflow);
			const first = await f.start();
			const second = await f.resolve(first.ref);
			const path = `workflow/${workflow}-context.json`;
			const ancestor = await f.runtime.store.readArtifact(first.ref, path);
			await rm(join(second.directory, "artifacts", path));
			const third = await f.resolve(second);
			expect(await f.runtime.store.load(third)).toMatchObject({ outcome: "ChangesRequired" });
			expect(await f.runtime.store.readArtifact(first.ref, path)).toEqual(ancestor);
			expect(await f.runtime.store.readOptionalArtifact(second, path)).toBeUndefined();
			expect(f.runtime.mutations.filter((kind) => kind === "implement")).toHaveLength(1);
		}, 60000);
	}

	it("resumes a blocked red fix through bounded revision and verifies the final approved bytes", async () => {
		const f = await fixture("fix", "git", 1);
		f.runtime.designBlock = true;
		const first = await f.start();
		expect(first.state.lifecycle).toBe("Blocked");
		f.runtime.designBlock = false;
		f.runtime.designRejections = 1;
		f.runtime.codeMode = "approve";
		await f.service.execute({ kind: "resume", runId: first.ref.runId }, f.origin, f.ctx);
		expect(await f.runtime.store.load(first.ref)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
		const context = (await readFixContext(f.runtime.store, first.ref))!;
		if (context.stage === "red") throw new Error("expected approved fix");
		const approved = await loadApprovedDesignContent(f.runtime.store, first.ref, context.approvedDesign);
		expect(JSON.parse(approved).summary).toBe("design-3");
		expect(context.approvedDesign.design.artifactDigest).toBe(digestFrozenArtifact(approved));
		expect(f.runtime.reviewTasks.at(-1)!.task).toContain(approved);
	}, 60000);

	it("loads exact approved bytes locally and through validated linked owners", async () => {
		const f = await fixture("build");
		const first = await f.start();
		const second = await f.resolve(first.ref);
		const context = (await readBuildContext(f.runtime.store, second))!;
		const original = (await f.runtime.store.readArtifact(first.ref, context.approvedDesign.design.artifactPath)).toString();
		expect(await loadApprovedDesignContent(f.runtime.store, second, context.approvedDesign)).toBe(original);
		await rm(join(first.ref.directory, "artifacts/run/request.json"));
		expect(await loadApprovedDesignContent(f.runtime.store, first.ref, context.approvedDesign)).toBe(original);
	}, 60000);

	it.each(["design", "missing-design", "mutation", "missing-checkpoint", "red-claims", "wrong-phase", "checkout", "stale-parent"] as const)("rejects %s evidence before collecting feedback", async (fault) => {
		const f = await fixture("fix", "git", fault === "stale-parent" ? 1 : 0);
		const first = await f.start();
		const context = (await readFixContext(f.runtime.store, first.ref))!;
		if (context.stage !== "implemented") throw new Error("expected implemented fixture");
		if (fault === "design") await f.runtime.store.writeArtifact(first.ref, context.approvedDesign.design.artifactPath, "{}");
		if (fault === "missing-design") await rm(join(first.ref.directory, "artifacts", context.approvedDesign.design.artifactPath));
		if (fault === "missing-checkpoint") {
			const checkpoint = context.implementationCheckpoint;
			await rm(join(first.ref.directory, "checkpoints", checkpoint.attemptId, `${String(checkpoint.sequence).padStart(8, "0")}-${checkpoint.phase}.json`));
		}
		if (fault === "mutation") await f.runtime.store.writeArtifact(first.ref, context.regressionCheckpoint.mutation.artifact, "{}");
		if (fault === "red-claims") await f.runtime.store.writeArtifact(first.ref, "workflow/fix-context.json", canonicalJson({ ...context, redEvidence: { ...context.redEvidence, claimKeys: ["foreign.claim"] } }));
		if (fault === "wrong-phase") await f.runtime.store.writeArtifact(first.ref, "workflow/fix-context.json", canonicalJson({ ...context, implementationCheckpoint: context.regressionCheckpoint }));
		if (fault === "checkout") await f.repo.write("feature.txt", "operator edit\n");
		if (fault === "stale-parent") await rm(join(f.repo.root, "repair.txt"));
		await expect(f.resolve(first.ref)).rejects.toThrow(/digest|implement\/repair|checkout|red evidence|missing|ENOENT/);
		expect(f.ui.select).not.toHaveBeenCalled();
	}, 60000);

	it.each(["foreign", "cycle", "summary", "goal"] as const)("rejects %s lineage before collecting feedback", async (fault) => {
		const f = await fixture("build");
		const first = await f.start();
		const second = await f.resolve(first.ref);
		const requestPath = join(second.directory, "artifacts/run/request.json");
		const request = JSON.parse(await readFile(requestPath, "utf8"));
		if (fault === "summary") request.resolutionArtifactDigest = "0".repeat(64);
		if (fault === "goal") request.goal = "another goal";
		if (fault === "cycle") {
			request.resolutionSourceRunId = second.runId;
			request.resolutionArtifactDigest = digestFrozenArtifact(await f.runtime.store.readArtifact(second, "outputs/build.json"));
		}
		if (fault === "foreign") {
			const other = await fixture("build");
			const foreign = await other.start();
			// The store locator spans repositories under this agent directory.
			const { cp } = await import("node:fs/promises");
			const destination = join(f.runtime.agentDir, "pi-deep-work/runs", `git-${foreign.ref.repositoryId}`, foreign.ref.runId);
			await cp(foreign.ref.directory, destination, { recursive: true });
			request.resolutionSourceRunId = foreign.ref.runId;
			request.resolutionArtifactDigest = digestFrozenArtifact(await other.runtime.store.readArtifact(foreign.ref, "outputs/build.json"));
		}
		await writeFile(requestPath, canonicalJson(request));
		f.ui.select.mockClear();
		await expect(f.resolve(second)).rejects.toThrow(/lineage|digest|metadata/);
		expect(f.ui.select).not.toHaveBeenCalled();
	}, 60000);

	it("does not relabel an ancestor as a missing latest rejected fix design", async () => {
		const f = await fixture("fix");
		f.runtime.designReject = true;
		const first = await f.start();
		const second = await f.resolve(first.ref);
		await rm(join(second.directory, "artifacts/workflow/fix-context.json"));
		const output = JSON.parse((await f.runtime.store.readArtifact(second, "outputs/fix.json")).toString());
		delete output.design;
		delete output.designDigest;
		await f.runtime.store.writeArtifact(second, "outputs/fix.json", canonicalJson(output));
		f.ui.select.mockClear();
		await expect(f.resolve(second)).rejects.toThrow("Latest rejected fix design bytes are missing");
		expect(f.ui.select).not.toHaveBeenCalled();
	}, 60000);

	it("rechecks design-only resolution lineage under lease", async () => {
		const f = await fixture("build");
		f.runtime.designReject = true;
		const first = await f.start();
		const source = await f.runtime.prepareResolution(first.ref, f.ctx);
		f.runtime.designReject = false;
		await expect(f.runtime.start({ workflow: "build", origin: f.origin, resolutionSource: { ...source, feedback: "repair design" } }, f.ctx, {
			onStarted: () => writeFileSync(join(first.ref.directory, "artifacts/outputs/build.json"), "{}"),
		})).rejects.toThrow(/artifact digest/);
		expect(f.runtime.mutations).toEqual([]);
	}, 60000);

	it("rechecks the checkout under lease before linked work", async () => {
		const f = await fixture("build");
		const first = await f.start();
		const source = await f.runtime.prepareResolution(first.ref, f.ctx);
		const result = await f.runtime.start({ workflow: "build", origin: f.origin, resolutionSource: { ...source, feedback: "repair gap" } }, f.ctx, {
			onStarted: () => writeFileSync(join(f.repo.root, "feature.txt"), "changed after lease\n"),
		});
		expect(result.state).toMatchObject({ lifecycle: "NeedsManualInspection" });
		expect(f.runtime.mutations).toEqual(["implement"]);
	}, 60000);

	for (const workflow of ["build", "fix"] as const) {
		it.runIf(jj.available)(`JJ continues linked ${workflow} generations`, async () => {
			const f = await fixture(workflow, "jj-native");
			const first = await f.start();
			expect(first.state).toMatchObject({ outcome: "ChangesRequired" });
			const second = await f.resolve(first.ref);
			f.runtime.codeMode = "approve";
			const third = await f.resolve(second);
			expect(await f.runtime.store.load(third)).toMatchObject({ outcome: "LocalCommitCreated" });
		}, 60000);
	}
});
