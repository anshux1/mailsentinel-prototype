import { createHash } from "node:crypto";
import {
	type AuditRecordShell,
	createMemoryRepositories,
} from "@mailsentinel/db";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MemoryAnalyzerClient } from "@/server/analyzer-client";
import type { MembershipRole } from "@/server/auth/permissions";
import { MemoryReportStorage } from "@/server/storage/reports";
import { MemoryEvidenceStorage } from "@/server/storage/s3";
import type { RpcContext } from "./context";
import { router } from "./router";

const TENANT = "org_e2e";
const INTRUDER = "org_intruder";
const GENERATED_AT = new Date("2026-09-05T12:00:00.000Z");

const RAW_EML = Buffer.from(
	[
		'From: "Finance Team" <billing@acme-invoices.test>',
		"To: victim@tenant.test",
		"Subject: Overdue invoice - immediate payment required",
		"Message-ID: <inv-9931@acme-invoices.test>",
		"Date: Fri, 04 Sep 2026 09:14:00 +0000",
		"",
		"Confirm your credentials at https://acme-invoices.test/pay to avoid suspension.",
	].join("\r\n"),
	"utf8",
);
const RAW_SHA256 = createHash("sha256").update(RAW_EML).digest("hex");

/** Deterministic completed-analysis snapshot, as the analyzer would persist it. */
function resultSnapshot(analysisRunId: string, caseId: string) {
	return {
		analysisRunId,
		organizationId: TENANT,
		caseId,
		analysisVersion: "1.1.0",
		rulesetVersion: "1.1.0",
		schemaVersion: "1.0.0",
		analyzedAt: "2026-09-05T11:59:00.000Z",
		artifactSha256: RAW_SHA256,
		artifactByteSize: RAW_EML.byteLength,
		artifactDigestAlgorithm: "sha256",
		verdict: "suspicious",
		confidence: 0.82,
		score: {
			baseScore: 10,
			finalScore: 64,
			contributions: [
				{
					ruleId: "content.credential_harvesting",
					category: "content",
					severity: "high",
					scoreContribution: 40,
					explanation:
						"Message requests credential confirmation through an external link.",
					evidenceRefs: ["content:body:1"],
					source: "ruleset",
				},
				{
					ruleId: "headers.display_name_mismatch",
					category: "headers",
					severity: "medium",
					scoreContribution: 14,
					explanation:
						"Display name claims a finance identity while the sending domain differs.",
					evidenceRefs: ["header:from"],
					source: "ruleset",
				},
			],
		},
		findings: [
			{
				ruleId: "content.credential_harvesting",
				category: "content",
				severity: "high",
				scoreContribution: 40,
				explanation:
					"Message requests credential confirmation through an external link.",
				evidenceRefs: ["content:body:1"],
				source: "ruleset",
			},
			{
				ruleId: "headers.display_name_mismatch",
				category: "headers",
				severity: "medium",
				scoreContribution: 14,
				explanation:
					"Display name claims a finance identity while the sending domain differs.",
				evidenceRefs: ["header:from"],
				source: "ruleset",
			},
		],
		indicators: [
			{
				kind: "domain",
				value: "acme-invoices.test",
				normalizedValue: "acme-invoices.test",
				source: "body",
				privateOrReserved: false,
			},
		],
		enrichment: [
			{
				indicator: "acme-invoices.test",
				provider: "offline",
				mode: "offline",
				reputation: "risky",
				score: 70,
				timestamp: null,
			},
		],
	};
}

function createHarness() {
	const repos = createMemoryRepositories();
	const evidenceStorage = new MemoryEvidenceStorage();
	const reportStorage = new MemoryReportStorage();
	const analyzerClient = new MemoryAnalyzerClient();

	const contextFor = (
		organizationId: string,
		role: MembershipRole = "investigator",
		requestId = "req_e2e_01",
	): RpcContext => ({
		requestId,
		userId: `user_${role}`,
		organizationId,
		role,
		repos,
		storage: evidenceStorage,
		reportStorage,
		analyzerClient,
		now: () => GENERATED_AT,
	});

	const clientFor = (
		organizationId: string,
		role: MembershipRole = "investigator",
		requestId?: string,
	) =>
		createRouterClient(router, {
			context: contextFor(organizationId, role, requestId),
		});

	return { repos, evidenceStorage, reportStorage, analyzerClient, clientFor };
}

