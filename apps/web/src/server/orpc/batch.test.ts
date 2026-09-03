import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	type IngestionBatchShell,
	MemoryIngestionBatchRepository,
} from "@mailsentinel/db";
import { createRouterClient } from "@orpc/server";
import type { RpcContext } from "./context";
import { router } from "./router";

describe("Phase S13: Batch Router (batch.list, batch.get)", () => {
	const batch1: IngestionBatchShell = {
		id: "batch_01",
		organizationId: "org_alpha",
		caseId: "case_01",
		source: "upload_container",
		status: "ready",
		containerEvidenceId: "ev_container_1",
		messageCount: 5,
		readyCount: 5,
		failedCount: 0,
		metadata: { containerFormat: "mbox" },
		failureReason: null,
		createdAt: new Date("2026-09-01T10:00:00Z"),
		updatedAt: new Date("2026-09-01T10:05:00Z"),
	};

	const batch2: IngestionBatchShell = {
		id: "batch_02",
		organizationId: "org_alpha",
		caseId: "case_01",
		source: "mailbox_sync",
		status: "ready",
		containerEvidenceId: null,
		messageCount: 10,
		readyCount: 10,
		failedCount: 0,
		metadata: { provider: "gmail" },
		failureReason: null,
		createdAt: new Date("2026-09-01T11:00:00Z"),
		updatedAt: new Date("2026-09-01T11:02:00Z"),
	};

	const foreignBatch: IngestionBatchShell = {
		id: "batch_foreign",
		organizationId: "org_beta",
		caseId: "case_foreign",
		source: "upload_single",
		status: "ready",
		containerEvidenceId: null,
		messageCount: 1,
		readyCount: 1,
		failedCount: 0,
		metadata: {},
		failureReason: null,
		createdAt: new Date("2026-09-01T12:00:00Z"),
		updatedAt: new Date("2026-09-01T12:00:00Z"),
	};

	function createTestContext(overrides: Partial<RpcContext> = {}): {
		context: RpcContext;
		batchRepo: MemoryIngestionBatchRepository;
	} {
		const batchRepo = new MemoryIngestionBatchRepository([
			{ ...batch1 },
			{ ...batch2 },
			{ ...foreignBatch },
		]);

		const context: RpcContext = {
			requestId: "req_batch_test",
			userId: "user_viewer",
			organizationId: "org_alpha",
			role: "viewer",
			repos: {
				batches: batchRepo,
			},
			...overrides,
		};

		return { context, batchRepo };
	}

	describe("Authentication & Authorization", () => {
		const anonymousContext: RpcContext = {
			requestId: "req_anon",
			userId: null,
			organizationId: null,
		};

		it("rejects anonymous access with UNAUTHORIZED", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.batch.list({ caseId: "case_01" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			await expect(
				client.batch.get({ batchId: "batch_01" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("allows viewer, investigator, and owner to list and get batches", async () => {
			for (const role of ["viewer", "investigator", "owner"] as const) {
				const { context } = createTestContext({ role });
				const client = createRouterClient(router, { context });

				const list = await client.batch.list({ caseId: "case_01" });
				expect(list.items).toHaveLength(2);

				const getRes = await client.batch.get({ batchId: "batch_01" });
				expect(getRes?.id).toBe("batch_01");
			}
		});
	});

	describe("Tenant isolation & Pagination", () => {
		it("does not leak foreign organization batches", async () => {
			const { context } = createTestContext({ organizationId: "org_alpha" });
			const client = createRouterClient(router, { context });

			// foreignBatch belongs to org_beta
			const foreign = await client.batch.get({ batchId: "batch_foreign" });
			expect(foreign).toBeNull();
		});

		it("supports bounded pagination with cursor", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });

			const page1 = await client.batch.list({ caseId: "case_01", limit: 1 });
			expect(page1.items).toHaveLength(1);
			expect(page1.nextCursor).toBeDefined();

			const page2 = await client.batch.list({
				caseId: "case_01",
				limit: 1,
				cursor: page1.nextCursor,
			});
			expect(page2.items).toHaveLength(1);
			expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
		});
	});
});
