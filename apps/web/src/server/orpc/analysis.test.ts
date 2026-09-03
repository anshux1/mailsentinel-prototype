import {
	type AnalysisRunShell,
	type AuditRecordShell,
	type CaseShell,
	type EvidenceShell,
	type MembershipShell,
	MemoryRepositories,
} from "@mailsentinel/db";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { env } from "@/env";
import { MemoryAnalyzerClient } from "@/server/analyzer-client";
import type { RpcContext } from "./context";
import { DependencyError } from "./errors";
import { router } from "./router";

describe("Phase S5: Analysis Creation & Private Analyzer Dispatch", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	const caseAlpha1: CaseShell = {
		id: "case_alpha_1",
		organizationId: "org_alpha",
		title: "Alpha Phishing Investigation",
		createdAt: new Date("2026-09-01T10:00:00Z"),
		updatedAt: new Date("2026-09-01T10:00:00Z"),
	};

	const caseBeta1: CaseShell = {
		id: "case_beta_1",
		organizationId: "org_beta",
		title: "Beta Foreign Investigation",
		createdAt: new Date("2026-09-01T11:00:00Z"),
		updatedAt: new Date("2026-09-01T11:00:00Z"),
	};

	const verifiedEvidenceAlpha: EvidenceShell = {
		id: "ev_alpha_verified_1",
		organizationId: "org_alpha",
		caseId: "case_alpha_1",
		objectKey:
			"organizations/org_alpha/cases/case_alpha_1/artifacts/art_001.eml",
		sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		byteSize: 1024,
		contentType: "message/rfc822",
		status: "verified",
		idempotencyKey: null,
		storedAt: new Date("2026-09-01T10:05:00Z"),
		verifiedAt: new Date("2026-09-01T10:05:00Z"),
		failedAt: null,
		failureReason: null,
		createdAt: new Date("2026-09-01T10:01:00Z"),
		updatedAt: new Date("2026-09-01T10:05:00Z"),
	};

	const pendingEvidenceAlpha: EvidenceShell = {
		id: "ev_alpha_pending_1",
		organizationId: "org_alpha",
		caseId: "case_alpha_1",
		objectKey:
			"organizations/org_alpha/cases/case_alpha_1/artifacts/art_pending.eml",
		sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		byteSize: 500,
		contentType: "message/rfc822",
		status: "pending",
		idempotencyKey: null,
		storedAt: null,
		verifiedAt: null,
		failedAt: null,
		failureReason: null,
		createdAt: new Date("2026-09-01T10:02:00Z"),
		updatedAt: new Date("2026-09-01T10:02:00Z"),
	};

	const failedEvidenceAlpha: EvidenceShell = {
		id: "ev_alpha_failed_1",
		organizationId: "org_alpha",
		caseId: "case_alpha_1",
		objectKey:
			"organizations/org_alpha/cases/case_alpha_1/artifacts/art_failed.eml",
		sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		byteSize: 200,
		contentType: "message/rfc822",
		status: "failed",
		idempotencyKey: null,
		storedAt: null,
		verifiedAt: null,
		failedAt: new Date("2026-09-01T10:03:00Z"),
		failureReason: "Digest mismatch",
		createdAt: new Date("2026-09-01T10:02:00Z"),
		updatedAt: new Date("2026-09-01T10:03:00Z"),
	};

	const verifiedEvidenceBeta: EvidenceShell = {
		id: "ev_beta_verified_1",
		organizationId: "org_beta",
		caseId: "case_beta_1",
		objectKey:
			"organizations/org_beta/cases/case_beta_1/artifacts/art_beta.eml",
		sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		byteSize: 2048,
		contentType: "message/rfc822",
		status: "verified",
		idempotencyKey: null,
		storedAt: new Date("2026-09-01T11:05:00Z"),
		verifiedAt: new Date("2026-09-01T11:05:00Z"),
		failedAt: null,
		failureReason: null,
		createdAt: new Date("2026-09-01T11:01:00Z"),
		updatedAt: new Date("2026-09-01T11:05:00Z"),
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
	];

	function setupTest(overrides: Partial<RpcContext> = {}) {
		const cases = [caseAlpha1, caseBeta1];
		const evidenceList = [
			verifiedEvidenceAlpha,
			pendingEvidenceAlpha,
			failedEvidenceAlpha,
			verifiedEvidenceBeta,
		];
		const runs: AnalysisRunShell[] = [];
		const audits: AuditRecordShell[] = [];

		const memoryRepos = new MemoryRepositories({
			cases,
			evidence: evidenceList,
			analysisRuns: runs,
			auditRecords: audits,
			memberships,
		});

		const analyzerClient = new MemoryAnalyzerClient();

		const context: RpcContext = {
			requestId: "req_s5_test",
			userId: "user_investigator",
			organizationId: "org_alpha",
			role: "investigator",
			repos: {
				cases: memoryRepos.cases,
				evidence: memoryRepos.evidence,
				analysisRuns: memoryRepos.analysisRuns,
				audit: memoryRepos.audit,
				memberships: memoryRepos.memberships,
			},
			analyzerClient,
			executeTx: (fn) => memoryRepos.transaction(fn),
			...overrides,
		};

		const client = createRouterClient(router, { context });

		return {
			context,
			client,
			caseRepo: memoryRepos.cases,
			evidenceRepo: memoryRepos.evidence,
			analysisRepo: memoryRepos.analysisRuns,
			auditRepo: memoryRepos.audit,
			analyzerClient,
			memoryRepos,
		};
	}

	describe("1. Role & Permission Gating", () => {
		it("rejects anonymous access to analysis.start with UNAUTHORIZED", async () => {
			const { client } = setupTest({
				userId: null,
				organizationId: null,
				role: null,
			});

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
				}),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
				status: 401,
			});
		});

		it("rejects viewer from calling analysis.start with FORBIDDEN", async () => {
			const { client } = setupTest({
				userId: "user_viewer",
				role: "viewer",
			});

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
			});
		});

		it("allows investigator to call analysis.start", async () => {
			const { client } = setupTest({
				userId: "user_investigator",
				role: "investigator",
			});

			const result = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
			});

			expect(result.status).toBe("queued");
		});

		it("allows owner to call analysis.start via role hierarchy", async () => {
			const { client } = setupTest({
				userId: "user_owner",
				role: "owner",
			});

			const result = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
			});

			expect(result.status).toBe("queued");
		});

		it("rejects viewer and investigator from calling analysis.retry with FORBIDDEN", async () => {
			const { client: viewerClient } = setupTest({
				userId: "user_viewer",
				role: "viewer",
			});

			await expect(
				viewerClient.analysis.retry({
					analysisRunId: "run_any",
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
			});

			const { client: invClient } = setupTest({
				userId: "user_investigator",
				role: "investigator",
			});

			await expect(
				invClient.analysis.retry({
					analysisRunId: "run_any",
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				status: 403,
			});
		});

		it("allows owner to call analysis.retry", async () => {
			const { client, analysisRepo } = setupTest({
				userId: "user_owner",
				role: "owner",
			});

			// Seed a failed retryable run
			const created = await analysisRepo.createAnalysisRun({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				status: "accepted",
			});
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: created.id,
				fromStatus: "accepted",
				toStatus: "failed",
				retryable: true,
				failureCode: "analyzer_unavailable",
				failureMessage: "Temporary outage",
				failedAt: new Date(),
			});

			const result = await client.analysis.retry({
				analysisRunId: created.id,
			});

			expect(result.status).toBe("queued");
			expect(result.attempts).toBe(1);
		});
	});

	describe("2. Authoritative Database Metadata & Payload Construction", () => {
		it("rejects client attempts to pass organizationId or objectKey in start input", async () => {
			const { client } = setupTest();

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
					organizationId: "org_evil",
				} as unknown as { caseId: string; evidenceId: string }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
					objectKey: "organizations/org_evil/artifacts/evil.eml",
				} as unknown as { caseId: string; evidenceId: string }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		});

		it("constructs AnalysisIntakeRequest exclusively from authoritative DB metadata", async () => {
			const { client, analyzerClient, context } = setupTest();

			const run = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
			});

			expect(analyzerClient.dispatched).toHaveLength(1);
			const intake = analyzerClient.dispatched[0];
			expect(intake).toBeDefined();

			// Verify authoritative properties
			expect(intake?.request.analysisRunId).toBe(run.id);
			expect(intake?.request.organizationId).toBe(context.organizationId);
			expect(intake?.request.caseId).toBe("case_alpha_1");
			expect(intake?.request.artifact.objectKey).toBe(
				verifiedEvidenceAlpha.objectKey,
			);
			expect(intake?.request.artifact.sha256).toBe(
				verifiedEvidenceAlpha.sha256,
			);
			expect(intake?.request.artifact.byteSize).toBe(
				verifiedEvidenceAlpha.byteSize,
			);
			expect(intake?.request.artifact.digestAlgorithm).toBe("sha256");

			// Verify ISO 8601 requestedAt timestamp
			expect(intake?.request.requestedAt).toBeDefined();
			const reqAt = intake?.request.requestedAt;
			if (reqAt) {
				expect(new Date(reqAt).toISOString()).toBe(reqAt);
			}

			// Verify requestId propagation
			expect(intake?.requestId).toBe(context.requestId);
		});

		it("does not expose internal objectKey or idempotencyKey in response", async () => {
			const { client } = setupTest();

			const run = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				idempotencyKey: "idem_key_safe_check",
			});

			expect(run).not.toHaveProperty("objectKey");
			expect(run).not.toHaveProperty("idempotencyKey");
			expect(run.status).toBe("queued");
		});
	});

	describe("3. Cross-Tenant Isolation", () => {
		it("rejects starting analysis against a case in another tenant with NOT_FOUND", async () => {
			const { client } = setupTest();

			await expect(
				client.analysis.start({
					caseId: "case_beta_1", // belongs to org_beta
					evidenceId: "ev_alpha_verified_1",
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				status: 404,
			});
		});

		it("rejects starting analysis against evidence belonging to another tenant with NOT_FOUND", async () => {
			const { client } = setupTest();

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_beta_verified_1", // belongs to org_beta
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				status: 404,
			});
		});

		it("rejects retrying an analysis run belonging to another tenant with NOT_FOUND", async () => {
			const { client, analysisRepo } = setupTest({
				role: "owner",
			});

			// Create a failed run in org_beta
			const betaRun = await analysisRepo.createAnalysisRun({
				organizationId: "org_beta",
				caseId: "case_beta_1",
				evidenceId: "ev_beta_verified_1",
				status: "failed",
			});

			await expect(
				client.analysis.retry({
					analysisRunId: betaRun.id,
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				status: 404,
			});
		});
	});

	describe("4. Verified Immutable Evidence Requirement", () => {
		it("rejects starting analysis when evidence is in 'pending' status", async () => {
			const { client } = setupTest();

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_pending_1",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				status: 409,
			});
		});

		it("rejects starting analysis when evidence is in 'failed' status", async () => {
			const { client } = setupTest();

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_failed_1",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				status: 409,
			});
		});
	});

	describe("5. Exact 202/Accepted Transition to Queued & Safe Audit", () => {
		it("transitions accepted -> queued on exact 202 response and records audit events", async () => {
			const { client, analysisRepo, auditRepo, analyzerClient } = setupTest();

			analyzerClient.customAcceptedStatus = "accepted";

			const run = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
			});

			expect(run.status).toBe("queued");
			expect(run.phase).toBe("queued");
			expect(run.progress).toBe(0);

			// Verify DB record status is queued
			const dbRun = await analysisRepo.getAnalysisRun({
				organizationId: "org_alpha",
				analysisRunId: run.id,
			});
			expect(dbRun?.status).toBe("queued");
			expect(dbRun?.queuedAt).toBeDefined();

			// Verify audit trail
			const audits = await auditRepo.listAuditRecords({
				organizationId: "org_alpha",
			});
			const actions = audits.map((a) => a.action);
			expect(actions).toContain("analysis.start");
			expect(actions).toContain("analysis.intake_dispatched");
		});

		it("re-reads canonical tenant run and accepts analyzer-side status mutation to queued before response", async () => {
			const { client, analyzerClient, analysisRepo, auditRepo } = setupTest();

			analyzerClient.onBeforeDispatch = async (req) => {
				await analysisRepo.transitionStatus({
					organizationId: "org_alpha",
					analysisRunId: req.analysisRunId,
					fromStatus: "accepted",
					toStatus: "queued",
					phase: "queued",
					progress: 0,
					queuedAt: new Date(),
				});
			};

			const run = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
			});

			expect(run.status).toBe("queued");

			const audits = await auditRepo.listAuditRecords({
				organizationId: "org_alpha",
			});
			const dispatchedAudit = audits.find(
				(a) => a.action === "analysis.intake_dispatched",
			);
			expect(dispatchedAudit?.metadata.status).toBe("queued");
		});

		it("re-reads canonical tenant run and accepts analyzer-side status mutation to processing before response", async () => {
			const { client, analyzerClient, analysisRepo, auditRepo } = setupTest();

			analyzerClient.onBeforeDispatch = async (req) => {
				await analysisRepo.transitionStatus({
					organizationId: "org_alpha",
					analysisRunId: req.analysisRunId,
					fromStatus: "accepted",
					toStatus: "processing",
					phase: "parsing",
					progress: 25,
					startedAt: new Date(),
				});
			};

			const run = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
			});

			expect(run.status).toBe("processing");
			expect(run.phase).toBe("parsing");

			const audits = await auditRepo.listAuditRecords({
				organizationId: "org_alpha",
			});
			const dispatchedAudit = audits.find(
				(a) => a.action === "analysis.intake_dispatched",
			);
			expect(dispatchedAudit?.metadata.status).toBe("processing");
		});
	});

	describe("6. Idempotency & Concurrency", () => {
		it("returns identical logical run on duplicate start with same idempotencyKey", async () => {
			const { client, analyzerClient } = setupTest();

			const first = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				idempotencyKey: "key_idempotent_01",
			});

			expect(analyzerClient.dispatched).toHaveLength(1);

			const second = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				idempotencyKey: "key_idempotent_01",
			});

			expect(second.id).toBe(first.id);
			expect(second.status).toBe("queued");
			// Analyzer should NOT have been dispatched twice
			expect(analyzerClient.dispatched).toHaveLength(1);
		});

		it("rejects duplicate start with same idempotencyKey but differing evidenceId with CONFLICT", async () => {
			const { client } = setupTest();

			await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				idempotencyKey: "key_idempotent_conflict",
			});

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_pending_1",
					idempotencyKey: "key_idempotent_conflict",
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				status: 409,
			});
		});

		it("returns active run on duplicate start without idempotencyKey to prevent duplicate intake", async () => {
			const { client, analyzerClient } = setupTest();

			const run1 = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
			});

			expect(analyzerClient.dispatched).toHaveLength(1);

			// Calling start again on same evidence while active returns same logical run
			const run2 = await client.analysis.start({
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
			});

			expect(run2.id).toBe(run1.id);
			expect(analyzerClient.dispatched).toHaveLength(1);
		});

		it("handles concurrent duplicate starts without duplicating analyzer intake", async () => {
			const { client, analyzerClient } = setupTest();

			analyzerClient.simulateDelayMs = 20;

			const [result1, result2] = await Promise.all([
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
					idempotencyKey: "concurrent_idem_key",
				}),
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
					idempotencyKey: "concurrent_idem_key",
				}),
			]);

			expect(result1.id).toBe(result2.id);
			expect(analyzerClient.dispatched.length).toBeLessThanOrEqual(1);
		});

		it("assigns deterministic server-owned idempotency key when browser omits one, producing one logical run and one dispatch on concurrent duplicate starts", async () => {
			const { client, analyzerClient, analysisRepo } = setupTest();

			analyzerClient.simulateDelayMs = 25;

			const [result1, result2] = await Promise.all([
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
				}),
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
				}),
			]);

			expect(result1.id).toBe(result2.id);
			expect(analyzerClient.dispatched).toHaveLength(1);

			const runs = await analysisRepo.listAnalysisRuns({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
			});
			expect(runs).toHaveLength(1);
			expect(runs[0]?.idempotencyKey).toMatch(/^srv_[0-9a-f]{64}$/);
		});
	});

	describe("7. Analyzer Error Handling & Recoverable DB State", () => {
		it("handles analyzer 401: throws safe DependencyError, marks run failed (retryable), logs safe audit", async () => {
			const { client, analyzerClient, analysisRepo, auditRepo } = setupTest();

			analyzerClient.simulateStatus = 401;

			let errorCaught:
				| { code?: string; status?: number; data?: { code?: string } }
				| undefined;
			try {
				await client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
				});
			} catch (err) {
				errorCaught = err as {
					code?: string;
					status?: number;
					data?: { code?: string };
				};
			}

			expect(errorCaught).toBeDefined();
			expect(errorCaught?.code).toBe("BAD_GATEWAY");
			expect(errorCaught?.status).toBe(502);
			expect(errorCaught?.data?.code).toBe("DEPENDENCY_ERROR");

			// Assert no secret token in error message or data
			const errorString = JSON.stringify(errorCaught);
			expect(errorString).not.toContain(env.ANALYZER_SERVICE_TOKEN);

			// Verify DB state is recoverable (failed + retryable: true)
			const runs = await analysisRepo.listAnalysisRuns({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
			});
			expect(runs).toHaveLength(1);
			expect(runs[0]?.status).toBe("failed");
			expect(runs[0]?.retryable).toBe(true);
			expect(runs[0]?.failureCode).toBe("analyzer_unauthorized");

			// Verify safe audit record
			const audits = await auditRepo.listAuditRecords({
				organizationId: "org_alpha",
			});
			const failAudit = audits.find((a) => a.action === "analysis.failed");
			expect(failAudit).toBeDefined();
			expect(JSON.stringify(failAudit)).not.toContain(
				env.ANALYZER_SERVICE_TOKEN,
			);
		});

		it("handles analyzer 422 validation error: throws safe error, retains failure state", async () => {
			const { client, analyzerClient, analysisRepo } = setupTest();

			analyzerClient.simulateStatus = 422;

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
				}),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				status: 502,
				data: { code: "DEPENDENCY_ERROR" },
			});

			const runs = await analysisRepo.listAnalysisRuns({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
			});
			expect(runs).toHaveLength(1);
			expect(runs[0]?.status).toBe("failed");
			expect(runs[0]?.failureCode).toBe("intake_invalid");
		});

		it("handles analyzer 503 unavailable: throws safe DependencyError, retains recoverable state", async () => {
			const { client, analyzerClient, analysisRepo } = setupTest();

			analyzerClient.simulateStatus = 503;

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
				}),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				status: 502,
				data: { code: "DEPENDENCY_ERROR" },
			});

			const runs = await analysisRepo.listAnalysisRuns({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
			});
			expect(runs).toHaveLength(1);
			expect(runs[0]?.status).toBe("failed");
			expect(runs[0]?.retryable).toBe(true);
			expect(runs[0]?.failureCode).toBe("analyzer_unavailable");
		});

		it("handles analyzer timeout: throws safe DependencyError, retains recoverable state", async () => {
			const { client, analyzerClient, analysisRepo } = setupTest();

			analyzerClient.simulateStatus = "timeout";

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
				}),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				status: 502,
				data: { code: "DEPENDENCY_ERROR" },
			});

			const runs = await analysisRepo.listAnalysisRuns({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
			});
			expect(runs).toHaveLength(1);
			expect(runs[0]?.status).toBe("failed");
			expect(runs[0]?.retryable).toBe(true);
			expect(runs[0]?.failureCode).toBe("analyzer_timeout");
		});

		it("never persists arbitrary DependencyError.message; unknown analyzer errors get fixed safe failure message and code", async () => {
			const { client, analyzerClient, analysisRepo } = setupTest();

			const sensitiveErrorMessage =
				"POST https://internal-analyzer.service/v1/analyses: secret_token_xyz leaking details";
			analyzerClient.dispatchIntake = vi
				.fn()
				.mockRejectedValue(
					new DependencyError(sensitiveErrorMessage, "analyzer"),
				);

			await expect(
				client.analysis.start({
					caseId: "case_alpha_1",
					evidenceId: "ev_alpha_verified_1",
				}),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				status: 502,
			});

			const runs = await analysisRepo.listAnalysisRuns({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
			});
			expect(runs).toHaveLength(1);
			const failedRun = runs[0];
			expect(failedRun).toBeDefined();
			expect(failedRun?.status).toBe("failed");
			expect(failedRun?.failureCode).toBe("analyzer_unavailable");
			expect(failedRun?.failureMessage).toBe(
				"Analyzer service dispatch failed",
			);
			expect(failedRun?.failureMessage).not.toContain("secret_token");
			expect(failedRun?.failureMessage).not.toContain(sensitiveErrorMessage);
		});
	});

	describe("8. Explicit Retry Mutation & Policy Checks", () => {
		it("allows owner to retry a failed retryable run and redispatches authoritative data", async () => {
			const { client, analysisRepo, analyzerClient, auditRepo } = setupTest({
				role: "owner",
				userId: "user_owner",
			});

			// Setup a failed run
			const run = await analysisRepo.createAnalysisRun({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				status: "accepted",
			});
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: run.id,
				fromStatus: "accepted",
				toStatus: "failed",
				retryable: true,
				failureCode: "analyzer_unavailable",
				failureMessage: "Service was down",
				failedAt: new Date(),
			});

			const retried = await client.analysis.retry({
				analysisRunId: run.id,
			});

			expect(retried.id).toBe(run.id);
			expect(retried.status).toBe("queued");
			expect(retried.attempts).toBe(1);

			// Verify redispatch
			expect(analyzerClient.dispatched).toHaveLength(1);
			const redispatch = analyzerClient.dispatched[0];
			expect(redispatch?.request.analysisRunId).toBe(run.id);
			expect(redispatch?.request.artifact.objectKey).toBe(
				verifiedEvidenceAlpha.objectKey,
			);

			// Verify retry audit
			const audits = await auditRepo.listAuditRecords({
				organizationId: "org_alpha",
			});
			const retryAudit = audits.find((a) => a.action === "analysis.retry");
			expect(retryAudit).toBeDefined();
			expect(retryAudit?.metadata.attempts).toBe("1");
		});

		it("rejects retry when run is in 'queued' or 'completed' status with CONFLICT", async () => {
			const { client, analysisRepo } = setupTest({
				role: "owner",
				userId: "user_owner",
			});

			const queuedRun = await analysisRepo.createAnalysisRun({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				status: "queued",
			});

			await expect(
				client.analysis.retry({
					analysisRunId: queuedRun.id,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				status: 409,
			});
		});

		it("rejects retry when run is not marked retryable with CONFLICT", async () => {
			const { client, analysisRepo } = setupTest({
				role: "owner",
				userId: "user_owner",
			});

			const nonRetryableRun = await analysisRepo.createAnalysisRun({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				status: "accepted",
			});
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: nonRetryableRun.id,
				fromStatus: "accepted",
				toStatus: "failed",
				retryable: false,
			});

			await expect(
				client.analysis.retry({
					analysisRunId: nonRetryableRun.id,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				status: 409,
			});
		});

		it("rejects retry when max attempts (3) have been reached", async () => {
			const { client, analysisRepo } = setupTest({
				role: "owner",
				userId: "user_owner",
			});

			const run = await analysisRepo.createAnalysisRun({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				status: "accepted",
			});

			// Transition and manually simulate 3 prior attempts
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: run.id,
				fromStatus: "accepted",
				toStatus: "failed",
				retryable: true,
			});

			// Retry 1
			await client.analysis.retry({ analysisRunId: run.id });
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: run.id,
				fromStatus: "queued",
				toStatus: "failed",
				retryable: true,
			});

			// Retry 2
			await client.analysis.retry({ analysisRunId: run.id });
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: run.id,
				fromStatus: "queued",
				toStatus: "failed",
				retryable: true,
			});

			// Retry 3
			await client.analysis.retry({ analysisRunId: run.id });
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: run.id,
				fromStatus: "queued",
				toStatus: "failed",
				retryable: true,
			});

			// Retry 4 -> Should be rejected
			await expect(
				client.analysis.retry({
					analysisRunId: run.id,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				status: 409,
			});
		});

		it("transitions back to failed if redispatch fails during retry", async () => {
			const { client, analysisRepo, analyzerClient } = setupTest({
				role: "owner",
				userId: "user_owner",
			});

			const run = await analysisRepo.createAnalysisRun({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				status: "accepted",
			});
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: run.id,
				fromStatus: "accepted",
				toStatus: "failed",
				retryable: true,
			});

			analyzerClient.simulateStatus = 503;

			await expect(
				client.analysis.retry({
					analysisRunId: run.id,
				}),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				status: 502,
			});

			const updated = await analysisRepo.getAnalysisRun({
				organizationId: "org_alpha",
				analysisRunId: run.id,
			});
			expect(updated?.status).toBe("failed");
			expect(updated?.retryable).toBe(true);
		});

		it("sets status to accepted during retry preparation before dispatch and reconciles to queued", async () => {
			const { client, analysisRepo, analyzerClient } = setupTest({
				role: "owner",
				userId: "user_owner",
			});

			const run = await analysisRepo.createAnalysisRun({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				status: "accepted",
			});
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: run.id,
				fromStatus: "accepted",
				toStatus: "failed",
				retryable: true,
				failureCode: "analyzer_unavailable",
				failureMessage: "Transient error",
				failedAt: new Date(),
			});

			let statusAtDispatch: string | undefined;
			analyzerClient.onBeforeDispatch = async (req) => {
				const current = await analysisRepo.getAnalysisRun({
					organizationId: "org_alpha",
					analysisRunId: req.analysisRunId,
				});
				statusAtDispatch = current?.status;
			};

			const retried = await client.analysis.retry({ analysisRunId: run.id });
			expect(statusAtDispatch).toBe("accepted");
			expect(retried.status).toBe("queued");
		});

		it("re-reads canonical tenant run and accepts analyzer-side status mutation during retry dispatch", async () => {
			const { client, analysisRepo, analyzerClient, auditRepo } = setupTest({
				role: "owner",
				userId: "user_owner",
			});

			const run = await analysisRepo.createAnalysisRun({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				status: "accepted",
			});
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: run.id,
				fromStatus: "accepted",
				toStatus: "failed",
				retryable: true,
				failureCode: "analyzer_unavailable",
			});

			analyzerClient.onBeforeDispatch = async (req) => {
				// Simulate analyzer atomic transition to queued in shared DB
				await analysisRepo.transitionStatus({
					organizationId: "org_alpha",
					analysisRunId: req.analysisRunId,
					fromStatus: "accepted",
					toStatus: "queued",
					phase: "queued",
					progress: 0,
					queuedAt: new Date(),
				});
			};

			const retried = await client.analysis.retry({ analysisRunId: run.id });
			expect(retried.status).toBe("queued");

			const audits = await auditRepo.listAuditRecords({
				organizationId: "org_alpha",
			});
			const dispatchedAudit = audits.find(
				(a) => a.action === "analysis.intake_dispatched",
			);
			expect(dispatchedAudit?.metadata.status).toBe("queued");
		});

		it("on retry dispatch failure does not clobber processing or completed run", async () => {
			const { client, analysisRepo, analyzerClient } = setupTest({
				role: "owner",
				userId: "user_owner",
			});

			const run = await analysisRepo.createAnalysisRun({
				organizationId: "org_alpha",
				caseId: "case_alpha_1",
				evidenceId: "ev_alpha_verified_1",
				status: "accepted",
			});
			await analysisRepo.transitionStatus({
				organizationId: "org_alpha",
				analysisRunId: run.id,
				fromStatus: "accepted",
				toStatus: "failed",
				retryable: true,
				failureCode: "analyzer_unavailable",
			});

			analyzerClient.simulateStatus = 503;
			analyzerClient.onBeforeDispatch = async (req) => {
				// Simulate worker immediately picking it up to processing
				await analysisRepo.transitionStatus({
					organizationId: "org_alpha",
					analysisRunId: req.analysisRunId,
					fromStatus: "accepted",
					toStatus: "processing",
					phase: "extracting",
					progress: 50,
					startedAt: new Date(),
				});
			};

			await expect(
				client.analysis.retry({ analysisRunId: run.id }),
			).rejects.toMatchObject({
				code: "BAD_GATEWAY",
				status: 502,
			});

			const finalRun = await analysisRepo.getAnalysisRun({
				organizationId: "org_alpha",
				analysisRunId: run.id,
			});
			// Must NOT be clobbered to failed; remains processing
			expect(finalRun?.status).toBe("processing");
		});
	});
});
