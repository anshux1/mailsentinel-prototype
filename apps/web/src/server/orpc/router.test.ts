import {
	type CaseShell,
	type EvidenceShell,
	MemoryAnalysisRunRepository,
	MemoryAuditRepository,
	MemoryCaseRepository,
	MemoryRepositories,
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
		expect(list.items).toHaveLength(1);
		expect(list.items[0]?.id).toBe("case_01");

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
			viewerClient.report.generate({ analysisRunId: "missing_run" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		const emptyAnalysisRepo = new MemoryAnalysisRunRepository(
			[],
			[testCase],
			[],
		);
		const investigatorContext: RpcContext = {
			requestId: "req_inv_report",
			userId: "user_investigator",
			organizationId: "org_01",
			role: "investigator",
			repos: { analysisRuns: emptyAnalysisRepo },
		};
		const invClient = createRouterClient(router, {
			context: investigatorContext,
		});
		await expect(
			invClient.report.generate({ analysisRunId: "missing_run" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const ownerContext: RpcContext = {
			requestId: "req_owner_report",
			userId: "user_owner",
			organizationId: "org_01",
			role: "owner",
			repos: { analysisRuns: emptyAnalysisRepo },
		};
		const ownerClient = createRouterClient(router, { context: ownerContext });
		await expect(
			ownerClient.report.generate({ analysisRunId: "missing_run" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
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
		expect(list.items).toHaveLength(1);
		expect(list.items[0]?.id).toBe(pending.id);
		expect(list.items[0]).not.toHaveProperty("objectKey");
		expect(list.items[0]).not.toHaveProperty("idempotencyKey");

		const single = await viewerClient.evidence.get({
			caseId: "case_01",
			evidenceId: pending.id,
		});
		expect(single?.id).toBe(pending.id);
		expect(single).not.toHaveProperty("objectKey");
		expect(single).not.toHaveProperty("idempotencyKey");
	});

	it("integrates analysis router procedures in appRouter", async () => {
		const { MemoryAnalyzerClient } = await import("@/server/analyzer-client");

		const testEvidence: EvidenceShell = {
			id: "ev_01",
			organizationId: "org_01",
			caseId: "case_01",
			objectKey: "organizations/org_01/cases/case_01/artifacts/art_01.eml",
			sha256:
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			byteSize: 1024,
			contentType: "message/rfc822",
			status: "verified",
			idempotencyKey: null,
			storedAt: new Date(),
			verifiedAt: new Date(),
			failedAt: null,
			failureReason: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const memoryRepos = new MemoryRepositories({
			cases: [testCase],
			evidence: [testEvidence],
		});
		const analyzerClient = new MemoryAnalyzerClient();

		const invContext: RpcContext = {
			requestId: "req_inv_analysis",
			userId: "user_investigator",
			organizationId: "org_01",
			role: "investigator",
			repos: {
				cases: memoryRepos.cases,
				evidence: memoryRepos.evidence,
				analysisRuns: memoryRepos.analysisRuns,
				audit: memoryRepos.audit,
			},
			analyzerClient,
			executeTx: (fn) => memoryRepos.transaction(fn),
		};

		const invClient = createRouterClient(router, { context: invContext });

		const started = await invClient.analysis.start({
			caseId: "case_01",
			evidenceId: "ev_01",
		});

		expect(started.id).toBeDefined();
		expect(started.status).toBe("queued");
		expect(started).not.toHaveProperty("objectKey");
		expect(started).not.toHaveProperty("idempotencyKey");
		expect(analyzerClient.dispatched).toHaveLength(1);

		// Fail the run to test retry
		await memoryRepos.analysisRuns.transitionStatus({
			organizationId: "org_01",
			analysisRunId: started.id,
			fromStatus: "queued",
			toStatus: "failed",
			retryable: true,
			failureCode: "analyzer_unavailable",
		});

		const ownerContext: RpcContext = {
			requestId: "req_owner_retry",
			userId: "user_owner",
			organizationId: "org_01",
			role: "owner",
			repos: {
				cases: memoryRepos.cases,
				evidence: memoryRepos.evidence,
				analysisRuns: memoryRepos.analysisRuns,
				audit: memoryRepos.audit,
			},
			analyzerClient,
			executeTx: (fn) => memoryRepos.transaction(fn),
		};

		const ownerClient = createRouterClient(router, { context: ownerContext });
		const retried = await ownerClient.analysis.retry({
			analysisRunId: started.id,
		});

		expect(retried.id).toBe(started.id);
		expect(retried.status).toBe("queued");
		expect(retried.attempts).toBe(1);
		expect(analyzerClient.dispatched).toHaveLength(2);
	});
});
