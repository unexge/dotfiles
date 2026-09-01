import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlAcceptedError, RunAuthority } from "../src/application/run-authority.ts";
import { attemptId } from "../src/application/types.ts";
import { PortableLeaseManager } from "../src/lease/repository-lease.ts";
import {
	AlreadyTerminalError,
	PublicationRecoveryRequiredError,
	RunStore,
} from "../src/store/run-store.ts";
import type { GitRepository } from "../src/vcs/types.ts";

const temporary: string[] = [];
const now = "2026-08-25T00:00:01.000Z";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-deep-publication-"));
	temporary.push(root);
	const store = new RunStore(root);
	const leases = new PortableLeaseManager(root);
	const initial = {
		schemaVersion: 1 as const,
		runId: randomUUID(),
		workflow: "build" as const,
		repositoryId: "a".repeat(64),
		policyDigest: "b".repeat(64),
		goal: "publish",
		createdAt: "2026-08-25T00:00:00.000Z",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastEventRevision: 0,
		lifecycle: "Queued" as const,
	};
	const ref = await store.create("git", initial);
	const repository: GitRepository = {
		kind: "git",
		root: "/repo",
		sharedRoot: "/repo/.git",
		commonDir: "/repo/.git",
		repositoryId: initial.repositoryId,
	};
	const authority = await RunAuthority.start(
		{
			store,
			leases,
			ref,
			repository,
			attemptId: attemptId(randomUUID()),
			phase: "commit",
			pollIntervalMs: 5,
		},
		{ ...initial, lastEventRevision: 1 },
		now,
	);
	return { root, store, leases, ref, repository, authority };
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("publication control transaction", () => {
	it("lets a control recorded before publication prevent the callback", async () => {
		const values = await fixture();
		const marker = await values.store.installPublicationMarker(values.ref, { transactionId: "one" });
		await values.store.appendControl(values.ref, "Pause", "2026-08-25T00:00:02.000Z");
		const publish = vi.fn();
		const abortPreparation = vi.fn();
		await expect(
			values.authority.publish({
				markerDigest: marker.digest,
				outcome: "LocalCommitCreated",
				summaryArtifact: "summary.json",
				at: "2026-08-25T00:00:03.000Z",
				publish,
				abortPreparation,
				align: vi.fn(),
			}),
		).rejects.toBeInstanceOf(ControlAcceptedError);
		expect(publish).not.toHaveBeenCalled();
		expect(abortPreparation).toHaveBeenCalledWith({ transactionId: "one" }, "Pause");
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Paused" });
		expect(await values.store.readPublicationMarker(values.ref)).toBeUndefined();
	});

	it("makes publication terminal before a later control can be admitted", async () => {
		const values = await fixture();
		const marker = await values.store.installPublicationMarker(values.ref, { transactionId: "two" });
		const result = await values.authority.publish({
			markerDigest: marker.digest,
			outcome: "LocalCommitCreated",
			summaryArtifact: "summary.json",
			at: "2026-08-25T00:00:02.000Z",
			publish: async () => "commit-id",
			abortPreparation: vi.fn(),
			align: vi.fn(),
		});
		expect(result).toBe("commit-id");
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed", outcome: "LocalCommitCreated" });
		await expect(values.store.appendControl(values.ref, "Cancel", "2026-08-25T00:00:03.000Z")).rejects.toBeInstanceOf(
			AlreadyTerminalError,
		);
		expect(await values.store.readPublicationMarker(values.ref)).toBeUndefined();
	});

	it("orders a concurrent control after publication holding the cross-process lock", async () => {
		const values = await fixture();
		const marker = await values.store.installPublicationMarker(values.ref, { transactionId: "concurrent" });
		let startPublish!: () => void;
		let finishPublish!: () => void;
		const started = new Promise<void>((resolve) => (startPublish = resolve));
		const finish = new Promise<void>((resolve) => (finishPublish = resolve));
		const publishing = values.authority.publish({
			markerDigest: marker.digest,
			outcome: "LocalCommitCreated",
			summaryArtifact: "summary.json",
			at: "2026-08-25T00:00:02.000Z",
			publish: async () => {
				startPublish();
				await finish;
				return "commit-id";
			},
			abortPreparation: vi.fn(),
			align: vi.fn(),
		});
		await started;
		let controlSettled = false;
		const control = values.store
			.appendControl(values.ref, "Cancel", "2026-08-25T00:00:03.000Z")
			.finally(() => (controlSettled = true));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(controlSettled).toBe(false);
		const rejected = expect(control).rejects.toBeInstanceOf(AlreadyTerminalError);
		finishPublish();
		expect(await publishing).toBe("commit-id");
		await rejected;
	});

	it("recovers prepared markers explicitly and rejects duplicate preparation", async () => {
		const values = await fixture();
		const marker = await values.store.installPublicationMarker(values.ref, { transactionId: "prepared" });
		await expect(values.store.installPublicationMarker(values.ref, { transactionId: "duplicate" })).rejects.toBeInstanceOf(
			PublicationRecoveryRequiredError,
		);
		await values.store.clearPreparedPublicationMarker(values.ref, marker.digest);
		expect(await values.store.readPublicationMarker(values.ref)).toBeUndefined();
		await values.authority.block("prepared transaction recovered", "2026-08-25T00:00:04.000Z");
	});

	it("maps malformed markers to recovery-required control errors", async () => {
		const values = await fixture();
		const directory = join(values.ref.directory, "publication");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "current.json"), "{ malformed", "utf8");
		await expect(values.store.appendControl(values.ref, "Cancel", now)).rejects.toBeInstanceOf(
			PublicationRecoveryRequiredError,
		);
	});

	it("retains a publishing marker and blocks controls when publication is uncertain", async () => {
		const values = await fixture();
		const marker = await values.store.installPublicationMarker(values.ref, { transactionId: "three" });
		await expect(
			values.authority.publish({
				markerDigest: marker.digest,
				outcome: "LocalCommitCreated",
				summaryArtifact: "summary.json",
				at: "2026-08-25T00:00:02.000Z",
				publish: async () => {
					throw new Error("CAS outcome unknown");
				},
				abortPreparation: vi.fn(),
				align: vi.fn(),
			}),
		).rejects.toThrow("CAS outcome unknown");
		expect((await values.store.readPublicationMarker(values.ref))?.phase).toBe("publishing");
		await expect(values.authority.block("must not transition", now)).rejects.toBeInstanceOf(
			PublicationRecoveryRequiredError,
		);
		await expect(values.store.appendControl(values.ref, "Cancel", now)).rejects.toBeInstanceOf(
			PublicationRecoveryRequiredError,
		);
		const current = await values.store.readPublicationMarker(values.ref);
		await values.store.withPublicationControl(values.ref, current!.digest, async (context) => context.clearMarker());
		await values.authority.block("recovered uncertain publication", "2026-08-25T00:00:04.000Z");
	});

	it("keeps terminal state and releases leases when post-publication alignment fails", async () => {
		const values = await fixture();
		const marker = await values.store.installPublicationMarker(values.ref, { transactionId: "four" });
		await expect(
			values.authority.publish({
				markerDigest: marker.digest,
				outcome: "LocalCommitCreated",
				summaryArtifact: "summary.json",
				at: "2026-08-25T00:00:02.000Z",
				publish: async () => "commit-id",
				abortPreparation: vi.fn(),
				align: async () => {
					throw new Error("index alignment failed");
				},
			}),
		).rejects.toThrow("index alignment failed");
		expect(await values.store.load(values.ref)).toMatchObject({ lifecycle: "Completed" });
		expect((await values.store.readPublicationMarker(values.ref))?.phase).toBe("aligning");
		await expect(values.store.appendControl(values.ref, "Cancel", now)).rejects.toBeInstanceOf(AlreadyTerminalError);
		expect((await values.store.readPublicationMarker(values.ref))?.phase).toBe("aligning");
		await expect(
			values.leases.acquire({
				scope: "repository",
				repositoryId: values.repository.repositoryId,
				runId: randomUUID(),
				attemptId: randomUUID(),
			}),
		).resolves.toBeTruthy();
	});
});