type Harness = ReturnType<typeof createHarness>;

/** Case -> verified evidence -> queued analysis run, driven only through oRPC. */
async function runIntakePipeline(harness: Harness) {
	const client = harness.clientFor(TENANT);

	const caseRecord = await client.case.create({ title: "Overdue invoice" });
	const pending = await client.evidence.createUpload({
		caseId: caseRecord.id,
		filename: "overdue-invoice.eml",
		contentType: "message/rfc822",
		byteSize: RAW_EML.byteLength,
		sha256: RAW_SHA256,
		idempotencyKey: "upload_e2e_01",
	});
	const evidence = await client.evidence.completeUpload({
		caseId: caseRecord.id,
		evidenceId: pending.id,
		body: RAW_EML.toString("base64"),
		sha256: RAW_SHA256,
	});
	const run = await client.analysis.start({
		caseId: caseRecord.id,
		evidenceId: evidence.id,
	});

	return { client, caseRecord, pending, evidence, run };
}

/** Persist the analyzer's completed result the way the worker would. */
async function completeRun(
	harness: Harness,
	params: { analysisRunId: string; caseId: string },
) {
	await harness.repos.analysisRuns.transitionStatus({
		organizationId: TENANT,
		analysisRunId: params.analysisRunId,
		fromStatus: "queued",
		toStatus: "processing",
		phase: "scoring",
		progress: 90,
	});
	const snapshot = resultSnapshot(params.analysisRunId, params.caseId);
	await harness.repos.analysisRuns.saveResult({
		organizationId: TENANT,
		analysisRunId: params.analysisRunId,
		verdict: "suspicious",
		score: snapshot.score.finalScore,
		confidence: snapshot.confidence,
		analysisVersion: snapshot.analysisVersion,
		rulesetVersion: snapshot.rulesetVersion,
		resultSchemaVersion: snapshot.schemaVersion,
		resultSnapshot: snapshot,
	});
	return snapshot;
}

async function auditActions(harness: Harness): Promise<string[]> {
	const records: AuditRecordShell[] =
		await harness.repos.audit.listAuditRecords({
			organizationId: TENANT,
			limit: 100,
		});
	return records.map((record) => record.action);
}

