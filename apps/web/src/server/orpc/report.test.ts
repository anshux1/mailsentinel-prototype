import {
	type AnalysisRunShell,
	createMemoryRepositories,
} from "@mailsentinel/db";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemoryReportStorage } from "@/server/storage/reports";
import type { RpcContext } from "./context";
import { router } from "./router";

const now = new Date("2026-09-04T12:00:00.000Z");

function completedRun(
	overrides: Partial<AnalysisRunShell> = {},
): AnalysisRunShell {
	const snapshot = {
		analysisRunId: "run_01",
		organizationId: "org_01",
		caseId: "case_01",
		analysisVersion: "1.1.0",
		rulesetVersion: "1.1.0",
		schemaVersion: "1.0.0",
		analyzedAt: "2026-09-04T11:00:00.000Z",
		artifactSha256: "a".repeat(64),
		artifactByteSize: 128,
		artifactDigestAlgorithm: "sha256",
		verdict: "suspicious",
		confidence: 0.8,
		score: {
			baseScore: 10,
			finalScore: 55,
			contributions: [
				{
					ruleId: "rule_x",
					category: "content",
					severity: "high",
					scoreContribution: 45,
					explanation: "Unsafe <script>alert('x')</script> prompt",
					evidenceRefs: ["content:1"],
					source: "ruleset",
				},
			],
		},
		findings: [
			{
				ruleId: "rule_x",
				category: "content",
				severity: "high",
				scoreContribution: 45,
				explanation: "Unsafe <script>alert('x')</script> prompt",
				evidenceRefs: ["content:1"],
				source: "ruleset",
			},
		],
		indicators: [
			{
				kind: "domain",
				value: "bad.example",
				normalizedValue: "bad.example",
				source: "body",
				privateOrReserved: null,
			},
		],
		enrichment: [
			{
				indicator: "bad.example",
				provider: "offline",
				mode: "offline",
				reputation: "risky",
				score: 70,
				timestamp: null,
			},
		],
	};
	return {
		id: "run_01",
		organizationId: "org_01",
		caseId: "case_01",
		evidenceId: "ev_01",
		status: "completed",
		verdict: "suspicious",
		score: 55,
		confidence: 0.8,
		analysisVersion: "1.1.0",
		rulesetVersion: "1.1.0",
		resultSchemaVersion: "1.0.0",
		resultSnapshot: snapshot,
		failureCode: null,
		failureMessage: null,
		retryable: false,
		attempts: 0,
		queuedAt: now,
		startedAt: now,
		completedAt: now,
		failedAt: null,
		idempotencyKey: "idem_01",
		phase: "completed",
		progress: 100,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function setup(
	role: "owner" | "investigator" | "viewer" = "investigator",
	run = completedRun(),
) {
	const repos = createMemoryRepositories({
		cases: [
			{
				id: "case_01",
				organizationId: "org_01",
				title: "Case",
				createdAt: now,
				updatedAt: now,
			},
		],
		analysisRuns: [run],
	});
	const reportStorage = new MemoryReportStorage();
	const context: RpcContext = {
		requestId: "req_report",
		userId: "user_01",
		organizationId: "org_01",
		role,
		repos,
		reportStorage,
		now: () => now,
	};
	return {
		client: createRouterClient(router, { context }),
		repos,
		reportStorage,
	};
}

describe("Phase S7 report backend", () => {
	it("generates, stores, lists, and retrieves deterministic JSON", async () => {
		const { client, reportStorage } = setup();
		const generated = await client.report.generate({
			analysisRunId: "run_01",
			format: "json",
		});
		expect(generated.status).toBe("completed");
		expect(generated.version).toBe(1);
		expect(generated.contentType).toBe("application/json");
		expect(generated.content).toContain('"reportVersion":"1.0.0"');
		expect(JSON.stringify(generated)).not.toContain("objectKey");
		expect(reportStorage.objects.size).toBe(1);

		const list = await client.report.list({ analysisRunId: "run_01" });
		expect(list.items).toHaveLength(1);
		const fetched = await client.report.get({ reportId: generated.id });
		expect(fetched.content).toBe(generated.content);
	});

	it("renders printable HTML without active script or raw markup injection", async () => {
		const { client } = setup();
		const generated = await client.report.generate({
			analysisRunId: "run_01",
			format: "html",
		});
		expect(generated.content).toContain("<!doctype html>");
		expect(generated.content).not.toMatch(/<script/i);
		expect(generated.content).not.toContain("alert('x')");
	});

	it("creates immutable incrementing versions on regeneration", async () => {
		const { client } = setup();
		const first = await client.report.generate({
			analysisRunId: "run_01",
			format: "text",
		});
		const second = await client.report.generate({
			analysisRunId: "run_01",
			format: "text",
		});
		expect([first.version, second.version]).toEqual([1, 2]);
		expect(first.id).not.toBe(second.id);
	});

	it("requires a completed analysis", async () => {
		const { client } = setup(
			"investigator",
			completedRun({ status: "processing", resultSnapshot: null }),
		);
		await expect(
			client.report.generate({ analysisRunId: "run_01" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("rejects viewer generation and cross-tenant probing", async () => {
		const viewer = setup("viewer").client;
		await expect(
			viewer.report.generate({ analysisRunId: "run_01" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			viewer.report.get({ reportId: "report_other" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("records safe generation audits", async () => {
		const { client, repos } = setup();
		await client.report.generate({ analysisRunId: "run_01", format: "json" });
		const audits = await repos.audit.listAuditRecords({
			organizationId: "org_01",
		});
		expect(audits.map((event) => event.action)).toEqual(
			expect.arrayContaining(["report.requested", "report.generate"]),
		);
		expect(JSON.stringify(audits)).not.toContain("objectKey");
		expect(JSON.stringify(audits)).not.toContain("<script");
	});

	it("marks generation failed when private storage is unavailable", async () => {
		const { client, repos, reportStorage } = setup();
		reportStorage.failPut = true;
		await expect(
			client.report.generate({ analysisRunId: "run_01" }),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		const reports = await repos.reports.listReports({
			organizationId: "org_01",
		});
		expect(reports[0]?.status).toBe("failed");
		expect(reports[0]?.failureReason).toBe("Report storage write failed");
	});
});
