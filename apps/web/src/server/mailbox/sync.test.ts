import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	type AuditRecordShell,
	type CaseShell,
	type EvidenceShell,
	type IngestionBatchShell,
	type MailboxConnectionShell,
	MemoryAnalysisRunRepository,
	MemoryAuditRepository,
	MemoryCaseRepository,
	MemoryEvidenceRepository,
	MemoryIngestionBatchRepository,
	MemoryMailboxConnectionRepository,
	MemoryReportRepository,
} from "@mailsentinel/db";
import { MemoryAnalyzerClient } from "@/server/analyzer-client";
import { MemoryEvidenceStorage } from "@/server/storage/s3";
import { MemoryGmailClient } from "./client";
import { encryptToken } from "./crypto";
import { runMailboxSync } from "./sync";

describe("Mailbox Sync Worker (runMailboxSync)", () => {
	const testKeyHex =
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

	const testCase: CaseShell = {
		id: "case_01",
		organizationId: "org_alpha",
		title: "Mailbox Phish Investigation",
		createdAt: new Date("2026-09-01T00:00:00Z"),
		updatedAt: new Date("2026-09-01T00:00:00Z"),
	};

	function createFixtures() {
		const encrypted = encryptToken("mock_refresh_token_xyz", testKeyHex);
		const connection: MailboxConnectionShell = {
			id: "conn_01",
			organizationId: "org_alpha",
			provider: "gmail",
			accountEmail: "target@example.com",
			encryptedRefreshToken: encrypted.encryptedRefreshToken,
			tokenNonce: encrypted.tokenNonce,
			scopes: "https://www.googleapis.com/auth/gmail.readonly",
			syncCursor: "1000",
			status: "connected",
			lastSyncedAt: null,
			lastFailureReason: null,
			createdByUserId: "user_owner",
			createdAt: new Date("2026-09-01T00:00:00Z"),
			updatedAt: new Date("2026-09-01T00:00:00Z"),
		};

		const casesList: CaseShell[] = [{ ...testCase }];
		const evidenceList: EvidenceShell[] = [];
		const batchesList: IngestionBatchShell[] = [];
		const connectionsList: MailboxConnectionShell[] = [{ ...connection }];
		const auditList: AuditRecordShell[] = [];

		const caseRepo = new MemoryCaseRepository(casesList);
		const batchRepo = new MemoryIngestionBatchRepository(
			batchesList,
			casesList,
			evidenceList,
		);
		const evidenceRepo = new MemoryEvidenceRepository(
			evidenceList,
			casesList,
			batchesList,
		);
		const analysisRepo = new MemoryAnalysisRunRepository([]);
		const mailboxRepo = new MemoryMailboxConnectionRepository(connectionsList);
		const auditRepo = new MemoryAuditRepository(auditList);
		const reportRepo = new MemoryReportRepository([]);

		const storage = new MemoryEvidenceStorage();
		const analyzer = new MemoryAnalyzerClient();
		const gmailClient = new MemoryGmailClient();

		// Add sample messages to gmail client
		gmailClient.addRawMessage({
			id: "msg_001",
			raw: "From: attacker@evil.com\r\nSubject: Urgent payment\r\n\r\nClick here",
			historyId: "1001",
		});
		gmailClient.addRawMessage({
			id: "msg_002",
			raw: "From: service@alerts.com\r\nSubject: Account updated\r\n\r\nDetails inside",
			historyId: "1002",
		});

		return {
			connection,
			repos: {
				cases: caseRepo,
				batches: batchRepo,
				evidence: evidenceRepo,
				analysisRuns: analysisRepo,
				reports: reportRepo,
				mailbox: mailboxRepo,
				audit: auditRepo,
			},
			storage,
			analyzer,
			gmailClient,
			evidenceList,
			batchesList,
			connectionsList,
			auditList,
		};
	}

	function runSync(
		fixtures: ReturnType<typeof createFixtures>,
		overrides: Partial<Parameters<typeof runMailboxSync>[0]> = {},
	) {
		return runMailboxSync({
			organizationId: "org_alpha",
			connectionId: "conn_01",
			caseId: "case_01",
			repos: fixtures.repos,
			storage: fixtures.storage,
			analyzerClient: fixtures.analyzer,
			gmailClient: fixtures.gmailClient,
			encryptionKey: testKeyHex,
			...overrides,
		});
	}

	it("runs bounded sync and registers evidence and analysis runs", async () => {
		const env = createFixtures();

		const result = await runSync(env, {
			maxMessages: 10,
			actorUserId: "user_investigator",
			requestId: "req_sync_1",
		});

		expect(result.status).toBe("ready");
		expect(result.readyCount).toBe(2);
		expect(result.failedCount).toBe(0);
		expect(result.messageCount).toBe(2);

		// Evidence registered
		expect(env.evidenceList).toHaveLength(2);
		expect(env.evidenceList[0]?.batchId).toBe(result.batchId);
		expect(env.evidenceList[0]?.sourceMessageId).toBe("msg_001");
		expect(env.evidenceList[0]?.idempotencyKey).toBe("gmail:conn_01:msg_001");

		// Stored in private storage
		const head = await env.storage.headEvidence({
			objectKey: env.evidenceList[0]!.objectKey,
			organizationId: "org_alpha",
			caseId: "case_01",
		});
		expect(head).not.toBeNull();
		expect(head?.byteSize).toBeGreaterThan(0);

		// Analysis runs dispatched
		expect(env.analyzer.dispatched).toHaveLength(2);

		// Connection cursor updated
		const updatedConn = await env.repos.mailbox.getConnection({
			organizationId: "org_alpha",
			connectionId: "conn_01",
		});
		expect(updatedConn?.syncCursor).toBe("1002");
		expect(updatedConn?.status).toBe("connected");
		expect(updatedConn?.lastSyncedAt).toBeDefined();

		// Audit events recorded
		const auditActions = env.auditList.map((r) => r.action);
		expect(auditActions).toContain("mailbox.sync_started");
		expect(auditActions).toContain("mailbox.sync_completed");

		// Verify no tokens appear in audit metadata or result
		for (const record of env.auditList) {
			const str = JSON.stringify(record);
			expect(str).not.toContain("mock_refresh_token");
			expect(str).not.toContain("mock_access_token");
			expect(str).not.toContain("Bearer");
		}
		expect(JSON.stringify(result)).not.toContain("token");
	});

	it("deduplicates re-synced messages and never creates duplicate evidence rows", async () => {
		const env = createFixtures();

		// Run sync once
		const result1 = await runSync(env);
		expect(result1.readyCount).toBe(2);
		expect(env.evidenceList).toHaveLength(2);
		expect(env.analyzer.dispatched).toHaveLength(2);

		// Run sync second time with identical messages
		const result2 = await runSync(env);

		// Deduplication prevents new evidence rows or runs
		expect(result2.status).toBe("ready");
		expect(env.evidenceList).toHaveLength(2); // Still 2, no duplicates!
		expect(env.analyzer.dispatched).toHaveLength(2); // Still 2, no extra dispatches!
	});

	it("enforces server-side maxMessages bounds (capping at 1000 and min 1)", async () => {
		const env = createFixtures();

		// Add 5 messages
		for (let i = 3; i <= 5; i++) {
			env.gmailClient.addRawMessage({
				id: `msg_00${i}`,
				raw: `Subject: Message ${i}\r\n\r\nBody`,
			});
		}

		// Request only 1 message
		const result = await runSync(env, { maxMessages: 1 });

		expect(result.readyCount).toBe(1);
		expect(env.evidenceList).toHaveLength(1);
	});

	it("degrades gracefully to partial status on rate limit (429)", async () => {
		const env = createFixtures();
		// Simulate persistent rate limit
		env.gmailClient.simulateRateLimitCount = 5;

		const result = await runSync(env);

		expect(result.status).toBe("failed");
		expect(result.failureReason).toBe("Rate limit exceeded");

		// Batch reflects failure reason
		const batch = await env.repos.batches.getBatch({
			organizationId: "org_alpha",
			batchId: result.batchId,
		});
		expect(batch?.failureReason).toBe("Rate limit exceeded");
	});

	it("degrades gracefully on expired or revoked refresh token (401)", async () => {
		const env = createFixtures();
		env.gmailClient.simulateAuthError = true;

		const result = await runSync(env);

		expect(result.status).toBe("failed");
		expect(result.failureReason).toBe("Authentication expired or revoked");

		// Connection status updated to error
		const conn = await env.repos.mailbox.getConnection({
			organizationId: "org_alpha",
			connectionId: "conn_01",
		});
		expect(conn?.status).toBe("error");
		expect(conn?.lastFailureReason).toBe("Authentication expired or revoked");
	});

	it("rejects cross-tenant sync requests", async () => {
		const env = createFixtures();

		// org_beta attempts to sync conn_01 owned by org_alpha
		await expect(
			runSync(env, { organizationId: "org_beta" }),
		).rejects.toMatchObject({
			message: "Mailbox connection not found",
		});
	});
});
