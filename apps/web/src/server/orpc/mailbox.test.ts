import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Default mock for env: flag disabled by default
vi.mock("@/env", () => ({
	env: {
		MAILBOX_CONNECTORS_ENABLED: false,
		MAILBOX_TOKEN_ENCRYPTION_KEY:
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		GMAIL_CLIENT_ID: "test-client-id",
		GMAIL_CLIENT_SECRET: "test-client-secret",
	},
}));

import {
	type AuditRecordShell,
	type CaseShell,
	type MailboxConnectionShell,
	MemoryAuditRepository,
	MemoryCaseRepository,
	MemoryEvidenceRepository,
	MemoryIngestionBatchRepository,
	MemoryMailboxConnectionRepository,
} from "@mailsentinel/db";
import { createRouterClient } from "@orpc/server";
import { env } from "@/env";
import { MemoryAnalyzerClient } from "@/server/analyzer-client";
import { MemoryGmailClient } from "@/server/mailbox/client";
import { encryptToken } from "@/server/mailbox/crypto";
import { MemoryEvidenceStorage } from "@/server/storage/s3";
import type { RpcContext } from "./context";
import { router } from "./router";

describe("Phase S13: Mailbox Router (list, status, startSync, disconnect)", () => {
	const testKey =
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	const enc1 = encryptToken("mock_refresh_token_valid", testKey);
	const encForeign = encryptToken("mock_refresh_token_foreign", testKey);

	const connection1: MailboxConnectionShell = {
		id: "conn_alpha",
		organizationId: "org_alpha",
		provider: "gmail",
		accountEmail: "investigator@company.com",
		encryptedRefreshToken: enc1.encryptedRefreshToken,
		tokenNonce: enc1.tokenNonce,
		scopes: "https://www.googleapis.com/auth/gmail.readonly",
		syncCursor: "5000",
		status: "connected",
		lastSyncedAt: new Date("2026-09-01T12:00:00Z"),
		lastFailureReason: null,
		createdByUserId: "user_owner",
		createdAt: new Date("2026-09-01T10:00:00Z"),
		updatedAt: new Date("2026-09-01T12:00:00Z"),
	};

	const connectionForeign: MailboxConnectionShell = {
		id: "conn_foreign",
		organizationId: "org_beta",
		provider: "gmail",
		accountEmail: "other@other.com",
		encryptedRefreshToken: encForeign.encryptedRefreshToken,
		tokenNonce: encForeign.tokenNonce,
		scopes: "https://www.googleapis.com/auth/gmail.readonly",
		syncCursor: "100",
		status: "connected",
		lastSyncedAt: null,
		lastFailureReason: null,
		createdByUserId: "user_other",
		createdAt: new Date("2026-09-01T10:00:00Z"),
		updatedAt: new Date("2026-09-01T10:00:00Z"),
	};

	const testCase: CaseShell = {
		id: "case_01",
		organizationId: "org_alpha",
		title: "Investigation Case",
		createdAt: new Date("2026-09-01T00:00:00Z"),
		updatedAt: new Date("2026-09-01T00:00:00Z"),
	};

	function createTestContext(overrides: Partial<RpcContext> = {}): {
		context: RpcContext;
		mailboxRepo: MemoryMailboxConnectionRepository;
		auditRepo: MemoryAuditRepository;
		auditList: AuditRecordShell[];
	} {
		const mailboxRepo = new MemoryMailboxConnectionRepository([
			{ ...connection1 },
			{ ...connectionForeign },
		]);
		const auditList: AuditRecordShell[] = [];
		const auditRepo = new MemoryAuditRepository(auditList);
		const caseRepo = new MemoryCaseRepository([{ ...testCase }]);
		const batchRepo = new MemoryIngestionBatchRepository([]);
		const evidenceRepo = new MemoryEvidenceRepository([]);

		const context: RpcContext = {
			requestId: "req_mailbox_test",
			userId: "user_owner",
			organizationId: "org_alpha",
			role: "owner",
			repos: {
				mailbox: mailboxRepo,
				audit: auditRepo,
				cases: caseRepo,
				batches: batchRepo,
				evidence: evidenceRepo,
			},
			storage: new MemoryEvidenceStorage(),
			analyzerClient: new MemoryAnalyzerClient(),
			gmailClient: new MemoryGmailClient(),
			...overrides,
		};

		return { context, mailboxRepo, auditRepo, auditList };
	}

	describe("Feature Flag Gating (MAILBOX_CONNECTORS_ENABLED = false)", () => {
		beforeEach(() => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = false;
		});

		it("rejects mailbox.list with FORBIDDEN when disabled", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			await expect(client.mailbox.list()).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("rejects mailbox.status with FORBIDDEN when disabled", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			await expect(
				client.mailbox.status({ connectionId: "conn_alpha" }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("rejects mailbox.startSync with FORBIDDEN when disabled", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			await expect(
				client.mailbox.startSync({
					connectionId: "conn_alpha",
					caseId: "case_01",
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("rejects mailbox.disconnect with FORBIDDEN when disabled", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			await expect(
				client.mailbox.disconnect({ connectionId: "conn_alpha" }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});
	});

	describe("Role Matrix & Functionality (MAILBOX_CONNECTORS_ENABLED = true)", () => {
		beforeEach(() => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = true;
		});

		it("allows viewer to list and view status", async () => {
			const { context } = createTestContext({ role: "viewer" });
			const client = createRouterClient(router, { context });

			const list = await client.mailbox.list();
			expect(list.items).toHaveLength(1);
			expect(list.items[0]?.id).toBe("conn_alpha");
			expect(list.items[0]?.accountEmail).toBe("investigator@company.com");

			const status = await client.mailbox.status({
				connectionId: "conn_alpha",
			});
			expect(status?.id).toBe("conn_alpha");
		});

		it("never exposes encrypted tokens or nonces in browser responses", async () => {
			const { context } = createTestContext({ role: "viewer" });
			const client = createRouterClient(router, { context });

			const list = await client.mailbox.list();
			const serialized = JSON.stringify(list);
			expect(serialized).not.toContain("deadbeef");
			expect(serialized).not.toContain("tokenNonce");
			expect(serialized).not.toContain("encryptedRefreshToken");

			const status = await client.mailbox.status({
				connectionId: "conn_alpha",
			});
			const serializedStatus = JSON.stringify(status);
			expect(serializedStatus).not.toContain("deadbeef");
			expect(serializedStatus).not.toContain("tokenNonce");
			expect(serializedStatus).not.toContain("encryptedRefreshToken");
		});

		it("rejects viewer from calling startSync with FORBIDDEN", async () => {
			const { context } = createTestContext({ role: "viewer" });
			const client = createRouterClient(router, { context });

			await expect(
				client.mailbox.startSync({
					connectionId: "conn_alpha",
					caseId: "case_01",
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("allows investigator to start sync", async () => {
			const { context } = createTestContext({ role: "investigator" });
			const client = createRouterClient(router, { context });

			// With mock gmail client
			const result = await client.mailbox.startSync({
				connectionId: "conn_alpha",
				caseId: "case_01",
			});
			expect(result.status).toBeDefined();
			expect(result.batchId).toBeDefined();
		});

		it("rejects investigator and viewer from calling disconnect with FORBIDDEN", async () => {
			for (const role of ["viewer", "investigator"] as const) {
				const { context } = createTestContext({ role });
				const client = createRouterClient(router, { context });

				await expect(
					client.mailbox.disconnect({ connectionId: "conn_alpha" }),
				).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
			}
		});

		it("allows owner to disconnect mailbox", async () => {
			const { context, mailboxRepo, auditList } = createTestContext({
				role: "owner",
			});
			const client = createRouterClient(router, { context });

			const res = await client.mailbox.disconnect({
				connectionId: "conn_alpha",
			});
			expect(res.success).toBe(true);

			// Connection removed
			const remaining = await mailboxRepo.listConnections({
				organizationId: "org_alpha",
			});
			expect(remaining).toHaveLength(0);

			// Audit logged
			const audit = auditList.find((r) => r.action === "mailbox.disconnected");
			expect(audit).toBeDefined();
			expect(audit?.resourceId).toBe("conn_alpha");
		});

		it("enforces cross-tenant isolation", async () => {
			const { context } = createTestContext({
				organizationId: "org_alpha",
				role: "owner",
			});
			const client = createRouterClient(router, { context });

			// foreign connection belongs to org_beta
			const foreign = await client.mailbox.status({
				connectionId: "conn_foreign",
			});
			expect(foreign).toBeNull();

			await expect(
				client.mailbox.disconnect({ connectionId: "conn_foreign" }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});
	});
});
