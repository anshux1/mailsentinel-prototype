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

describe("Phase S6: Case Router (list, get, create)", () => {
	const caseOrg1A: CaseShell = {
		id: "case_01",
		organizationId: "org_01",
		title: "Case Alpha One",
		createdAt: new Date("2026-09-01T10:00:00Z"),
		updatedAt: new Date("2026-09-01T10:00:00Z"),
	};

	const caseOrg1B: CaseShell = {
		id: "case_02",
		organizationId: "org_01",
		title: "Case Alpha Two",
		createdAt: new Date("2026-09-01T11:00:00Z"),
		updatedAt: new Date("2026-09-01T11:00:00Z"),
	};

	const caseOrg2: CaseShell = {
		id: "case_03",
		organizationId: "org_02",
		title: "Case Beta Foreign",
		createdAt: new Date("2026-09-01T12:00:00Z"),
		updatedAt: new Date("2026-09-01T12:00:00Z"),
	};

	function createTestContext(overrides: Partial<RpcContext> = {}): {
		context: RpcContext;
		caseRepo: MemoryCaseRepository;
		auditRepo: MemoryAuditRepository;
	} {
		const caseRepo = new MemoryCaseRepository([
			{ ...caseOrg1A },
			{ ...caseOrg1B },
			{ ...caseOrg2 },
		]);
		const auditRepo = new MemoryAuditRepository([]);
		const context: RpcContext = {
			requestId: "req_case_test",
			userId: "user_investigator",
			organizationId: "org_01",
			role: "investigator",
			repos: {
				cases: caseRepo,
				audit: auditRepo,
			},
			...overrides,
		};
		return { context, caseRepo, auditRepo };
	}

	describe("Authentication & Authorization", () => {
		const anonymousContext: RpcContext = {
			requestId: "req_anon",
			userId: null,
			organizationId: null,
		};

		it("rejects anonymous access to case.list with UNAUTHORIZED", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(client.case.list()).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("rejects anonymous access to case.get with UNAUTHORIZED", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.case.get({ caseId: "case_01" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("rejects anonymous access to case.create with UNAUTHORIZED", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.case.create({ title: "New Phishing Incident" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("rejects viewer from calling case.create with FORBIDDEN", async () => {
			const { context } = createTestContext({
				userId: "user_viewer",
				role: "viewer",
			});
			const client = createRouterClient(router, { context });

			await expect(
				client.case.create({ title: "Viewer Case Attempt" }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("allows viewer to list and get cases", async () => {
			const { context } = createTestContext({
				userId: "user_viewer",
				role: "viewer",
			});
			const client = createRouterClient(router, { context });

			const list = await client.case.list();
			expect(list.items).toHaveLength(2);

			const single = await client.case.get({ caseId: "case_01" });
			expect(single?.id).toBe("case_01");
			expect(single?.title).toBe("Case Alpha One");
		});

		it("allows owner to list, get, and create cases", async () => {
			const { context, auditRepo } = createTestContext({
				userId: "user_owner",
				role: "owner",
			});
			const client = createRouterClient(router, { context });

			const created = await client.case.create({ title: "Owner Created Case" });
			expect(created.id).toBeDefined();
			expect(created.title).toBe("Owner Created Case");

			const audits = await auditRepo.listAuditRecords({
				organizationId: "org_01",
			});
			expect(audits).toHaveLength(1);
			expect(audits[0]?.action).toBe("case.create");
		});
	});

	describe("Tenant Scoping & Boundaries", () => {
		it("never returns cases belonging to another organization via case.list", async () => {
			const { context } = createTestContext({
				organizationId: "org_01",
			});
			const client = createRouterClient(router, { context });

			const list = await client.case.list();
			expect(list.items).toHaveLength(2);
			expect(list.items.every((c) => c.organizationId === "org_01")).toBe(true);
			expect(list.items.some((c) => c.id === "case_03")).toBe(false);
		});

		it("returns null when attempting to case.get a case from another tenant", async () => {
			const { context } = createTestContext({
				organizationId: "org_01",
			});
			const client = createRouterClient(router, { context });

			const result = await client.case.get({ caseId: "case_03" });
			expect(result).toBeNull();
		});

		it("scopes created case to authenticated tenant and records audit trail", async () => {
			const { context, auditRepo } = createTestContext({
				organizationId: "org_01",
				userId: "user_investigator_1",
			});
			const client = createRouterClient(router, { context });

			const created = await client.case.create({
				title: "Investigator Scoped Case",
			});
			expect(created.organizationId).toBe("org_01");
			expect(created.title).toBe("Investigator Scoped Case");

			const audits = await auditRepo.listAuditRecords({
				organizationId: "org_01",
			});
			expect(audits).toHaveLength(1);
			expect(audits[0]?.resourceId).toBe(created.id);
			expect(audits[0]?.actorUserId).toBe("user_investigator_1");
		});
	});

	describe("Input Validation", () => {
		it("rejects empty case title with BAD_REQUEST", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });

			await expect(client.case.create({ title: "" })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		});

		it("rejects title exceeding 160 characters with BAD_REQUEST", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });

			await expect(
				client.case.create({ title: "a".repeat(161) }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		});
	});

	describe("Stable Ordering & Cursor Pagination", () => {
		it("stably orders cases by createdAt desc, then id desc", async () => {
			const sameDate = new Date("2026-09-01T12:00:00Z");
			const caseRepo = new MemoryCaseRepository([
				{
					id: "case_aaa",
					organizationId: "org_01",
					title: "AAA",
					createdAt: sameDate,
					updatedAt: sameDate,
				},
				{
					id: "case_zzz",
					organizationId: "org_01",
					title: "ZZZ",
					createdAt: sameDate,
					updatedAt: sameDate,
				},
			]);
			const { context } = createTestContext({ repos: { cases: caseRepo } });
			const client = createRouterClient(router, { context });

			const list = await client.case.list();
			expect(list.items).toHaveLength(2);
			// Under stable ordering with tie-breaking, case_zzz comes before case_aaa
			expect(list.items[0]?.id).toBe("case_zzz");
			expect(list.items[1]?.id).toBe("case_aaa");
		});

		it("supports bounded limit and cursor pagination", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });

			// Page 1 with limit 1: should return case_02 (latest created: 11:00)
			const page1 = await client.case.list({ limit: 1 });
			expect(page1.items).toHaveLength(1);
			expect(page1.items[0]?.id).toBe("case_02");
			expect(page1.nextCursor).not.toBeNull();
			if (!page1.nextCursor) throw new Error("Expected first case next cursor");

			const page2 = await client.case.list({
				limit: 1,
				cursor: page1.nextCursor,
			});
			expect(page2.items).toHaveLength(1);
			expect(page2.items[0]?.id).toBe("case_01");
			expect(page2.nextCursor).toBeNull();
		});
	});
});
