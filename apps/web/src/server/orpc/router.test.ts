import {
	type CaseShell,
	MemoryAuditRepository,
	MemoryCaseRepository,
} from "@mailsentinel/db";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { RpcContext } from "./context";
import { router } from "./router";

const anonymous: RpcContext = {
	requestId: "request_test",
	userId: null,
	organizationId: null,
};

describe("application router", () => {
	const testCase: CaseShell = {
		id: "case_01",
		organizationId: "org_01",
		title: "Initial investigation",
		createdAt: new Date("2026-09-01T00:00:00Z"),
		updatedAt: new Date("2026-09-01T00:00:00Z"),
	};

	it("returns typed health", async () => {
		const client = createRouterClient(router, { context: anonymous });
		await expect(client.system.health()).resolves.toMatchObject({
			ok: true,
			service: "web",
		});
	});

	it("protects tenant procedures from anonymous access", async () => {
		const client = createRouterClient(router, { context: anonymous });
		await expect(client.case.list()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	it("allows viewer to list and get cases", async () => {
		const caseRepo = new MemoryCaseRepository([testCase]);
		const viewerContext: RpcContext = {
			requestId: "req_viewer_1",
			userId: "user_viewer",
			organizationId: "org_01",
			role: "viewer",
			repos: { cases: caseRepo },
		};
		const client = createRouterClient(router, { context: viewerContext });

		const list = await client.case.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.id).toBe("case_01");

		const single = await client.case.get({ caseId: "case_01" });
		expect(single?.id).toBe("case_01");
	});

	it("rejects viewer from creating cases", async () => {
		const caseRepo = new MemoryCaseRepository([]);
		const viewerContext: RpcContext = {
			requestId: "req_viewer_create",
			userId: "user_viewer",
			organizationId: "org_01",
			role: "viewer",
			repos: { cases: caseRepo },
		};
		const client = createRouterClient(router, { context: viewerContext });

		await expect(
			client.case.create({ title: "Viewer Case Attempt" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("allows investigator to create cases and records audit trail", async () => {
		const caseRepo = new MemoryCaseRepository([]);
		const auditRepo = new MemoryAuditRepository([]);
		const investigatorContext: RpcContext = {
			requestId: "req_inv_create",
			userId: "user_investigator",
			organizationId: "org_01",
			role: "investigator",
			repos: { cases: caseRepo, audit: auditRepo },
		};
		const client = createRouterClient(router, {
			context: investigatorContext,
		});

		const created = await client.case.create({
			title: "Investigator Forensic Case",
		});
		expect(created.id).toBeDefined();
		expect(created.title).toBe("Investigator Forensic Case");
		expect(created.organizationId).toBe("org_01");

		const audits = await auditRepo.listAuditRecords({
			organizationId: "org_01",
		});
		expect(audits).toHaveLength(1);
		expect(audits[0]?.action).toBe("case.create");
		expect(audits[0]?.resourceType).toBe("case");
		expect(audits[0]?.resourceId).toBe(created.id);
	});

	it("enforces role gating on report.generate for investigator or owner", async () => {
		const viewerContext: RpcContext = {
			requestId: "req_viewer_report",
			userId: "user_viewer",
			organizationId: "org_01",
			role: "viewer",
		};
		const viewerClient = createRouterClient(router, {
			context: viewerContext,
		});
		await expect(
			viewerClient.report.generate({ caseId: "case_01" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		const investigatorContext: RpcContext = {
			requestId: "req_inv_report",
			userId: "user_investigator",
			organizationId: "org_01",
			role: "investigator",
		};
		const invClient = createRouterClient(router, {
			context: investigatorContext,
		});
		const invResult = await invClient.report.generate({ caseId: "case_01" });
		expect(invResult.status).toBe("deferred");

		const ownerContext: RpcContext = {
			requestId: "req_owner_report",
			userId: "user_owner",
			organizationId: "org_01",
			role: "owner",
		};
		const ownerClient = createRouterClient(router, { context: ownerContext });
		const result = await ownerClient.report.generate({ caseId: "case_01" });
		expect(result.status).toBe("deferred");
	});

	it("integrates evidence router procedures in appRouter", async () => {
		const { MemoryEvidenceRepository } = await import("@mailsentinel/db");
		const { MemoryEvidenceStorage } = await import("@/server/storage/s3");

		const caseRepo = new MemoryCaseRepository([testCase]);
		const evidenceRepo = new MemoryEvidenceRepository([], [testCase]);
		const auditRepo = new MemoryAuditRepository([]);
		const storage = new MemoryEvidenceStorage();

		const invContext: RpcContext = {
			requestId: "req_inv_ev",
			userId: "user_investigator",
			organizationId: "org_01",
			role: "investigator",
			repos: {
				cases: caseRepo,
				evidence: evidenceRepo,
				audit: auditRepo,
			},
			storage,
		};
		const invClient = createRouterClient(router, { context: invContext });

		const body = Buffer.from("Subject: Test\r\n\r\nBody");
		const sha256 = (await import("node:crypto"))
			.createHash("sha256")
			.update(body)
			.digest("hex");

		const pending = await invClient.evidence.createUpload({
			caseId: "case_01",
			byteSize: body.byteLength,
			sha256,
		});
		expect(pending.status).toBe("pending");
		expect(pending).not.toHaveProperty("objectKey");
		expect(pending).not.toHaveProperty("idempotencyKey");

		const completed = await invClient.evidence.completeUpload({
			caseId: "case_01",
			evidenceId: pending.id,
			body: body.toString("base64"),
		});
		expect(completed.status).toBe("verified");
		expect(completed).not.toHaveProperty("objectKey");
		expect(completed).not.toHaveProperty("idempotencyKey");

		const viewerContext: RpcContext = {
			requestId: "req_viewer_ev",
			userId: "user_viewer",
			organizationId: "org_01",
			role: "viewer",
			repos: {
				cases: caseRepo,
				evidence: evidenceRepo,
			},
		};
		const viewerClient = createRouterClient(router, {
			context: viewerContext,
		});

		const list = await viewerClient.evidence.list({ caseId: "case_01" });
		expect(list).toHaveLength(1);
		expect(list[0]?.id).toBe(pending.id);
		expect(list[0]).not.toHaveProperty("objectKey");
		expect(list[0]).not.toHaveProperty("idempotencyKey");

		const single = await viewerClient.evidence.get({
			caseId: "case_01",
			evidenceId: pending.id,
		});
		expect(single?.id).toBe(pending.id);
		expect(single).not.toHaveProperty("objectKey");
		expect(single).not.toHaveProperty("idempotencyKey");
	});
});