describe("Phase S8 application-server integration", () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
	});

	it("carries a case through evidence, analysis, result, and report", async () => {
		const { client, caseRecord, evidence, run } =
			await runIntakePipeline(harness);

		expect(caseRecord.organizationId).toBe(TENANT);
		expect(evidence.status).toBe("verified");
		expect(evidence.sha256).toBe(RAW_SHA256);
		expect(evidence.byteSize).toBe(RAW_EML.byteLength);
		expect(run.status).toBe("queued");

		await completeRun(harness, {
			analysisRunId: run.id,
			caseId: caseRecord.id,
		});

		const status = await client.analysis.getStatus({ analysisRunId: run.id });
		expect(status.status).toBe("completed");

		const report = await client.report.generate({
			analysisRunId: run.id,
			format: "json",
		});
		expect(report.status).toBe("completed");
		expect(report.version).toBe(1);
		expect(report.content).toContain('"verdict":"suspicious"');
	});

	it("stores evidence privately and never returns the private object key", async () => {
		const { evidence, caseRecord } = await runIntakePipeline(harness);

		const persisted = await harness.repos.evidence.getEvidence({
			organizationId: TENANT,
			caseId: caseRecord.id,
			evidenceId: evidence.id,
		});
		const objectKey = persisted?.objectKey ?? "";
		expect(objectKey).toMatch(
			new RegExp(`^organizations/${TENANT}/cases/${caseRecord.id}/`),
		);

		const head = await harness.evidenceStorage.headEvidence({
			objectKey,
			organizationId: TENANT,
			caseId: caseRecord.id,
		});
		expect(head).toMatchObject({
			byteSize: RAW_EML.byteLength,
			sha256: RAW_SHA256,
		});

		expect(Object.keys(evidence)).not.toContain("objectKey");
		expect(Object.keys(evidence)).not.toContain("idempotencyKey");
		expect(JSON.stringify(evidence)).not.toContain(objectKey);
	});

	it("creates the analysis run idempotently and dispatches intake once", async () => {
		const { client, caseRecord, evidence, run } =
			await runIntakePipeline(harness);

		const repeated = await client.analysis.start({
			caseId: caseRecord.id,
			evidenceId: evidence.id,
		});
		const keyed = await client.analysis.start({
			caseId: caseRecord.id,
			evidenceId: evidence.id,
			idempotencyKey: "start_e2e_01",
		});

		expect(repeated.id).toBe(run.id);
		expect(keyed.id).toBe(run.id);
		expect(harness.analyzerClient.dispatched).toHaveLength(1);

		const runs = await client.analysis.list({ caseId: caseRecord.id });
		expect(runs.items).toHaveLength(1);
	});

	it("dispatches authoritative persisted metadata to the private analyzer", async () => {
		const { caseRecord, evidence, run } = await runIntakePipeline(harness);

		const dispatch = harness.analyzerClient.dispatched[0];
		expect(dispatch?.requestId).toBe("req_e2e_01");
		const persisted = await harness.repos.evidence.getEvidence({
			organizationId: TENANT,
			caseId: caseRecord.id,
			evidenceId: evidence.id,
		});
		expect(dispatch?.request).toMatchObject({
			organizationId: TENANT,
			caseId: caseRecord.id,
			analysisRunId: run.id,
			artifact: {
				objectKey: persisted?.objectKey,
				sha256: RAW_SHA256,
				byteSize: RAW_EML.byteLength,
				digestAlgorithm: "sha256",
			},
		});
		expect(typeof dispatch?.request.requestedAt).toBe("string");

		// Intake carries persisted scope only: no browser filename, no raw evidence.
		const serialized = JSON.stringify(dispatch?.request);
		expect(serialized).not.toContain("overdue-invoice.eml");
		expect(serialized).not.toContain(RAW_EML.toString("utf8"));
	});

	it("keeps status and result reads scoped to the owning tenant", async () => {
		const { caseRecord, evidence, run } = await runIntakePipeline(harness);
		await completeRun(harness, {
			analysisRunId: run.id,
			caseId: caseRecord.id,
		});

		const intruder = harness.clientFor(INTRUDER, "owner", "req_intruder_01");
		await expect(
			intruder.analysis.getStatus({ analysisRunId: run.id }),
		).rejects.toThrow();
		await expect(
			intruder.analysis.getResult({ analysisRunId: run.id }),
		).rejects.toThrow();
		await expect(
			intruder.evidence.get({ caseId: caseRecord.id, evidenceId: evidence.id }),
		).rejects.toThrow();
		await expect(
			intruder.report.generate({ analysisRunId: run.id, format: "json" }),
		).rejects.toThrow();

		expect(await intruder.case.get({ caseId: caseRecord.id })).toBeNull();
		expect((await intruder.analysis.list({})).items).toEqual([]);
		expect((await intruder.report.list({})).items).toEqual([]);
	});

	it("returns completed results with explanations and version metadata", async () => {
		const { client, caseRecord, run } = await runIntakePipeline(harness);
		const snapshot = await completeRun(harness, {
			analysisRunId: run.id,
			caseId: caseRecord.id,
		});

		const result = await client.analysis.getResult({ analysisRunId: run.id });
		if (!result.ready) throw new Error("Expected a completed analysis result");

		expect(result).toMatchObject({
			verdict: "suspicious",
			analysisVersion: snapshot.analysisVersion,
			rulesetVersion: snapshot.rulesetVersion,
			schemaVersion: snapshot.schemaVersion,
		});
		expect(result.score.finalScore).toBe(64);
		expect(result.findings).toHaveLength(2);
		for (const finding of result.findings) {
			expect(finding.explanation.length).toBeGreaterThan(0);
			expect(finding.evidenceRefs.length).toBeGreaterThan(0);
			expect(finding.ruleId.length).toBeGreaterThan(0);
		}
	});

	it("generates deterministic, immutably versioned reports", async () => {
		const { client, caseRecord, run } = await runIntakePipeline(harness);
		await completeRun(harness, {
			analysisRunId: run.id,
			caseId: caseRecord.id,
		});

		const first = await client.report.generate({
			analysisRunId: run.id,
			format: "json",
		});
		const second = await client.report.generate({
			analysisRunId: run.id,
			format: "json",
		});

		expect(first.version).toBe(1);
		expect(second.version).toBe(2);
		expect(second.content).toBe(first.content);
		expect(harness.reportStorage.objects.size).toBe(2);

		const fetched = await client.report.get({ reportId: first.id });
		expect(fetched.content).toBe(first.content);
		expect(fetched.version).toBe(1);

		// Versions are allocated per (analysis run, format), so HTML starts at 1.
		const html = await client.report.generate({
			analysisRunId: run.id,
			format: "html",
		});
		expect(html.version).toBe(1);
		expect(html.content).not.toContain("<script>");
		expect(html.content).toContain("MailSentinel Forensic Report");
		expect(html.content).not.toContain(RAW_EML.toString("utf8"));

		const listed = await client.report.list({ caseId: caseRecord.id });
		expect(
			listed.items.map((item) => `${item.format}:${item.version}`).sort(),
		).toEqual(["html:1", "json:1", "json:2"]);
	});

	it("audits every tenant-owned workflow transition", async () => {
		const { client, caseRecord, run } = await runIntakePipeline(harness);
		await completeRun(harness, {
			analysisRunId: run.id,
			caseId: caseRecord.id,
		});
		const report = await client.report.generate({
			analysisRunId: run.id,
			format: "json",
		});
		await client.report.get({ reportId: report.id });

		expect(await auditActions(harness)).toEqual(
			expect.arrayContaining([
				"case.create",
				"evidence.upload_init",
				"evidence.upload_complete",
				"analysis.start",
				"analysis.intake_dispatched",
				"report.requested",
				"report.generate",
				"report.download",
			]),
		);

		const records = await harness.repos.audit.listAuditRecords({
			organizationId: TENANT,
			limit: 100,
		});
		const serialized = JSON.stringify(records);
		expect(serialized).not.toContain(RAW_EML.toString("utf8"));
		expect(serialized).not.toContain("overdue-invoice.eml");
		expect(serialized).not.toContain("organizations/org_e2e/cases");
		for (const record of records) {
			expect(record.organizationId).toBe(TENANT);
			expect(record.metadata).toHaveProperty("requestId");
		}
	});

	it("keeps analyzer and storage credentials out of every browser payload", async () => {
		const { client, caseRecord, pending, evidence, run } =
			await runIntakePipeline(harness);
		await completeRun(harness, {
			analysisRunId: run.id,
			caseId: caseRecord.id,
		});

		const payload = JSON.stringify({
			caseRecord,
			pending,
			evidence,
			run,
			cases: await client.case.list({}),
			evidenceList: await client.evidence.list({ caseId: caseRecord.id }),
			runs: await client.analysis.list({ caseId: caseRecord.id }),
			status: await client.analysis.getStatus({ analysisRunId: run.id }),
			result: await client.analysis.getResult({ analysisRunId: run.id }),
			report: await client.report.generate({
				analysisRunId: run.id,
				format: "json",
			}),
			reports: await client.report.list({}),
		});

		for (const forbidden of [
			"objectKey",
			"idempotencyKey",
			"ANALYZER_SERVICE_TOKEN",
			"ANALYZER_INTERNAL_URL",
			"S3_ACCESS_KEY_ID",
			"S3_SECRET_ACCESS_KEY",
			"Authorization",
			"Bearer ",
			"organizations/org_e2e/cases",
			RAW_EML.toString("utf8"),
		]) {
			expect(payload).not.toContain(forbidden);
		}
	});
});
