import {
	type CaseShell,
	RepositoryError as DbRepositoryError,
	type MembershipShell,
	MemoryAuditRepository,
	MemoryCaseRepository,
	MemoryMembershipRepository,
	ConflictError as RepoConflictError,
	DependencyError as RepoDependencyError,
	NotFoundError as RepoNotFoundError,
} from "@mailsentinel/db";
import { createRouterClient, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hasPermission, hasRole } from "@/server/auth/permissions";
import { formatLogEntry, logger } from "@/server/logger";
import {
	ACTIVE_ORG_HEADER,
	type AuthClientLike,
	createRpcContext,
	type RpcContext,
	validateOrganizationHeader,
} from "./context";
import {
	ConflictError,
	DependencyError,
	ForbiddenError,
	NotFoundError,
	PayloadTooLargeError,
	toSafeORPCError,
	UnauthorizedError,
} from "./errors";
import { router } from "./router";

describe("Phase S3: Authorization Model & Infrastructure", () => {
	const initialCases: CaseShell[] = [
		{
			id: "case_tenant_1",
			organizationId: "org_alpha",
			title: "Phishing attack report Alpha",
			createdAt: new Date("2026-09-01T10:00:00Z"),
			updatedAt: new Date("2026-09-01T10:00:00Z"),
		},
		{
			id: "case_tenant_2",
			organizationId: "org_beta",
			title: "Confidential Executive Fraud Beta",
			createdAt: new Date("2026-09-01T11:00:00Z"),
			updatedAt: new Date("2026-09-01T11:00:00Z"),
		},
	];

	const initialMemberships: MembershipShell[] = [
		{
			id: "mem_1",
			organizationId: "org_alpha",
			userId: "user_viewer",
			role: "viewer",
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		{
			id: "mem_2",
			organizationId: "org_alpha",
			userId: "user_investigator",
			role: "investigator",
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		{
			id: "mem_3",
			organizationId: "org_alpha",
			userId: "user_owner",
			role: "owner",
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		{
			id: "mem_4",
			organizationId: "org_beta",
			userId: "user_beta_only",
			role: "investigator",
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	];

	function createTestContext(
		overrides: Partial<RpcContext> = {},
		cases: CaseShell[] = [...initialCases],
	): {
		context: RpcContext;
		caseRepo: MemoryCaseRepository;
		auditRepo: MemoryAuditRepository;
		membershipRepo: MemoryMembershipRepository;
	} {
		const caseRepo = new MemoryCaseRepository(cases);
		const auditRepo = new MemoryAuditRepository([]);
		const membershipRepo = new MemoryMembershipRepository([
			...initialMemberships,
		]);

		const context: RpcContext = {
			requestId: "req_test_123",
			userId: "user_investigator",
			organizationId: "org_alpha",
			role: "investigator",
			repos: {
				cases: caseRepo,
				audit: auditRepo,
				memberships: membershipRepo,
			},
			...overrides,
		};

		return { context, caseRepo, auditRepo, membershipRepo };
	}

	describe("1. Anonymous request rejection", () => {
		const anonymousContext: RpcContext = {
			requestId: "req_anon_1",
			userId: null,
			organizationId: null,
		};

		it("rejects case.list anonymously with UNAUTHORIZED (401)", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(client.case.list()).rejects.toMatchObject({
				code: "UNAUTHORIZED",
				status: 401,
				data: expect.objectContaining({
					requestId: "req_anon_1",
				}),
			});
		});

		it("rejects case.get anonymously with UNAUTHORIZED (401)", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.case.get({ caseId: "case_tenant_1" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
				status: 401,
			});
		});

		it("rejects case.create anonymously with UNAUTHORIZED (401)", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.case.create({ title: "Unauthorized title" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
				status: 401,
			});
		});

		it("rejects analysis.getStatus anonymously with UNAUTHORIZED (401)", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.analysis.getStatus({ analysisRunId: "run_1" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
				status: 401,
			});
		});

		it("rejects report.generate anonymously with UNAUTHORIZED (401)", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.report.generate({ caseId: "case_1" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
				status: 401,
			});
		});

		it("allows public system.health anonymously", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			const res = await client.system.health();
			expect(res).toMatchObject({
				ok: true,
				service: "web",
			});
		});
	});

	describe("2. Explicit active organization and membership validation", () => {
		it("validates organization header format strictly", () => {
			expect(validateOrganizationHeader(null)).toEqual({
				valid: false,
				reason: "missing",
			});
			expect(validateOrganizationHeader("")).toEqual({
				valid: false,
				reason: "missing",
			});
			expect(validateOrganizationHeader("   ")).toEqual({
				valid: false,
				reason: "missing",
			});
			expect(validateOrganizationHeader("org with spaces")).toEqual({
				valid: false,
				reason: "invalid",
			});
			expect(validateOrganizationHeader("org/with/slashes")).toEqual({
				valid: false,
				reason: "invalid",
			});
			expect(validateOrganizationHeader("org..parent")).toEqual({
				valid: false,
				reason: "invalid",
			});
			expect(validateOrganizationHeader("a".repeat(129))).toEqual({
				valid: false,
				reason: "invalid",
			});
			expect(validateOrganizationHeader("org_valid-123")).toEqual({
				valid: true,
				orgId: "org_valid-123",
			});
		});

		it("rejects authenticated requests when active organization is missing (no first-membership fallback)", async () => {
			const { context } = createTestContext({
				userId: "user_investigator",
				organizationId: null,
				role: null,
				membershipError: "missing_active_org",
			});
			const client = createRouterClient(router, { context });

			await expect(client.case.list()).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
				data: expect.objectContaining({
					code: "MISSING_ACTIVE_ORGANIZATION",
					requestId: "req_test_123",
				}),
			});
		});

		it("rejects authenticated requests when user is not a member of the active organization (even with null organizationId)", async () => {
			const { context } = createTestContext({
				userId: "user_investigator",
				organizationId: null,
				role: null,
				membershipError: "not_member",
			});
			const client = createRouterClient(router, { context });

			await expect(client.case.list()).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
				data: expect.objectContaining({
					code: "FORBIDDEN",
					requestId: "req_test_123",
				}),
			});
		});

		it("rejects authenticated requests when organization ID header format is invalid (even with null organizationId)", async () => {
			const { context } = createTestContext({
				userId: "user_investigator",
				organizationId: null,
				role: null,
				membershipError: "invalid_org_format",
			});
			const client = createRouterClient(router, { context });

			await expect(client.case.list()).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
				data: expect.objectContaining({
					code: "INVALID_ORGANIZATION_HEADER",
					requestId: "req_test_123",
				}),
			});
		});

		it("maps generic missing organizationId without membershipError strictly to MISSING_ACTIVE_ORGANIZATION", async () => {
			const { context } = createTestContext({
				userId: "user_investigator",
				organizationId: null,
				role: null,
				membershipError: undefined,
			});
			const client = createRouterClient(router, { context });

			await expect(client.case.list()).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
				data: expect.objectContaining({
					code: "MISSING_ACTIVE_ORGANIZATION",
					requestId: "req_test_123",
				}),
			});
		});

		it("creates context with no first-membership fallback when header is missing", async () => {
			const mockAuth: AuthClientLike = {
				api: {
					getSession: vi.fn().mockResolvedValue({
						user: { id: "user_investigator", email: "inv@example.com" },
						session: { id: "sess_1" },
					}),
				},
			};

			const requestWithoutHeader = new Request(
				"http://localhost:3000/api/rpc",
				{
					headers: { "x-request-id": "req_ctx_1" },
				},
			);

			const ctx = await createRpcContext(requestWithoutHeader, {
				authClient: mockAuth,
				repos: {
					memberships: new MemoryMembershipRepository([...initialMemberships]),
				},
			});

			expect(ctx.userId).toBe("user_investigator");
			expect(ctx.organizationId).toBeNull();
			expect(ctx.role).toBeNull();
			expect(ctx.membershipError).toBe("missing_active_org");
		});

		it("creates context and validates membership when header is supplied", async () => {
			const mockAuth: AuthClientLike = {
				api: {
					getSession: vi.fn().mockResolvedValue({
						user: { id: "user_investigator", email: "inv@example.com" },
						session: { id: "sess_1" },
					}),
				},
			};

			const requestWithValidHeader = new Request(
				"http://localhost:3000/api/rpc",
				{
					headers: {
						"x-request-id": "req_ctx_2",
						[ACTIVE_ORG_HEADER]: "org_alpha",
					},
				},
			);

			const ctx = await createRpcContext(requestWithValidHeader, {
				authClient: mockAuth,
				repos: {
					memberships: new MemoryMembershipRepository([...initialMemberships]),
				},
			});

			expect(ctx.userId).toBe("user_investigator");
			expect(ctx.organizationId).toBe("org_alpha");
			expect(ctx.role).toBe("investigator");
			expect(ctx.membershipError).toBeNull();
		});

		it("denies organization access when user has no membership in requested organization", async () => {
			const mockAuth: AuthClientLike = {
				api: {
					getSession: vi.fn().mockResolvedValue({
						user: { id: "user_investigator", email: "inv@example.com" },
						session: { id: "sess_1" },
					}),
				},
			};

			const requestWithForeignOrg = new Request(
				"http://localhost:3000/api/rpc",
				{
					headers: {
						"x-request-id": "req_ctx_3",
						[ACTIVE_ORG_HEADER]: "org_beta", // user_investigator is only member in org_alpha
					},
				},
			);

			const ctx = await createRpcContext(requestWithForeignOrg, {
				authClient: mockAuth,
				repos: {
					memberships: new MemoryMembershipRepository([...initialMemberships]),
				},
			});

			expect(ctx.userId).toBe("user_investigator");
			expect(ctx.organizationId).toBeNull();
			expect(ctx.role).toBeNull();
			expect(ctx.membershipError).toBe("not_member");
		});
	});

	describe("3. Viewer mutation rejection", () => {
		it("rejects viewer mutation on case.create with FORBIDDEN (403)", async () => {
			const { context } = createTestContext({
				userId: "user_viewer",
				organizationId: "org_alpha",
				role: "viewer",
			});
			const client = createRouterClient(router, { context });

			await expect(
				client.case.create({ title: "Malicious submission by viewer" }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
				data: expect.objectContaining({
					code: "FORBIDDEN",
					role: "viewer",
					requiredRole: "investigator",
				}),
			});
		});

		it("allows viewer to read cases via case.list and case.get", async () => {
			const { context } = createTestContext({
				userId: "user_viewer",
				organizationId: "org_alpha",
				role: "viewer",
			});
			const client = createRouterClient(router, { context });

			const list = await client.case.list();
			expect(list).toHaveLength(1);
			expect(list[0]?.id).toBe("case_tenant_1");

			const single = await client.case.get({ caseId: "case_tenant_1" });
			expect(single?.id).toBe("case_tenant_1");
		});

		it("rejects viewer calling investigator-level report.generate with FORBIDDEN (403)", async () => {
			const { context } = createTestContext({
				userId: "user_viewer",
				organizationId: "org_alpha",
				role: "viewer",
			});
			const client = createRouterClient(router, { context });

			await expect(
				client.report.generate({ caseId: "case_tenant_1" }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
				data: expect.objectContaining({
					requiredRole: "investigator",
				}),
			});
		});
	});

	describe("4. Investigator allow and audit event recording", () => {
		it("allows investigator to create a case and appends safe audit event", async () => {
			const { context, auditRepo } = createTestContext({
				userId: "user_investigator",
				organizationId: "org_alpha",
				role: "investigator",
			});
			const client = createRouterClient(router, { context });

			const created = await client.case.create({
				title: "Suspicious wire request investigation",
			});

			expect(created).toBeDefined();
			expect(created.title).toBe("Suspicious wire request investigation");
			expect(created.organizationId).toBe("org_alpha");

			// Verify audit event was safely recorded without raw evidence
			const audits = await auditRepo.listAuditRecords({
				organizationId: "org_alpha",
			});
			expect(audits).toHaveLength(1);
			expect(audits[0]?.action).toBe("case.create");
			expect(audits[0]?.resourceType).toBe("case");
			expect(audits[0]?.resourceId).toBe(created.id);
			expect(audits[0]?.actorUserId).toBe("user_investigator");
			expect(audits[0]?.metadata).toMatchObject({
				title: "Suspicious wire request investigation",
				requestId: "req_test_123",
			});
		});

		it("allows owner to perform investigator mutations through role hierarchy", async () => {
			const { context } = createTestContext({
				userId: "user_owner",
				organizationId: "org_alpha",
				role: "owner",
			});
			const client = createRouterClient(router, { context });

			const created = await client.case.create({
				title: "Owner-created forensic case",
			});
			expect(created.id).toBeDefined();
			expect(created.title).toBe("Owner-created forensic case");
		});

		it("allows owner to execute report.generate through role hierarchy", async () => {
			const { context } = createTestContext({
				userId: "user_owner",
				organizationId: "org_alpha",
				role: "owner",
			});
			const client = createRouterClient(router, { context });

			const result = await client.report.generate({ caseId: "case_tenant_1" });
			expect(result).toMatchObject({
				status: "deferred",
			});
		});

		it("allows investigator to execute report.generate per role permissions", async () => {
			const { context } = createTestContext({
				userId: "user_investigator",
				organizationId: "org_alpha",
				role: "investigator",
			});
			const client = createRouterClient(router, { context });

			const result = await client.report.generate({ caseId: "case_tenant_1" });
			expect(result).toMatchObject({
				status: "deferred",
			});
		});
	});

	describe("5. Cross-tenant probing safe behavior", () => {
		it("does not leak existence of case belonging to another tenant via case.get", async () => {
			// User in org_alpha probing case_tenant_2 which belongs to org_beta
			const { context } = createTestContext({
				userId: "user_investigator",
				organizationId: "org_alpha",
				role: "investigator",
			});
			const client = createRouterClient(router, { context });

			const result = await client.case.get({ caseId: "case_tenant_2" });
			expect(result).toBeNull();
		});

		it("never returns cases belonging to another organization via case.list", async () => {
			const { context } = createTestContext({
				userId: "user_investigator",
				organizationId: "org_alpha",
				role: "investigator",
			});
			const client = createRouterClient(router, { context });

			const cases = await client.case.list();
			expect(cases.every((c) => c.organizationId === "org_alpha")).toBe(true);
			expect(cases.some((c) => c.organizationId === "org_beta")).toBe(false);
		});
	});

	describe("6. Stable safe oRPC error mapping", () => {
		const reqId = "req_err_mapping_1";

		it("maps UnauthorizedError to UNAUTHORIZED (401) with requestId", () => {
			const mapped = toSafeORPCError(
				new UnauthorizedError("Token expired"),
				reqId,
			);
			expect(mapped.code).toBe("UNAUTHORIZED");
			expect(mapped.status).toBe(401);
			expect(mapped.data).toMatchObject({
				code: "UNAUTHORIZED",
				requestId: reqId,
			});
		});

		it("maps ForbiddenError to FORBIDDEN (403) with requestId", () => {
			const mapped = toSafeORPCError(
				new ForbiddenError("Role insufficient"),
				reqId,
			);
			expect(mapped.code).toBe("FORBIDDEN");
			expect(mapped.status).toBe(403);
			expect(mapped.data).toMatchObject({
				code: "FORBIDDEN",
				requestId: reqId,
			});
		});

		it("maps NotFoundError (repo/app) to NOT_FOUND (404) with requestId", () => {
			const mappedRepo = toSafeORPCError(
				new RepoNotFoundError("Case", "case_999", "org_alpha"),
				reqId,
			);
			expect(mappedRepo.code).toBe("NOT_FOUND");
			expect(mappedRepo.status).toBe(404);
			expect(mappedRepo.data).toMatchObject({
				code: "NOT_FOUND",
				requestId: reqId,
			});

			const mappedApp = toSafeORPCError(
				new NotFoundError("Custom not found"),
				reqId,
			);
			expect(mappedApp.code).toBe("NOT_FOUND");
			expect(mappedApp.status).toBe(404);
			expect(mappedApp.data).toMatchObject({
				code: "NOT_FOUND",
				requestId: reqId,
			});
		});

		it("maps ConflictError (repo/app) to CONFLICT (409) with requestId", () => {
			const mappedRepo = toSafeORPCError(
				new RepoConflictError("Duplicate key exists"),
				reqId,
			);
			expect(mappedRepo.code).toBe("CONFLICT");
			expect(mappedRepo.status).toBe(409);
			expect(mappedRepo.data).toMatchObject({
				code: "CONFLICT",
				requestId: reqId,
			});

			const mappedApp = toSafeORPCError(
				new ConflictError("Case already open"),
				reqId,
			);
			expect(mappedApp.code).toBe("CONFLICT");
			expect(mappedApp.status).toBe(409);
			expect(mappedApp.data).toMatchObject({
				code: "CONFLICT",
				requestId: reqId,
			});
		});

		it("maps PayloadTooLargeError to PAYLOAD_TOO_LARGE (413) with requestId", () => {
			const mapped = toSafeORPCError(
				new PayloadTooLargeError("File size exceeds 25MB limit"),
				reqId,
			);
			expect(mapped.code).toBe("PAYLOAD_TOO_LARGE");
			expect(mapped.status).toBe(413);
			expect(mapped.data).toMatchObject({
				code: "PAYLOAD_TOO_LARGE",
				requestId: reqId,
			});
		});

		it("maps DependencyError (repo/app) to BAD_GATEWAY (502) with DEPENDENCY_ERROR code and requestId", () => {
			const mappedRepo = toSafeORPCError(
				new RepoDependencyError("PostgreSQL FK missing"),
				reqId,
			);
			expect(mappedRepo.code).toBe("BAD_GATEWAY");
			expect(mappedRepo.status).toBe(502);
			expect(mappedRepo.data).toMatchObject({
				code: "DEPENDENCY_ERROR",
				requestId: reqId,
			});

			const mappedApp = toSafeORPCError(
				new DependencyError("Upstream service timeout", "analyzer"),
				reqId,
			);
			expect(mappedApp.code).toBe("BAD_GATEWAY");
			expect(mappedApp.status).toBe(502);
			expect(mappedApp.data).toMatchObject({
				code: "DEPENDENCY_ERROR",
				requestId: reqId,
			});
		});

		it("maps unexpected driver/internal errors to safe INTERNAL_SERVER_ERROR without leaking raw details", () => {
			const rawSqlError = new Error(
				"FATAL: password authentication failed for user 'postgres' at connection tcp://10.0.0.1:5432/db",
			);
			const mapped = toSafeORPCError(rawSqlError, reqId);

			expect(mapped.code).toBe("INTERNAL_SERVER_ERROR");
			expect(mapped.status).toBe(500);
			expect(mapped.message).toBe("An unexpected error occurred");
			expect(mapped.message).not.toContain("password");
			expect(mapped.message).not.toContain("tcp://");
			expect(mapped.data).toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				requestId: reqId,
			});
		});

		it("preserves requestId in already constructed ORPCError", () => {
			const directORPC = new ORPCError("BAD_REQUEST", {
				message: "Invalid parameters",
				data: { field: "title" },
			});
			const mapped = toSafeORPCError(directORPC, reqId);

			expect(mapped.code).toBe("BAD_REQUEST");
			expect(mapped.status).toBe(400);
			expect(mapped.data).toMatchObject({
				field: "title",
				requestId: reqId,
				code: "BAD_REQUEST",
			});
		});
	});

	describe("7. Safe audit metadata sanitization", () => {
		it("redacts raw email bodies, attachment bytes, tokens, and credentials from audit metadata", async () => {
			const { sanitizeAuditMetadata } = await import("@/server/audit");
			const sanitized = sanitizeAuditMetadata(
				{
					caseTitle: "Phishing investigation",
					emailBody: "Subject: Confidential. Raw text...",
					raw_eml: "<base64 encoded content>",
					attachmentData: "0xdeadbeef",
					secretToken: "sk_live_123456",
					safeId: "artifact_123",
				},
				"req_audit_test",
			);

			expect(sanitized.requestId).toBe("req_audit_test");
			expect(sanitized.caseTitle).toBe("Phishing investigation");
			expect(sanitized.safeId).toBe("artifact_123");
			expect(sanitized.emailBody).toBe("[REDACTED]");
			expect(sanitized.raw_eml).toBe("[REDACTED]");
			expect(sanitized.attachmentData).toBe("[REDACTED]");
			expect(sanitized.secretToken).toBe("[REDACTED]");
		});
	});

	describe("8. Structured server logging", () => {
		it("formats structured JSON log entry with requestId and redacts sensitive keys", () => {
			const formatted = formatLogEntry("info", "test.event", {
				requestId: "req_log_1",
				organizationId: "org_alpha",
				userId: "user_investigator",
				token: "bearer_secret_token",
				passwordHash: "hash123",
				rawPayload: "hostile email content",
				safeMetric: 42,
			});

			const parsed = JSON.parse(formatted);
			expect(parsed.requestId).toBe("req_log_1");
			expect(parsed.organizationId).toBe("org_alpha");
			expect(parsed.userId).toBe("user_investigator");
			expect(parsed.token).toBe("[REDACTED]");
			expect(parsed.passwordHash).toBe("[REDACTED]");
			expect(parsed.rawPayload).toBe("[REDACTED]");
			expect(parsed.safeMetric).toBe(42);
			expect(parsed.timestamp).toBeDefined();
			expect(parsed.event).toBe("test.event");
		});

		it("never logs arbitrary exception messages or stacks when handling unexpected errors, asserting secrets absent", () => {
			const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {
				/* suppress error logging in test */
			});
			const secretToken = "SECRET_BEARING_API_KEY_xyz123";
			const evidencePayload =
				"Confidential evidence email body containing private records";
			const secretError = new Error(
				`Critical backend failure with token=${secretToken} and evidence=${evidencePayload}`,
			);
			secretError.stack = `Error: Critical failure\n    at internalQuery (${secretToken}:42)\n    at eval (${evidencePayload}:10)`;

			const mapped = toSafeORPCError(secretError, "req_secret_err_test");

			expect(mapped.code).toBe("INTERNAL_SERVER_ERROR");
			expect(mapped.status).toBe(500);
			expect(mapped.message).toBe("An unexpected error occurred");
			expect(mapped.message).not.toContain(secretToken);
			expect(mapped.message).not.toContain(evidencePayload);

			expect(errorSpy).toHaveBeenCalled();
			const [event, loggedContext] = errorSpy.mock.calls[0] as [
				string,
				Record<string, unknown>,
			];
			expect(event).toBe("Unhandled exception during oRPC procedure execution");

			// Must log only safe error class/name and stable code/context
			expect(loggedContext).toMatchObject({
				requestId: "req_secret_err_test",
				code: "INTERNAL_SERVER_ERROR",
				errorClass: "Error",
				errorName: "Error",
			});

			// Assert secret token and evidence are strictly absent from logged context
			const stringifiedLog = JSON.stringify(loggedContext);
			expect(stringifiedLog).not.toContain(secretToken);
			expect(stringifiedLog).not.toContain(evidencePayload);
			expect(loggedContext).not.toHaveProperty("error");
			expect(loggedContext).not.toHaveProperty("stack");
			expect(loggedContext).not.toHaveProperty("message");

			errorSpy.mockRestore();
		});

		it("never logs arbitrary messages or stacks when intercepting repository errors, asserting secrets absent", () => {
			const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {
				/* suppress error logging in test */
			});
			const dbPassword = "super_secret_db_password_456";
			const repoError = new DbRepositoryError(
				`Failed query execution on connection postgres://user:${dbPassword}@db:5432/mailsentinel`,
				"DATABASE_QUERY_FAILED",
			);
			repoError.stack = `RepositoryError: Failed query\n    at connection (${dbPassword}:1)`;

			const mapped = toSafeORPCError(repoError, "req_secret_repo_test");

			expect(mapped.code).toBe("INTERNAL_SERVER_ERROR");
			expect(mapped.status).toBe(500);
			expect(mapped.message).toBe("An internal database error occurred");

			expect(errorSpy).toHaveBeenCalled();
			const [event, loggedContext] = errorSpy.mock.calls[0] as [
				string,
				Record<string, unknown>,
			];
			expect(event).toBe("Repository error intercepted");

			// Must log only safe error class/name and stable code/context
			expect(loggedContext).toMatchObject({
				requestId: "req_secret_repo_test",
				code: "DATABASE_QUERY_FAILED",
				errorClass: "RepositoryError",
				errorName: "RepositoryError",
			});

			const stringifiedLog = JSON.stringify(loggedContext);
			expect(stringifiedLog).not.toContain(dbPassword);
			expect(stringifiedLog).not.toContain("postgres://user:");
			expect(loggedContext).not.toHaveProperty("error");
			expect(loggedContext).not.toHaveProperty("stack");
			expect(loggedContext).not.toHaveProperty("message");

			errorSpy.mockRestore();
		});

		it("ensures procedure execution never leaks secrets into error logs when a procedure throws", async () => {
			const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {
				/* suppress error logging in test */
			});
			const secretVal = "TOP_SECRET_INVESTIGATION_KEY_987";
			const failingCaseRepo = {
				createCase: vi
					.fn()
					.mockRejectedValue(
						new Error(`Database write exploded with secret=${secretVal}`),
					),
				getCase: vi.fn(),
				listCases: vi.fn(),
			};
			const { context } = createTestContext({
				repos: {
					cases: failingCaseRepo as unknown as MemoryCaseRepository,
				},
			});
			const client = createRouterClient(router, { context });

			await expect(
				client.case.create({ title: "Failing case" }),
			).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				status: 500,
			});

			expect(errorSpy).toHaveBeenCalled();
			const allLogged = JSON.stringify(errorSpy.mock.calls);
			expect(allLogged).not.toContain(secretVal);

			errorSpy.mockRestore();
		});
	});

	describe("9. Explicit role and permission matrix", () => {
		it("enforces viewer, investigator, owner role hierarchy and permissions", () => {
			expect(hasRole("owner", "viewer")).toBe(true);
			expect(hasRole("owner", "investigator")).toBe(true);
			expect(hasRole("owner", "owner")).toBe(true);

			expect(hasRole("investigator", "viewer")).toBe(true);
			expect(hasRole("investigator", "investigator")).toBe(true);
			expect(hasRole("investigator", "owner")).toBe(false);

			expect(hasRole("viewer", "viewer")).toBe(true);
			expect(hasRole("viewer", "investigator")).toBe(false);
			expect(hasRole("viewer", "owner")).toBe(false);

			// Permissions check
			expect(hasPermission("viewer", "cases:read")).toBe(true);
			expect(hasPermission("viewer", "cases:create")).toBe(false);
			expect(hasPermission("viewer", "evidence:upload")).toBe(false);
			expect(hasPermission("viewer", "analysis:start")).toBe(false);
			expect(hasPermission("viewer", "analysis:retry")).toBe(false);

			expect(hasPermission("investigator", "cases:read")).toBe(true);
			expect(hasPermission("investigator", "cases:create")).toBe(true);
			expect(hasPermission("investigator", "evidence:upload")).toBe(true);
			expect(hasPermission("investigator", "analysis:start")).toBe(true);
			expect(hasPermission("investigator", "analysis:retry")).toBe(false);
			expect(hasPermission("investigator", "admin:manage")).toBe(false);

			expect(hasPermission("owner", "cases:read")).toBe(true);
			expect(hasPermission("owner", "cases:create")).toBe(true);
			expect(hasPermission("owner", "evidence:upload")).toBe(true);
			expect(hasPermission("owner", "analysis:start")).toBe(true);
			expect(hasPermission("owner", "analysis:retry")).toBe(true);
			expect(hasPermission("owner", "retention:manage")).toBe(true);
			expect(hasPermission("owner", "admin:manage")).toBe(true);
		});
	});
});
