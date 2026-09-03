import { createHash } from "node:crypto";
import {
	type CaseShell,
	type EvidenceShell,
	type MembershipShell,
	MemoryAuditRepository,
	MemoryCaseRepository,
	MemoryEvidenceRepository,
	MemoryMembershipRepository,
} from "@mailsentinel/db";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { env } from "@/env";
import { logger } from "@/server/logger";
import { MemoryEvidenceStorage } from "@/server/storage/s3";
import type { RpcContext } from "./context";
import { evidenceOutputSchema } from "./evidence";
import { router } from "./router";

describe("Phase S4: Evidence Upload Orchestration", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	const sampleEmlContent =
		"From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Invoice\r\n\r\nPlease pay promptly.";
	const sampleBuffer = Buffer.from(sampleEmlContent, "utf-8");
	const sampleBase64 = sampleBuffer.toString("base64");
	const sampleByteSize = sampleBuffer.byteLength;
	const sampleSha256 = createHash("sha256")
		.update(sampleBuffer)
		.digest("hex")
		.toLowerCase();

	const caseOrgAlpha1: CaseShell = {
		id: "case_alpha_1",
		organizationId: "org_alpha",
		title: "Alpha Phishing Case",
		createdAt: new Date("2026-09-01T10:00:00Z"),
		updatedAt: new Date("2026-09-01T10:00:00Z"),
	};

	const caseOrgAlpha2: CaseShell = {
		id: "case_alpha_2",
		organizationId: "org_alpha",
		title: "Alpha Malware Case",
		createdAt: new Date("2026-09-01T11:00:00Z"),
		updatedAt: new Date("2026-09-01T11:00:00Z"),
	};

	const caseOrgBeta: CaseShell = {
		id: "case_beta_1",
		organizationId: "org_beta",
		title: "Beta Foreign Case",
		createdAt: new Date("2026-09-01T12:00:00Z"),
		updatedAt: new Date("2026-09-01T12:00:00Z"),
	};

	const memberships: MembershipShell[] = [
		{
			id: "mem_viewer",
			organizationId: "org_alpha",
			userId: "user_viewer",
			role: "viewer",
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		{
			id: "mem_investigator",
			organizationId: "org_alpha",
			userId: "user_investigator",
			role: "investigator",
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		{
			id: "mem_owner",
			organizationId: "org_alpha",
			userId: "user_owner",
			role: "owner",
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		{
			id: "mem_beta",
			organizationId: "org_beta",
			userId: "user_beta",
			role: "investigator",
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	];

	function setupTest(overrides: Partial<RpcContext> = {}) {
		const cases = [caseOrgAlpha1, caseOrgAlpha2, caseOrgBeta];
		const evidenceList: EvidenceShell[] = [];
		const caseRepo = new MemoryCaseRepository(cases);
		const evidenceRepo = new MemoryEvidenceRepository(evidenceList, cases);
		const auditRepo = new MemoryAuditRepository([]);
		const membershipRepo = new MemoryMembershipRepository(memberships);
		const storage = new MemoryEvidenceStorage();

		const context: RpcContext = {
			requestId: "req_s4_test",
			userId: "user_investigator",
			organizationId: "org_alpha",
			role: "investigator",
			repos: {
				cases: caseRepo,
				evidence: evidenceRepo,
				audit: auditRepo,
				memberships: membershipRepo,
			},
			storage,
			...overrides,
		};

		const client = createRouterClient(router, { context });

		return {
			context,
			client,
			caseRepo,
			evidenceRepo,
			auditRepo,
			storage,
		};
	}

	describe("1. Valid upload lifecycle", () => {
		it("completes full lifecycle: createUpload -> completeUpload -> list -> get", async () => {
			const { client, storage, auditRepo, evidenceRepo } = setupTest();

			// Step 1: Create pending upload
			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
				filename: "invoice_phishing.eml",
			});

			expect(pending.id).toBeDefined();
			expect(pending.id.startsWith("ev_")).toBe(true);
			expect(pending.organizationId).toBe("org_alpha");
			expect(pending.caseId).toBe("case_alpha_1");
			expect(pending.status).toBe("pending");
			expect(pending.sha256).toBe(sampleSha256);
			expect(pending.byteSize).toBe(sampleByteSize);
			expect(pending.contentType).toBe("message/rfc822");

			// Browser-facing evidence outputs must omit internal objectKey and idempotencyKey (Finding 1)
			expect(pending).not.toHaveProperty("objectKey");
			expect(pending).not.toHaveProperty("idempotencyKey");

			// Internal database record maintains the safe server-generated objectKey without client filename
			const dbRecord = await evidenceRepo.getEvidence({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: pending.id,
			});
			expect(dbRecord?.objectKey).toBeDefined();
			expect(dbRecord?.objectKey).not.toContain("invoice_phishing");
			expect(dbRecord?.objectKey).toMatch(
				/^organizations\/org_alpha\/cases\/case_alpha_1\/artifacts\/[A-Za-z0-9_-]+\.eml$/,
			);

			// Step 2: Complete upload with base64 payload
			const completed = await client.evidence.completeUpload({
				caseId: "case_alpha_1",
				evidenceId: pending.id,
				body: sampleBase64,
			});

			expect(completed.id).toBe(pending.id);
			expect(completed.status).toBe("verified");
			expect(completed.verifiedAt).toBeDefined();
			expect(completed.storedAt).toBeDefined();
			expect(completed.sha256).toBe(sampleSha256);
			expect(completed.byteSize).toBe(sampleByteSize);
			expect(completed).not.toHaveProperty("objectKey");
			expect(completed).not.toHaveProperty("idempotencyKey");

			// Object is written to storage using internal objectKey
			expect(dbRecord).toBeDefined();
			const internalObjectKey = dbRecord?.objectKey ?? "";
			expect(storage.hasObject(internalObjectKey)).toBe(true);
			const stored = storage.getObject(internalObjectKey);
			expect(stored?.sha256).toBe(sampleSha256);
			expect(stored?.contentType).toBe("message/rfc822");

			// Step 3: Viewer can list evidence
			const viewerTest = setupTest({
				userId: "user_viewer",
				role: "viewer",
			});
			// Share state
			viewerTest.context.repos = {
				cases: setupTest().caseRepo,
				evidence: setupTest().evidenceRepo,
			};

			const list = await client.evidence.list({
				caseId: "case_alpha_1",
			});
			expect(list).toHaveLength(1);
			expect(list[0]?.id).toBe(pending.id);
			expect(list[0]?.status).toBe("verified");
			expect(list[0]).not.toHaveProperty("objectKey");
			expect(list[0]).not.toHaveProperty("idempotencyKey");

			// Step 4: Viewer can get evidence
			const single = await client.evidence.get({
				caseId: "case_alpha_1",
				evidenceId: pending.id,
			});
			expect(single).not.toBeNull();
			expect(single?.id).toBe(pending.id);
			expect(single?.sha256).toBe(sampleSha256);
			expect(single).not.toHaveProperty("objectKey");
			expect(single).not.toHaveProperty("idempotencyKey");

			// Step 5: Safe audit events were recorded
			const audits = await auditRepo.listAuditRecords({
				organizationId: "org_alpha",
			});
			expect(audits).toHaveLength(2);

			const initAudit = audits.find((a) => a.action === "evidence.upload_init");
			expect(initAudit).toBeDefined();
			expect(initAudit?.resourceType).toBe("evidence");
			expect(initAudit?.resourceId).toBe(pending.id);
			// Filename removed from audit metadata to minimize PII (Finding 6)
			expect(initAudit?.metadata?.filename).toBeUndefined();
			expect(initAudit?.metadata?.sha256).toBe(sampleSha256);
			// Audit metadata must NOT contain object key or body
			expect(initAudit?.metadata?.objectKey).toBeUndefined();
			expect(initAudit?.metadata?.body).toBeUndefined();

			const completeAudit = audits.find(
				(a) => a.action === "evidence.upload_complete",
			);
			expect(completeAudit).toBeDefined();
			expect(completeAudit?.resourceType).toBe("evidence");
			expect(completeAudit?.resourceId).toBe(pending.id);
			expect(completeAudit?.metadata?.status).toBe("verified");
			expect(completeAudit?.metadata?.objectKey).toBeUndefined();
			expect(completeAudit?.metadata?.body).toBeUndefined();
		});
	});

	describe("2. Input validation & strict bounds", () => {
		it("rejects createUpload with byteSize 0 or negative", async () => {
			const { client } = setupTest();

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: 0,
					sha256: sampleSha256,
				}),
			).rejects.toThrow();

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: -5,
					sha256: sampleSha256,
				}),
			).rejects.toThrow();
		});

		it("rejects createUpload with byteSize exceeding MAX_EML_BYTES", async () => {
			const { client } = setupTest();

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: 30_000_000,
					sha256: sampleSha256,
				}),
			).rejects.toThrow();
		});

		it("rejects createUpload with invalid sha256 format", async () => {
			const { client } = setupTest();

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: 100,
					sha256: "not-a-valid-hex-digest",
				}),
			).rejects.toThrow();

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: 100,
					sha256: "a".repeat(63), // too short
				}),
			).rejects.toThrow();

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: 100,
					sha256: "a".repeat(65), // too long
				}),
			).rejects.toThrow();
		});

		it("rejects createUpload with non-message/rfc822 content type", async () => {
			const { client } = setupTest();

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: 100,
					sha256: sampleSha256,
					contentType: "application/pdf",
				}),
			).rejects.toThrow();
		});

		it("rejects createUpload when filename has non-.eml extension", async () => {
			const { client } = setupTest();

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: 100,
					sha256: sampleSha256,
					filename: "payload.exe",
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: 100,
					sha256: sampleSha256,
					filename: "evidence.pdf",
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		});

		it.each([
			"../escape.eml",
			"foo/bar.eml",
			"foo\\bar.eml",
			"a/../../b.eml",
			"payload\x00.eml",
		])("rejects createUpload with path traversal filename: %s", async (filename) => {
			const { client } = setupTest();

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: 100,
					sha256: sampleSha256,
					filename,
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		});

		it("rejects completeUpload with empty or whitespace payload", async () => {
			const { client } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: "",
				}),
			).rejects.toThrow();

			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: "    \r\n\t   ",
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		});

		it("rejects completeUpload with malformed base64 payload", async () => {
			const { client } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: "Invalid!Base64@Content==",
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		});

		it("rejects completeUpload with oversized raw base64 string prior to decoding", async () => {
			const { client } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			// Base64 encoding for 26MB is ~35MB chars; an oversized string > 38MB
			const oversizedBase64 = "A".repeat(40_000_000);

			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: oversizedBase64,
				}),
			).rejects.toMatchObject({
				code: "PAYLOAD_TOO_LARGE",
			});
		});
	});

	describe("3. Digest & size verification against registered metadata", () => {
		it("marks evidence as failed and rejects with CONFLICT when decoded payload does not match registered metadata", async () => {
			const { client, evidenceRepo } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			const differingContent = Buffer.from(
				"Subject: Completely different content",
				"utf-8",
			).toString("base64");

			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: differingContent,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
			});

			// Recheck DB status: must be transitioned to failed
			const recheck = await evidenceRepo.getEvidence({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: pending.id,
			});
			expect(recheck?.status).toBe("failed");
			expect(recheck?.failureReason).toContain("mismatch");
		});

		it("rejects completeUpload when client-provided sha256 conflicts with actual payload digest", async () => {
			const { client } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: sampleBase64,
					sha256: "f".repeat(64), // mismatched asserted sha
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
			});
		});
	});

	describe("4. Idempotency & immutability", () => {
		it("returns verified evidence idempotently on duplicate completeUpload with identical digest/size", async () => {
			const { client, storage } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			const first = await client.evidence.completeUpload({
				caseId: "case_alpha_1",
				evidenceId: pending.id,
				body: sampleBase64,
			});
			expect(first.status).toBe("verified");

			// Spy on storage.putEvidence to ensure it's not called on idempotent duplicate
			const putSpy = vi.spyOn(storage, "putEvidence");

			const second = await client.evidence.completeUpload({
				caseId: "case_alpha_1",
				evidenceId: pending.id,
				body: sampleBase64,
			});
			expect(second.id).toBe(first.id);
			expect(second.status).toBe("verified");
			expect(putSpy).not.toHaveBeenCalled();
		});

		it("rejects completeUpload on already-verified evidence with differing payload (immutable)", async () => {
			const { client } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			await client.evidence.completeUpload({
				caseId: "case_alpha_1",
				evidenceId: pending.id,
				body: sampleBase64,
			});

			// Now attempt to complete with different payload
			const different = Buffer.from("New data", "utf-8").toString("base64");
			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: different,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
			});
		});

		it("rejects completeUpload on failed evidence", async () => {
			const { client, evidenceRepo } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			await evidenceRepo.markFailed({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: pending.id,
				failureReason: "Corrupt upload",
			});

			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: sampleBase64,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
			});
		});

		it("supports idempotent createUpload when idempotencyKey matches existing pending record", async () => {
			const { client, evidenceRepo } = setupTest();

			const first = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
				idempotencyKey: "idem_upload_01",
			});

			const second = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
				idempotencyKey: "idem_upload_01",
			});

			expect(second.id).toBe(first.id);
			expect(first).not.toHaveProperty("objectKey");
			expect(first).not.toHaveProperty("idempotencyKey");
			expect(second).not.toHaveProperty("objectKey");
			expect(second).not.toHaveProperty("idempotencyKey");

			const dbRecord = await evidenceRepo.getEvidence({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: first.id,
			});
			expect(dbRecord?.idempotencyKey).toBe("idem_upload_01");
			expect(dbRecord?.objectKey).toBeDefined();
		});

		it("rejects createUpload when idempotencyKey is reused with differing metadata", async () => {
			const { client } = setupTest();

			await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
				idempotencyKey: "idem_conflict_01",
			});

			await expect(
				client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize + 10, // differing size
					sha256: sampleSha256,
					idempotencyKey: "idem_conflict_01",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
			});
		});
	});

	describe("5. Authorization & role permissions", () => {
		it("rejects anonymous access on all evidence procedures", async () => {
			const { caseRepo, evidenceRepo, storage } = setupTest();
			const anonContext: RpcContext = {
				requestId: "req_anon",
				userId: null,
				organizationId: null,
				repos: { cases: caseRepo, evidence: evidenceRepo },
				storage,
			};
			const anonClient = createRouterClient(router, { context: anonContext });

			await expect(
				anonClient.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize,
					sha256: sampleSha256,
				}),
			).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

			await expect(
				anonClient.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: "ev_123",
					body: sampleBase64,
				}),
			).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

			await expect(
				anonClient.evidence.list({ caseId: "case_alpha_1" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

			await expect(
				anonClient.evidence.get({
					caseId: "case_alpha_1",
					evidenceId: "ev_123",
				}),
			).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
		});

		it("rejects viewer mutation on createUpload and completeUpload with FORBIDDEN (403)", async () => {
			const { client: invClient } = setupTest();
			const pending = await invClient.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			const { client: viewerClient } = setupTest({
				userId: "user_viewer",
				role: "viewer",
			});

			await expect(
				viewerClient.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize,
					sha256: sampleSha256,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
			});

			await expect(
				viewerClient.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: sampleBase64,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
			});
		});

		it("allows viewer to list and get evidence", async () => {
			const { client: invClient, evidenceRepo, caseRepo } = setupTest();
			const pending = await invClient.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});
			await invClient.evidence.completeUpload({
				caseId: "case_alpha_1",
				evidenceId: pending.id,
				body: sampleBase64,
			});

			const viewerContext: RpcContext = {
				requestId: "req_viewer_read",
				userId: "user_viewer",
				organizationId: "org_alpha",
				role: "viewer",
				repos: { cases: caseRepo, evidence: evidenceRepo },
			};
			const viewerClient = createRouterClient(router, {
				context: viewerContext,
			});

			const list = await viewerClient.evidence.list({
				caseId: "case_alpha_1",
			});
			expect(list).toHaveLength(1);
			expect(list[0]?.id).toBe(pending.id);

			const single = await viewerClient.evidence.get({
				caseId: "case_alpha_1",
				evidenceId: pending.id,
			});
			expect(single?.id).toBe(pending.id);
		});

		it("allows owner to perform all evidence actions through role hierarchy", async () => {
			const { client } = setupTest({
				userId: "user_owner",
				role: "owner",
			});

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});
			expect(pending.id).toBeDefined();

			const completed = await client.evidence.completeUpload({
				caseId: "case_alpha_1",
				evidenceId: pending.id,
				body: sampleBase64,
			});
			expect(completed.status).toBe("verified");
		});
	});

	describe("6. Cross-tenant and cross-case prevention", () => {
		it("rejects createUpload for a case belonging to another tenant with NOT_FOUND", async () => {
			const { client } = setupTest({ organizationId: "org_alpha" });

			await expect(
				client.evidence.createUpload({
					caseId: "case_beta_1", // belongs to org_beta
					byteSize: sampleByteSize,
					sha256: sampleSha256,
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("rejects completeUpload for a case belonging to another tenant with NOT_FOUND", async () => {
			const { client } = setupTest({ organizationId: "org_alpha" });

			await expect(
				client.evidence.completeUpload({
					caseId: "case_beta_1", // belongs to org_beta
					evidenceId: "ev_123",
					body: sampleBase64,
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("rejects completeUpload when evidence belongs to another case in the same tenant", async () => {
			const { client } = setupTest();

			// Create evidence under case_alpha_1
			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			// Attempt to complete under case_alpha_2
			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_2",
					evidenceId: pending.id,
					body: sampleBase64,
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("returns null on evidence.get when queried case does not match evidence case", async () => {
			const { client } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			// Querying through case_alpha_2 returns null
			const result = await client.evidence.get({
				caseId: "case_alpha_2",
				evidenceId: pending.id,
			});
			expect(result).toBeNull();
		});

		it("rejects evidence.list for a case in another tenant with NOT_FOUND", async () => {
			const { client } = setupTest({ organizationId: "org_alpha" });

			await expect(
				client.evidence.list({ caseId: "case_beta_1" }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});
	});

	describe("7. Compensation on S3 write or DB lifecycle failure", () => {
		it("compensates on S3 write failure: marks DB record failed, attempts scoped delete compensation, and throws safe BAD_GATEWAY", async () => {
			const { client, storage, evidenceRepo } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			const dbRecord = await evidenceRepo.getEvidence({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: pending.id,
			});
			expect(dbRecord).toBeDefined();
			const objectKey = dbRecord?.objectKey ?? "";

			// Spy on deleteEvidence to ensure scoped delete compensation is attempted on put failure (Finding 2)
			const deleteSpy = vi.spyOn(storage, "deleteEvidence");

			// Simulate S3 put failure
			storage.simulatePutFailure = true;

			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: sampleBase64,
				}),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
			});

			// Scoped delete compensation MUST have been attempted
			expect(deleteSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					objectKey,
					organizationId: "org_alpha",
					caseId: "case_alpha_1",
				}),
			);

			// Verify DB was compensated: record marked failed
			const recheck = await evidenceRepo.getEvidence({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: pending.id,
			});
			expect(recheck?.status).toBe("failed");
			expect(recheck?.failureReason).toBe("Storage write failed");

			// Verify S3 storage does not contain the object
			expect(storage.hasObject(objectKey)).toBe(false);
		});

		it("compensates on DB lifecycle failure: deletes S3 object to prevent orphaned storage artifacts", async () => {
			const { client, storage, evidenceRepo } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
			});

			const dbRecord = await evidenceRepo.getEvidence({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: pending.id,
			});
			expect(dbRecord).toBeDefined();
			const objectKey = dbRecord?.objectKey ?? "";

			// Spy on storage.deleteEvidence
			const deleteSpy = vi.spyOn(storage, "deleteEvidence");

			// Make markVerified fail and simulate failure to establish verified state on subsequent rechecks
			vi.spyOn(evidenceRepo, "markVerified").mockRejectedValue(
				new Error("Database connection lost during markVerified"),
			);
			let getCount = 0;
			const origGet = evidenceRepo.getEvidence.bind(evidenceRepo);
			vi.spyOn(evidenceRepo, "getEvidence").mockImplementation(async (args) => {
				getCount++;
				if (getCount === 1) return origGet(args);
				return null;
			});

			await expect(
				client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: sampleBase64,
				}),
			).rejects.toThrow();

			// Storage compensation MUST have been executed
			expect(deleteSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					objectKey,
					organizationId: "org_alpha",
					caseId: "case_alpha_1",
				}),
			);
			// Object must not remain in storage
			expect(storage.hasObject(objectKey)).toBe(false);
		});
	});

	describe("8. Secret-free outputs", () => {
		it("asserts no credentials, tokens, secrets, or raw bodies appear in responses", async () => {
			const { client } = setupTest();

			const pending = await client.evidence.createUpload({
				caseId: "case_alpha_1",
				byteSize: sampleByteSize,
				sha256: sampleSha256,
				filename: "report.eml",
			});

			const completed = await client.evidence.completeUpload({
				caseId: "case_alpha_1",
				evidenceId: pending.id,
				body: sampleBase64,
			});

			const list = await client.evidence.list({ caseId: "case_alpha_1" });
			const single = await client.evidence.get({
				caseId: "case_alpha_1",
				evidenceId: pending.id,
			});

			const allResponses = [pending, completed, list, single];

			for (const res of allResponses) {
				const str = JSON.stringify(res);
				// Check known secret keys and patterns
				expect(str).not.toContain("S3_ACCESS_KEY");
				expect(str).not.toContain("S3_SECRET_ACCESS_KEY");
				expect(str).not.toContain(env.S3_ACCESS_KEY_ID);
				expect(str).not.toContain(env.S3_SECRET_ACCESS_KEY);
				expect(str).not.toContain(env.BETTER_AUTH_SECRET);
				expect(str).not.toContain(env.ANALYZER_SERVICE_TOKEN);
				// Raw email body not in response
				expect(str).not.toContain("Please pay promptly");
				// No AWS presigned URL
				expect(str).not.toContain("X-Amz-Signature");
				expect(str).not.toContain("X-Amz-Credential");
				// Browser-facing outputs omit internal objectKey and idempotencyKey
				expect(str).not.toContain("artifacts/");
			}
		});
	});

	describe("9. Phase S4 Review Findings Verification", () => {
		describe("Finding 1: Browser-facing outputs omit objectKey and idempotencyKey", () => {
			it("ensures output validation schema explicitly strips internal objectKey and idempotencyKey", () => {
				const rawRecord: EvidenceShell = {
					id: "ev_test_strip",
					organizationId: "org_alpha",
					caseId: "case_alpha_1",
					objectKey:
						"organizations/org_alpha/cases/case_alpha_1/artifacts/internal.eml",
					sha256: sampleSha256,
					byteSize: sampleByteSize,
					contentType: "message/rfc822",
					status: "verified",
					idempotencyKey: "secret_idem_key",
					storedAt: new Date(),
					verifiedAt: new Date(),
					failedAt: null,
					failureReason: null,
					createdAt: new Date(),
					updatedAt: new Date(),
				};

				const parsed = evidenceOutputSchema.parse(rawRecord);
				expect(parsed).not.toHaveProperty("objectKey");
				expect(parsed).not.toHaveProperty("idempotencyKey");
				expect((parsed as Record<string, unknown>).objectKey).toBeUndefined();
				expect(
					(parsed as Record<string, unknown>).idempotencyKey,
				).toBeUndefined();
				expect(parsed.id).toBe("ev_test_strip");
				expect(parsed.status).toBe("verified");
			});

			it("ensures all procedure responses omit objectKey and idempotencyKey", async () => {
				const { client } = setupTest();

				const pending = await client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize,
					sha256: sampleSha256,
					idempotencyKey: "idem_strip_test",
				});
				expect(pending).not.toHaveProperty("objectKey");
				expect(pending).not.toHaveProperty("idempotencyKey");

				const completed = await client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: sampleBase64,
				});
				expect(completed).not.toHaveProperty("objectKey");
				expect(completed).not.toHaveProperty("idempotencyKey");

				const list = await client.evidence.list({ caseId: "case_alpha_1" });
				expect(list[0]).not.toHaveProperty("objectKey");
				expect(list[0]).not.toHaveProperty("idempotencyKey");

				const single = await client.evidence.get({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
				});
				expect(single).not.toHaveProperty("objectKey");
				expect(single).not.toHaveProperty("idempotencyKey");
			});
		});

		describe("Finding 2 & 4: Storage cleanup compensation and safe logging", () => {
			it("safely handles storage cleanup failure during put failure without leaking error/stack/objectKey", async () => {
				const { client, storage } = setupTest();

				const pending = await client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize,
					sha256: sampleSha256,
				});

				// Simulate storage put failure AND storage delete failure
				storage.simulatePutFailure = true;
				storage.simulateDeleteFailure = true;

				const errorLoggerSpy = vi.spyOn(logger, "error");

				await expect(
					client.evidence.completeUpload({
						caseId: "case_alpha_1",
						evidenceId: pending.id,
						body: sampleBase64,
					}),
				).rejects.toMatchObject({
					code: "BAD_GATEWAY",
				});

				// Verify logger was called with stable safe fields
				const cleanupLogCalls = errorLoggerSpy.mock.calls.filter(
					([event]) => event === "Storage cleanup compensation failed",
				);
				expect(cleanupLogCalls.length).toBeGreaterThanOrEqual(1);
				const lastCall = cleanupLogCalls.at(-1);
				expect(lastCall).toBeDefined();
				const [, context] = lastCall ?? [];
				expect(context?.requestId).toBe("req_s4_test");
				expect(context?.organizationId).toBe("org_alpha");
				expect(context?.caseId).toBe("case_alpha_1");
				expect(context?.evidenceId).toBe(pending.id);
				expect(context?.trigger).toBe("put_failure");

				// Assert NO raw error message, stack, objectKey, or raw evidence in context
				expect(context).not.toHaveProperty("error");
				expect(context).not.toHaveProperty("stack");
				expect(context).not.toHaveProperty("objectKey");
				expect(context).not.toHaveProperty("body");
				expect(JSON.stringify(context)).not.toContain("Simulated storage");
				expect(JSON.stringify(context)).not.toContain("artifacts/");
			});

			it("safely logs cleanup failure during DB lifecycle error with stable safe fields only", async () => {
				const { client, storage, evidenceRepo } = setupTest();

				const pending = await client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize,
					sha256: sampleSha256,
				});

				// Make markVerified fail and getEvidence return null on rechecks
				vi.spyOn(evidenceRepo, "markVerified").mockRejectedValue(
					new Error("Database write timeout secret_token_xyz"),
				);
				let getCount = 0;
				const origGet = evidenceRepo.getEvidence.bind(evidenceRepo);
				vi.spyOn(evidenceRepo, "getEvidence").mockImplementation(
					async (args) => {
						getCount++;
						if (getCount === 1) return origGet(args);
						return null;
					},
				);

				// Simulate delete failure
				storage.simulateDeleteFailure = true;

				const errorLoggerSpy = vi.spyOn(logger, "error");

				await expect(
					client.evidence.completeUpload({
						caseId: "case_alpha_1",
						evidenceId: pending.id,
						body: sampleBase64,
					}),
				).rejects.toThrow();

				const cleanupLogCalls = errorLoggerSpy.mock.calls.filter(
					([event]) => event === "Storage cleanup compensation failed",
				);
				expect(cleanupLogCalls.length).toBeGreaterThanOrEqual(1);
				const lastCall = cleanupLogCalls.at(-1);
				expect(lastCall).toBeDefined();
				const [, context] = lastCall ?? [];
				expect(context?.requestId).toBe("req_s4_test");
				expect(context?.organizationId).toBe("org_alpha");
				expect(context?.caseId).toBe("case_alpha_1");
				expect(context?.evidenceId).toBe(pending.id);
				expect(context?.trigger).toBe("lifecycle_failure");

				// Must not contain raw error message, stack, or objectKey
				expect(context).not.toHaveProperty("error");
				expect(context).not.toHaveProperty("stack");
				expect(context).not.toHaveProperty("objectKey");
				expect(JSON.stringify(context)).not.toContain("secret_token_xyz");
				expect(JSON.stringify(context)).not.toContain("artifacts/");
			});
		});

		describe("Finding 3: Robustness to concurrent duplicate completion", () => {
			it("handles concurrent duplicate completeUpload calls without deleting the valid stored object", async () => {
				const { client, storage, evidenceRepo } = setupTest();

				const pending = await client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize,
					sha256: sampleSha256,
				});

				const dbRecord = await evidenceRepo.getEvidence({
					organizationId: "org_alpha",
					caseId: "case_alpha_1",
					evidenceId: pending.id,
				});
				expect(dbRecord).toBeDefined();
				const objectKey = dbRecord?.objectKey ?? "";

				const deleteSpy = vi.spyOn(storage, "deleteEvidence");

				// Execute two concurrent completeUpload requests simultaneously
				const [res1, res2] = await Promise.all([
					client.evidence.completeUpload({
						caseId: "case_alpha_1",
						evidenceId: pending.id,
						body: sampleBase64,
					}),
					client.evidence.completeUpload({
						caseId: "case_alpha_1",
						evidenceId: pending.id,
						body: sampleBase64,
					}),
				]);

				// Both must report verified success
				expect(res1.id).toBe(pending.id);
				expect(res1.status).toBe("verified");
				expect(res2.id).toBe(pending.id);
				expect(res2.status).toBe("verified");

				// Both must omit objectKey and idempotencyKey
				expect(res1).not.toHaveProperty("objectKey");
				expect(res1).not.toHaveProperty("idempotencyKey");
				expect(res2).not.toHaveProperty("objectKey");
				expect(res2).not.toHaveProperty("idempotencyKey");

				// Proves a valid object remains in storage and was NOT deleted by compensation
				expect(deleteSpy).not.toHaveBeenCalled();
				expect(storage.hasObject(objectKey)).toBe(true);
				const stored = storage.getObject(objectKey);
				expect(stored?.sha256).toBe(sampleSha256);
			});

			it("recovers safely if duplicate completion re-reads evidence in stored state and finishes verification", async () => {
				const { client, storage, evidenceRepo } = setupTest();

				const pending = await client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize,
					sha256: sampleSha256,
				});

				const dbRecord = await evidenceRepo.getEvidence({
					organizationId: "org_alpha",
					caseId: "case_alpha_1",
					evidenceId: pending.id,
				});
				expect(dbRecord).toBeDefined();
				const objectKey = dbRecord?.objectKey ?? "";

				// Simulate lost race where markStored fails because another request already marked stored
				let markStoredAttempts = 0;
				const origMarkStored = evidenceRepo.markStored.bind(evidenceRepo);
				vi.spyOn(evidenceRepo, "markStored").mockImplementation(
					async (args) => {
						markStoredAttempts++;
						if (markStoredAttempts === 1) {
							// Perform markStored on the repo, then throw to simulate race condition
							await origMarkStored(args);
							throw new Error("Concurrent transaction conflict on markStored");
						}
						return origMarkStored(args);
					},
				);

				const deleteSpy = vi.spyOn(storage, "deleteEvidence");

				const completed = await client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: sampleBase64,
				});

				expect(completed.status).toBe("verified");
				// Did NOT delete the stored object
				expect(deleteSpy).not.toHaveBeenCalled();
				expect(storage.hasObject(objectKey)).toBe(true);
			});

			it("deletes storage object only when DB cannot establish matching verified state", async () => {
				const { client, storage, evidenceRepo } = setupTest();

				const pending = await client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize,
					sha256: sampleSha256,
				});

				const dbRecord = await evidenceRepo.getEvidence({
					organizationId: "org_alpha",
					caseId: "case_alpha_1",
					evidenceId: pending.id,
				});
				if (!dbRecord) {
					throw new Error("Expected dbRecord to be defined");
				}
				const objectKey = dbRecord.objectKey;

				const deleteSpy = vi.spyOn(storage, "deleteEvidence");

				// Force markVerified to fail and recheck to return a mismatching / corrupted state
				vi.spyOn(evidenceRepo, "markVerified").mockRejectedValue(
					new Error("Database deadlock"),
				);
				let getCount = 0;
				const origGet = evidenceRepo.getEvidence.bind(evidenceRepo);
				vi.spyOn(evidenceRepo, "getEvidence").mockImplementation(
					async (args) => {
						getCount++;
						if (getCount === 1) return origGet(args);
						return {
							...dbRecord,
							status: "failed" as const,
							failureReason: "Corrupted by external process",
							failedAt: new Date(),
						};
					},
				);

				await expect(
					client.evidence.completeUpload({
						caseId: "case_alpha_1",
						evidenceId: pending.id,
						body: sampleBase64,
					}),
				).rejects.toThrow();

				// Compensation delete was executed because DB could not establish matching verified state
				expect(deleteSpy).toHaveBeenCalledWith(
					expect.objectContaining({
						objectKey,
					}),
				);
				expect(storage.hasObject(objectKey)).toBe(false);
			});
		});

		describe("Finding 5: Idempotent retry appends safe completion audit", () => {
			it("appends safe completion audit on idempotent retry if the first completion verified storage/DB but audit append failed", async () => {
				const { client, storage, auditRepo, evidenceRepo } = setupTest();

				const pending = await client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize,
					sha256: sampleSha256,
				});

				const dbRecord = await evidenceRepo.getEvidence({
					organizationId: "org_alpha",
					caseId: "case_alpha_1",
					evidenceId: pending.id,
				});
				expect(dbRecord).toBeDefined();
				const objectKey = dbRecord?.objectKey ?? "";

				// Make audit recording fail on completeUpload
				let auditFailOnce = true;
				const origAppend = auditRepo.appendAuditRecord.bind(auditRepo);
				vi.spyOn(auditRepo, "appendAuditRecord").mockImplementation(
					async (event) => {
						if (event.action === "evidence.upload_complete" && auditFailOnce) {
							auditFailOnce = false;
							throw new Error("Audit service temporarily unavailable");
						}
						return origAppend(event);
					},
				);

				// First attempt fails during audit recording
				await expect(
					client.evidence.completeUpload({
						caseId: "case_alpha_1",
						evidenceId: pending.id,
						body: sampleBase64,
					}),
				).rejects.toMatchObject({
					code: "INTERNAL_SERVER_ERROR",
				});

				// Check state: DB is already verified, storage already has object
				const midway = await evidenceRepo.getEvidence({
					organizationId: "org_alpha",
					caseId: "case_alpha_1",
					evidenceId: pending.id,
				});
				expect(midway?.status).toBe("verified");
				expect(storage.hasObject(objectKey)).toBe(true);

				// But audit record for upload_complete does NOT exist yet
				const midwayAudits = await auditRepo.listAuditRecords({
					organizationId: "org_alpha",
				});
				expect(
					midwayAudits.find((a) => a.action === "evidence.upload_complete"),
				).toBeUndefined();

				// Spy on storage.putEvidence: must not be called again on retry
				const putSpy = vi.spyOn(storage, "putEvidence");

				// Idempotent retry: client retries completeUpload
				const retryResult = await client.evidence.completeUpload({
					caseId: "case_alpha_1",
					evidenceId: pending.id,
					body: sampleBase64,
				});

				expect(retryResult.id).toBe(pending.id);
				expect(retryResult.status).toBe("verified");
				expect(retryResult).not.toHaveProperty("objectKey");
				expect(retryResult).not.toHaveProperty("idempotencyKey");

				// Storage put was skipped
				expect(putSpy).not.toHaveBeenCalled();

				// Audit record was successfully appended by the idempotent retry!
				const finalAudits = await auditRepo.listAuditRecords({
					organizationId: "org_alpha",
				});
				const completeAudit = finalAudits.find(
					(a) => a.action === "evidence.upload_complete",
				);
				expect(completeAudit).toBeDefined();
				expect(completeAudit?.resourceId).toBe(pending.id);
				expect(completeAudit?.metadata?.sha256).toBe(sampleSha256);
				expect(completeAudit?.metadata?.status).toBe("verified");
				expect(completeAudit?.metadata?.objectKey).toBeUndefined();
			});
		});

		describe("Finding 6: Remove client filename from audit metadata while maintaining validation", () => {
			it("validates client filename but never includes it in audit metadata", async () => {
				const { client, auditRepo } = setupTest();

				// 1. Path traversal and illegal filenames are still rejected
				await expect(
					client.evidence.createUpload({
						caseId: "case_alpha_1",
						byteSize: sampleByteSize,
						sha256: sampleSha256,
						filename: "../../../etc/passwd.eml",
					}),
				).rejects.toMatchObject({ code: "BAD_REQUEST" });

				await expect(
					client.evidence.createUpload({
						caseId: "case_alpha_1",
						byteSize: sampleByteSize,
						sha256: sampleSha256,
						filename: "trojan.exe",
					}),
				).rejects.toMatchObject({ code: "BAD_REQUEST" });

				// 2. Valid filename succeeds
				const created = await client.evidence.createUpload({
					caseId: "case_alpha_1",
					byteSize: sampleByteSize,
					sha256: sampleSha256,
					filename: "confidential_employee_report.eml",
				});
				expect(created.id).toBeDefined();

				// 3. Filename is omitted from audit metadata to minimize PII
				const audits = await auditRepo.listAuditRecords({
					organizationId: "org_alpha",
				});
				const initAudit = audits.find(
					(a) =>
						a.resourceId === created.id && a.action === "evidence.upload_init",
				);
				expect(initAudit).toBeDefined();
				expect(initAudit?.metadata?.filename).toBeUndefined();
				expect(JSON.stringify(initAudit?.metadata)).not.toContain(
					"confidential",
				);
				expect(JSON.stringify(initAudit?.metadata)).not.toContain(".eml");
			});
		});
	});
});
