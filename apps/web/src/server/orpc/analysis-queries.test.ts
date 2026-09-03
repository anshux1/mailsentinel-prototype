import {
	type AnalysisRunShell,
	MemoryAnalysisRunRepository,
} from "@mailsentinel/db";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { RpcContext } from "./context";
import { router } from "./router";

describe("Phase S6: Analysis Queries & Polling Contract (getStatus, getResult, list)", () => {
	const queuedRunOrg1: AnalysisRunShell = {
		id: "run_queued_01",
		organizationId: "org_01",
		caseId: "case_01",
		evidenceId: "ev_01",
		status: "queued",
		verdict: null,
		score: null,
		confidence: null,
		analysisVersion: "1.0.0",
		rulesetVersion: "1.0.0",
		resultSchemaVersion: "1.0.0",
		resultSnapshot: null,
		failureCode: null,
		failureMessage: null,
		retryable: false,
		attempts: 1,
		phase: "queued",
		progress: 0,
		idempotencyKey: "idem_01",
		queuedAt: new Date("2026-09-01T10:00:00Z"),
		startedAt: null,
		completedAt: null,
		failedAt: null,
		createdAt: new Date("2026-09-01T10:00:00Z"),
		updatedAt: new Date("2026-09-01T10:00:00Z"),
	};

	const processingRunOrg1: AnalysisRunShell = {
		id: "run_proc_01",
		organizationId: "org_01",
		caseId: "case_01",
		evidenceId: "ev_01",
		status: "processing",
		verdict: null,
		score: null,
		confidence: null,
		analysisVersion: "1.0.0",
		rulesetVersion: "1.0.0",
		resultSchemaVersion: "1.0.0",
		resultSnapshot: null,
		failureCode: null,
		failureMessage: null,
		retryable: false,
		attempts: 1,
		phase: "extracting",
		progress: 45,
		idempotencyKey: "idem_02",
		queuedAt: new Date("2026-09-01T10:05:00Z"),
		startedAt: new Date("2026-09-01T10:05:05Z"),
		completedAt: null,
		failedAt: null,
		createdAt: new Date("2026-09-01T10:05:00Z"),
		updatedAt: new Date("2026-09-01T10:05:15Z"),
	};

	const failedRunOrg1: AnalysisRunShell = {
		id: "run_failed_01",
		organizationId: "org_01",
		caseId: "case_01",
		evidenceId: "ev_01",
		status: "failed",
		verdict: null,
		score: null,
		confidence: null,
		analysisVersion: "1.0.0",
		rulesetVersion: "1.0.0",
		resultSchemaVersion: "1.0.0",
		resultSnapshot: null,
		failureCode: "analyzer_timeout",
		failureMessage: "Analyzer service request timed out",
		retryable: true,
		attempts: 1,
		phase: "scoring",
		progress: 80,
		idempotencyKey: "idem_03",
		queuedAt: new Date("2026-09-01T10:10:00Z"),
		startedAt: new Date("2026-09-01T10:10:05Z"),
		completedAt: null,
		failedAt: new Date("2026-09-01T10:10:35Z"),
		createdAt: new Date("2026-09-01T10:10:00Z"),
		updatedAt: new Date("2026-09-01T10:10:35Z"),
	};

	const completedSnapshot = {
		schemaVersion: "1.0.0",
		rulesetVersion: "1.0.0",
		analysisVersion: "1.0.0",
		analysisRunId: "run_comp_01",
		organizationId: "org_01",
		caseId: "case_01",
		artifactSha256:
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		artifactByteSize: 24831,
		artifactDigestAlgorithm: "sha256",
		analyzedAt: "2026-09-01T10:20:25.000Z",
		verdict: "malicious",
		confidence: 0.95,
		objectKey: "organizations/org_01/cases/case_01/artifacts/private.eml", // intentionally seeded to prove it gets stripped
		score: {
			baseScore: 0,
			contributions: [
				{
					ruleId: "auth.spf.fail",
					category: "authentication",
					severity: "high",
					scoreContribution: 40,
					explanation:
						"Reported SPF result is fail <script>alert('xss')</script>",
					evidenceRefs: ["authentication-results"],
					source: "authentication-results",
				},
				{
					ruleId: "link.mismatch",
					category: "url",
					severity: "critical",
					scoreContribution: 45,
					explanation:
						"Anchor display text points to paypal but href is attacker",
					evidenceRefs: [],
					source: "html_body",
				},
			],
			finalScore: 85,
		},
		findings: [
			{
				ruleId: "auth.spf.fail",
				category: "authentication",
				severity: "high",
				scoreContribution: 40,
				explanation:
					"Reported SPF result is fail <script>alert('xss')</script>",
				evidenceRefs: ["authentication-results"],
				source: "authentication-results",
			},
			{
				ruleId: "link.mismatch",
				category: "url",
				severity: "critical",
				scoreContribution: 45,
				explanation:
					"Anchor display text points to paypal but href is attacker",
				evidenceRefs: [],
				source: "html_body",
			},
		],
		headers: [
			{
				name: "Subject",
				value: "Urgent Wire Transfer",
				occurrence: 1,
				malformed: false,
			},
		],
		addresses: [
			{
				address: "attacker@external.example",
				displayName: "Finance Department",
				domain: "external.example",
				source: "From",
				value: "Finance Department <attacker@external.example>",
			},
		],
		receivedHops: [],
		authentication: [
			{
				method: "spf",
				result: "fail",
				declaringHost: "mx.example.org",
				reason: "SPF fail",
				source: "authentication-results",
				independentlyVerified: false,
				selector: null,
				domain: null,
				signingDomain: null,
				identity: null,
				algorithm: null,
				signedHeaders: [],
			},
		],
		authConflicts: [],
		identityObservations: [],
		dateObservations: [],
		messageIdObservations: [],
		mimeParts: [
			{
				partId: "part_0",
				contentType: "text/plain",
				byteSize: 512,
				disposition: "inline",
				filename: null,
				isAttachment: false,
				sha256: null,
				digestAlgorithm: null,
				dangerousExtension: false,
				typeExtensionMismatch: false,
			},
		],
		indicators: [],
		linkMismatches: [
			{
				displayText: "https://paypal.example/login",
				displayDomain: "paypal.example",
				actualHref: "https://attacker.example/login",
				actualDomain: "attacker.example",
				explanation: "Anchor text does not match href",
			},
		],
		contentIndicators: [],
		parserWarnings: [],
		routingAnomalies: [],
		enrichment: [],
	};

	const completedRunOrg1: AnalysisRunShell = {
		id: "run_comp_01",
		organizationId: "org_01",
		caseId: "case_01",
		evidenceId: "ev_01",
		status: "completed",
		verdict: "malicious",
		score: 85,
		confidence: 0.95,
		analysisVersion: "1.0.0",
		rulesetVersion: "1.0.0",
		resultSchemaVersion: "1.0.0",
		resultSnapshot: completedSnapshot,
		failureCode: null,
		failureMessage: null,
		retryable: false,
		attempts: 1,
		phase: "completed",
		progress: 100,
		idempotencyKey: "idem_04",
		queuedAt: new Date("2026-09-01T10:20:00Z"),
		startedAt: new Date("2026-09-01T10:20:05Z"),
		completedAt: new Date("2026-09-01T10:20:25Z"),
		failedAt: null,
		createdAt: new Date("2026-09-01T10:20:00Z"),
		updatedAt: new Date("2026-09-01T10:20:25Z"),
	};

	const foreignRunOrg2: AnalysisRunShell = {
		id: "run_foreign_01",
		organizationId: "org_02",
		caseId: "case_foreign",
		evidenceId: "ev_foreign",
		status: "completed",
		verdict: "benign",
		score: 0,
		confidence: 0.99,
		analysisVersion: "1.0.0",
		rulesetVersion: "1.0.0",
		resultSchemaVersion: "1.0.0",
		resultSnapshot: {},
		failureCode: null,
		failureMessage: null,
		retryable: false,
		attempts: 1,
		phase: "completed",
		progress: 100,
		idempotencyKey: "idem_foreign",
		queuedAt: new Date("2026-09-01T10:30:00Z"),
		startedAt: new Date("2026-09-01T10:30:05Z"),
		completedAt: new Date("2026-09-01T10:30:25Z"),
		failedAt: null,
		createdAt: new Date("2026-09-01T10:30:00Z"),
		updatedAt: new Date("2026-09-01T10:30:25Z"),
	};

	function createTestContext(overrides: Partial<RpcContext> = {}): {
		context: RpcContext;
		analysisRepo: MemoryAnalysisRunRepository;
	} {
		const analysisRepo = new MemoryAnalysisRunRepository([
			{ ...queuedRunOrg1 },
			{ ...processingRunOrg1 },
			{ ...failedRunOrg1 },
			{ ...completedRunOrg1 },
			{ ...foreignRunOrg2 },
		]);
		const context: RpcContext = {
			requestId: "req_query_test",
			userId: "user_viewer",
			organizationId: "org_01",
			role: "viewer",
			repos: {
				analysisRuns: analysisRepo,
			},
			...overrides,
		};
		return { context, analysisRepo };
	}

	describe("Authentication & Role Gating", () => {
		const anonymousContext: RpcContext = {
			requestId: "req_anon",
			userId: null,
			organizationId: null,
		};

		it("rejects anonymous access to getStatus with UNAUTHORIZED", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.analysis.getStatus({ analysisRunId: "run_proc_01" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("rejects anonymous access to getResult with UNAUTHORIZED", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(
				client.analysis.getResult({ analysisRunId: "run_comp_01" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("rejects anonymous access to list with UNAUTHORIZED", async () => {
			const client = createRouterClient(router, { context: anonymousContext });
			await expect(client.analysis.list({})).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("allows viewer, investigator, and owner to call getStatus, getResult, and list", async () => {
			for (const role of ["viewer", "investigator", "owner"] as const) {
				const { context } = createTestContext({
					userId: `user_${role}`,
					role,
				});
				const client = createRouterClient(router, { context });

				const status = await client.analysis.getStatus({
					analysisRunId: "run_proc_01",
				});
				expect(status.status).toBe("processing");

				const result = await client.analysis.getResult({
					analysisRunId: "run_comp_01",
				});
				expect(result.ready).toBe(true);

				const list = await client.analysis.list({});
				expect(list.items).toHaveLength(4);
			}
		});
	});

	describe("Tenant Scoping & Safe Error Mapping", () => {
		it("rejects cross-tenant getStatus lookup with safe NOT_FOUND", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });
			await expect(
				client.analysis.getStatus({ analysisRunId: "run_foreign_01" }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("rejects cross-tenant getResult lookup with safe NOT_FOUND", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });
			await expect(
				client.analysis.getResult({ analysisRunId: "run_foreign_01" }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("rejects non-existent analysisRunId with safe NOT_FOUND", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });
			await expect(
				client.analysis.getStatus({ analysisRunId: "non_existent_run" }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(
				client.analysis.getResult({ analysisRunId: "non_existent_run" }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("rejects getStatus and getResult when caseId does not match with safe NOT_FOUND", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });
			await expect(
				client.analysis.getStatus({
					analysisRunId: "run_proc_01",
					caseId: "wrong_case_id",
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(
				client.analysis.getResult({
					analysisRunId: "run_comp_01",
					caseId: "wrong_case_id",
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("never leaks another tenant's runs in analysis.list", async () => {
			const { context } = createTestContext({ organizationId: "org_01" });
			const client = createRouterClient(router, { context });
			const list = await client.analysis.list({});
			expect(list.items.every((r) => r.organizationId === "org_01")).toBe(true);
			expect(list.items.some((r) => r.id === "run_foreign_01")).toBe(false);
		});
	});

	describe("analysis.getStatus (canonical DB record & active/failed/completed states)", () => {
		it("returns canonical DB status for queued run", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			const status = await client.analysis.getStatus({
				analysisRunId: "run_queued_01",
			});
			expect(status.id).toBe("run_queued_01");
			expect(status.analysisRunId).toBe("run_queued_01");
			expect(status.status).toBe("queued");
			expect(status.phase).toBe("queued");
			expect(status.progress).toBe(0);
			expect(status.failure).toBeNull();
			expect(status.queuedAt).toBeDefined();
		});

		it("returns canonical DB status with progress and phase for processing run", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			const status = await client.analysis.getStatus({
				analysisRunId: "run_proc_01",
			});
			expect(status.status).toBe("processing");
			expect(status.phase).toBe("extracting");
			expect(status.progress).toBe(45);
			expect(status.startedAt).toBeDefined();
			expect(status.failure).toBeNull();
		});

		it("returns failure details and retryable flag for failed run", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			const status = await client.analysis.getStatus({
				analysisRunId: "run_failed_01",
			});
			expect(status.status).toBe("failed");
			expect(status.failureCode).toBe("analyzer_timeout");
			expect(status.failureMessage).toBe("Analyzer service request timed out");
			expect(status.retryable).toBe(true);
			expect(status.failedAt).toBeDefined();
			expect(status.failure).toEqual({
				code: "analyzer_timeout",
				message: "Analyzer service request timed out",
				retryable: true,
				requestId: null,
			});
		});

		it("returns completedAt for completed run", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			const status = await client.analysis.getStatus({
				analysisRunId: "run_comp_01",
			});
			expect(status.status).toBe("completed");
			expect(status.completedAt).toBeDefined();
			expect(status.failure).toBeNull();
		});
	});

	describe("analysis.getResult (discriminated not-ready vs completed)", () => {
		it("returns discriminated not-ready representation for queued run", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			const result = await client.analysis.getResult({
				analysisRunId: "run_queued_01",
			});
			expect(result.ready).toBe(false);
			if (!result.ready) {
				expect(result.status).toBe("queued");
				expect(result.phase).toBe("queued");
				expect(result.progress).toBe(0);
			}
		});

		it("returns discriminated not-ready representation for active processing run", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			const result = await client.analysis.getResult({
				analysisRunId: "run_proc_01",
			});
			expect(result.ready).toBe(false);
			if (!result.ready) {
				expect(result.status).toBe("processing");
				expect(result.phase).toBe("extracting");
				expect(result.progress).toBe(45);
			}
		});

		it("returns discriminated not-ready representation with safe failure details for failed run", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			const result = await client.analysis.getResult({
				analysisRunId: "run_failed_01",
			});
			expect(result.ready).toBe(false);
			if (!result.ready) {
				expect(result.status).toBe("failed");
				expect(result.failureCode).toBe("analyzer_timeout");
				expect(result.failureMessage).toBe(
					"Analyzer service request timed out",
				);
				expect(result.retryable).toBe(true);
				expect(result.failedAt).toBeDefined();
			}
		});

		it("returns full completed summary, findings, score breakdown, verdict, and sanitized text for completed run", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });
			const result = await client.analysis.getResult({
				analysisRunId: "run_comp_01",
			});

			expect(result.ready).toBe(true);
			if (result.ready) {
				expect(result.status).toBe("completed");
				expect(result.verdict).toBe("malicious");
				expect(result.confidence).toBe(0.95);
				expect(result.analysisVersion).toBe("1.0.0");
				expect(result.rulesetVersion).toBe("1.0.0");
				expect(result.schemaVersion).toBe("1.0.0");
				expect(result.completedAt).toBeDefined();

				// Executive summary
				expect(result.summary).toEqual({
					verdict: "malicious",
					finalScore: 85,
					confidence: 0.95,
					findingsCount: 2,
					criticalCount: 1,
					highCount: 1,
					mediumCount: 0,
					lowCount: 0,
					infoCount: 0,
				});

				// Score breakdown
				expect(result.score.finalScore).toBe(85);
				expect(result.score.contributions).toHaveLength(2);

				// Findings with sanitized text (proves script tag is stripped)
				expect(result.findings).toHaveLength(2);
				expect(result.findings[0]?.explanation).toBe(
					"Reported SPF result is fail ",
				);
				expect(result.findings[0]?.explanation).not.toContain("<script>");

				// Observations present
				expect(result.headers).toHaveLength(1);
				expect(result.addresses).toHaveLength(1);
				expect(result.authentication).toHaveLength(1);
				expect(result.mimeParts).toHaveLength(1);
				expect(result.linkMismatches).toHaveLength(1);

				// Assert NO objectKey is leaked in top level result or observations
				expect((result as Record<string, unknown>).objectKey).toBeUndefined();
				expect(
					(result.summary as Record<string, unknown>).objectKey,
				).toBeUndefined();
			}
		});
	});

	describe("analysis.list (filters, stable ordering, cursor pagination)", () => {
		it("filters analysis runs by status (backed by indexed column)", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });

			const completedRuns = await client.analysis.list({
				status: "completed",
			});
			expect(completedRuns.items).toHaveLength(1);
			expect(completedRuns.items[0]?.id).toBe("run_comp_01");

			const failedRuns = await client.analysis.list({
				status: "failed",
			});
			expect(failedRuns.items).toHaveLength(1);
			expect(failedRuns.items[0]?.id).toBe("run_failed_01");
		});

		it("filters analysis runs by verdict (backed by indexed column)", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });

			const maliciousRuns = await client.analysis.list({
				verdict: "malicious",
			});
			expect(maliciousRuns.items).toHaveLength(1);
			expect(maliciousRuns.items[0]?.id).toBe("run_comp_01");
		});

		it("filters analysis runs by caseId and evidenceId", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });

			const runsForEvidence = await client.analysis.list({
				caseId: "case_01",
				evidenceId: "ev_01",
			});
			expect(runsForEvidence.items).toHaveLength(4);
		});

		it("supports stable ordering and cursor pagination", async () => {
			const { context } = createTestContext();
			const client = createRouterClient(router, { context });

			// Page 1: limit 2
			// Items sorted createdAt desc:
			// run_comp_01 (10:20), run_failed_01 (10:10), run_proc_01 (10:05), run_queued_01 (10:00)
			const page1 = await client.analysis.list({ limit: 2 });
			expect(page1.items).toHaveLength(2);
			expect(page1.items[0]?.id).toBe("run_comp_01");
			expect(page1.items[1]?.id).toBe("run_failed_01");
			expect(page1.nextCursor).toBeDefined();
			expect(page1.nextCursor).not.toBeNull();

			// Page 2: using nextCursor
			const nextCursor = page1.nextCursor;
			expect(nextCursor).not.toBeNull();
			if (!nextCursor) throw new Error("Expected analysis next cursor");
			const page2 = await client.analysis.list({
				limit: 2,
				cursor: nextCursor,
			});
			expect(page2.items).toHaveLength(2);
			expect(page2.items[0]?.id).toBe("run_proc_01");
			expect(page2.items[1]?.id).toBe("run_queued_01");
			expect(page2.nextCursor).toBeNull();
		});
	});
});
