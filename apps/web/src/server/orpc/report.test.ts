import { MemoryReportRepository, type ReportShell } from "@mailsentinel/db";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { RpcContext } from "./context";
import { router } from "./router";

describe("Phase S6: Report Router (generate, get, list)", () => {
	const reportOrg1A: ReportShell = {
		id: "rep_01",
		organizationId: "org_01",
		caseId: "case_01",
		analysisRunId: "run_01",
		version: 1,
		status: "completed",
		format: "html",
		objectKey: "organizations/org_01/cases/case_01/reports/rep_01.html",
		metadata: { template: "standard_forensic", generatedBy: "system" },
		failureReason: null,
		generatedAt: new Date("2026-09-01T10:15:00Z"),
		createdAt: new Date("2026-09-01T10:10:00Z"),
		updatedAt: new Date("2026-09-01T10:15:00Z"),
	};

	const reportOrg1B: ReportShell = {
		id: "rep_02",
		organizationId: "org_01",
		caseId: "case_01",
		analysisRunId: "run_02",
		version: 1,
		status: "pending",
		format: "json",
		objectKey: null,
		metadata: {},
		failureReason: null,
		generatedAt: null,
		createdAt: new Date("2026-09-01T11:00:00Z"),
		updatedAt: new Date("2026-09-01T11:00:00Z"),
	};

	const reportOrg2: ReportShell = {
		id: "rep_03",
		organizationId: "org_02",
		caseId: "case_foreign",
		analysisRunId: "run_foreign",
		version: 1,
		status: "completed",
		format: "html",
		objectKey: "organizations/org_02/cases/case_foreign/reports/rep_03.html",
		metadata: {},
		failureReason: null,
		generatedAt: new Date("2026-09-01T12:00:00Z"),
		createdAt: new Date("2026-09-01T12:00:00Z"),
		updatedAt: new Date("2026-09-01T12:00:00Z"),
	};

	function createTestContext(overrides: Partial<RpcContext> = {}): {
		context: RpcContext;
		reportRepo: MemoryReportRepository;
	} {
		const reportRepo = new MemoryReportRepository([
			{ ...reportOrg1A },
			{ ...reportOrg1B },
			{ ...reportOrg2 },
		]);
		const context: RpcContext = {
			requestId: "req_report_test",
			userId: "user_viewer",
			organizationId: "org_01",
			role: "viewer",
			repos: {
				reports: reportRepo,
			},
			...overrides,
		};
		return { context, reportRepo };
	}

	describe("report.generate (deferred mutation)", () => {
		const anonymousContext: RpcContext = {
			requestId: "req_anon",
			userId: null,
			organizationId: null,
		};

		it("rejects anonymous call with UNAUTHORIZED", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.report.generate({ caseId: "case_01" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("rejects viewer with FORBIDDEN", async () => {
			const { context } = createTestContext({ role: "viewer" });
			const client = createRouterClient(router, { context });
			await expect(
				client.report.generate({ caseId: "case_01" }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("allows investigator to call generate returning explicit deferred status", async () => {
			const { context } = createTestContext({
				userId: "user_investigator",
				role: "investigator",
			});
			const client = createRouterClient(router, { context });
			const result = await client.report.generate({ caseId: "case_01" });
			expect(result.status).toBe("deferred");
			expect(result.reason).toBeDefined();
		});

		it("allows owner to call generate returning explicit deferred status", async () => {
			const { context } = createTestContext({
				userId: "user_owner",
				role: "owner",
			});
			const client = createRouterClient(router, { context });
			const result = await client.report.generate({ caseId: "case_01" });
			expect(result.status).toBe("deferred");
		});
	});

	describe("report.get", () => {
		const anonymousContext: RpcContext = {
			requestId: "req_anon",
			userId: null,
			organizationId: null,
		};

		it("rejects anonymous call with UNAUTHORIZED", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.report.get({ reportId: "rep_01" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("allows viewer to read tenant report metadata without leaking objectKey", async () => {
			const { context } = createTestContext({ role: "viewer" });
			const client = createRouterClient(router, { context });
			const result = await client.report.get({ reportId: "rep_01" });
			expect(result.id).toBe("rep_01");
			expect(result.organizationId).toBe("org_01");
			expect(result.caseId).toBe("case_01");
			expect(result.format).toBe("html");
			expect(result.status).toBe("completed");
			expect(result.metadata).toEqual({
				template: "standard_forensic",
				generatedBy: "system",
			});
			// Verify objectKey is NOT exposed in the output
			expect((result as Record<string, unknown>).objectKey).toBeUndefined();
		});

		it("rejects cross-tenant report retrieval with safe NOT_FOUND", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });
			await expect(
				client.report.get({ reportId: "rep_03" }), // belongs to org_02
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("rejects non-existent report ID with safe NOT_FOUND", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });
			await expect(
				client.report.get({ reportId: "non_existent_report" }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("rejects report lookup when scoped caseId does not match with NOT_FOUND", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });
			await expect(
				client.report.get({ reportId: "rep_01", caseId: "wrong_case" }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});
	});

	describe("report.list", () => {
		const anonymousContext: RpcContext = {
			requestId: "req_anon",
			userId: null,
			organizationId: null,
		};

		it("rejects anonymous call with UNAUTHORIZED", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(client.report.list({})).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("allows viewer to list tenant reports and isolates cross-tenant records", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });
			const result = await client.report.list({});
			expect(result.items).toHaveLength(2);
			expect(result.items.every((r) => r.organizationId === "org_01")).toBe(
				true,
			);
			expect(result.items.some((r) => r.id === "rep_03")).toBe(false);
		});

		it("filters reports by caseId and status (backed by indexed columns)", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });

			const completedOnly = await client.report.list({
				caseId: "case_01",
				status: "completed",
			});
			expect(completedOnly.items).toHaveLength(1);
			expect(completedOnly.items[0]?.id).toBe("rep_01");

			const pendingOnly = await client.report.list({
				caseId: "case_01",
				status: "pending",
			});
			expect(pendingOnly.items).toHaveLength(1);
			expect(pendingOnly.items[0]?.id).toBe("rep_02");
		});

		it("filters reports by format", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });

			const htmlOnly = await client.report.list({ format: "html" });
			expect(htmlOnly.items).toHaveLength(1);
			expect(htmlOnly.items[0]?.format).toBe("html");
		});

		it("supports cursor pagination and stable ordering", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });

			// Page 1: limit 1 should return rep_02 (createdAt: 11:00) with a nextCursor
			const page1 = await client.report.list({ limit: 1 });
			expect(page1.items).toHaveLength(1);
			expect(page1.items[0]?.id).toBe("rep_02");
			expect(page1.nextCursor).toBeDefined();
			expect(page1.nextCursor).not.toBeNull();

			// Page 2: with cursor should return rep_01 (createdAt: 10:10) with nextCursor null
			const nextCursor = page1.nextCursor;
			expect(nextCursor).not.toBeNull();
			if (!nextCursor) throw new Error("Expected report next cursor");
			const page2 = await client.report.list({
				limit: 1,
				cursor: nextCursor,
			});
			expect(page2.items).toHaveLength(1);
			expect(page2.items[0]?.id).toBe("rep_01");
			expect(page2.nextCursor).toBeNull();
		});
	});
});
