import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AnalysisResult as ContractAnalysisResult } from "@mailsentinel/contracts";
import {
	type AnalysisRunShell,
	MemoryAnalysisRunRepository,
} from "@mailsentinel/db";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	analysisResultCompletedSchema,
	analysisResultOutputSchema,
	formatCompletedAnalysisResult,
} from "./analysis-schemas";
import type { RpcContext } from "./context";
import { router } from "./router";

describe("Phase S6: Analyzer Result Serialization Compatibility", () => {
	const fixturePath = resolve(
		process.cwd(),
		"../../packages/fixtures/contracts/analyzer.valid.json",
	);
	const fixtureContent = JSON.parse(readFileSync(fixturePath, "utf-8"));
	const validAnalysisResultFixture = fixtureContent.AnalysisResult;

	it("validates the official analyzer.valid.json AnalysisResult fixture cleanly against analysisResultCompletedSchema", () => {
		// Embed ready: true and status: completed as required by the discriminated union
		const toValidate = {
			ready: true,
			status: "completed",
			...validAnalysisResultFixture,
			summary: {
				verdict: validAnalysisResultFixture.verdict,
				finalScore: validAnalysisResultFixture.score.finalScore,
				confidence: validAnalysisResultFixture.confidence,
				findingsCount: validAnalysisResultFixture.findings?.length ?? 0,
				criticalCount: 0,
				highCount: 1,
				mediumCount: 0,
				lowCount: 0,
				infoCount: 0,
			},
		};

		const parsed = analysisResultCompletedSchema.parse(toValidate);
		expect(parsed.ready).toBe(true);
		expect(parsed.status).toBe("completed");
		expect(parsed.verdict).toBe("suspicious");
		expect(parsed.confidence).toBe(0.85);
		expect(parsed.score.finalScore).toBe(40);
		expect(parsed.findings).toHaveLength(1);
		expect(parsed.findings[0]?.ruleId).toBe("auth.spf.fail");

		// Static type assertion ensuring compatibility with @mailsentinel/contracts
		const contractsTypeCheck: Partial<ContractAnalysisResult> = parsed;
		expect(contractsTypeCheck.verdict).toBe("suspicious");
	});

	it("preserves serialization round-trip fidelity through JSON.stringify and JSON.parse", () => {
		const toValidate = {
			ready: true,
			status: "completed",
			...validAnalysisResultFixture,
			summary: {
				verdict: validAnalysisResultFixture.verdict,
				finalScore: validAnalysisResultFixture.score.finalScore,
				confidence: validAnalysisResultFixture.confidence,
				findingsCount: validAnalysisResultFixture.findings?.length ?? 0,
				criticalCount: 0,
				highCount: 1,
				mediumCount: 0,
				lowCount: 0,
				infoCount: 0,
			},
		};

		const parsed = analysisResultCompletedSchema.parse(toValidate);
		const serialized = JSON.stringify(parsed);
		const deserialized = JSON.parse(serialized);
		const roundTripped = analysisResultCompletedSchema.parse(deserialized);

		expect(roundTripped).toEqual(parsed);
	});

	it("enforces null vs empty-collection conventions: collections must not be null", () => {
		const invalidWithNullCollection = {
			ready: true,
			status: "completed",
			...validAnalysisResultFixture,
			summary: {
				verdict: "suspicious",
				finalScore: 40,
				confidence: 0.85,
				findingsCount: 0,
				criticalCount: 0,
				highCount: 0,
				mediumCount: 0,
				lowCount: 0,
				infoCount: 0,
			},
			findings: null, // Contract violation: collections must be empty arrays, never null
		};

		expect(() =>
			analysisResultCompletedSchema.parse(invalidWithNullCollection),
		).toThrow();
	});

	it("formatCompletedAnalysisResult correctly handles the fixture snapshot and produces valid output schema", () => {
		const mockRun: AnalysisRunShell = {
			id: validAnalysisResultFixture.analysisRunId,
			organizationId: validAnalysisResultFixture.organizationId,
			caseId: validAnalysisResultFixture.caseId,
			evidenceId: "ev_01",
			status: "completed",
			verdict: validAnalysisResultFixture.verdict,
			score: validAnalysisResultFixture.score.finalScore,
			confidence: validAnalysisResultFixture.confidence,
			analysisVersion: validAnalysisResultFixture.analysisVersion,
			rulesetVersion: validAnalysisResultFixture.rulesetVersion,
			resultSchemaVersion: validAnalysisResultFixture.schemaVersion,
			resultSnapshot: validAnalysisResultFixture,
			failureCode: null,
			failureMessage: null,
			retryable: false,
			attempts: 1,
			phase: "completed",
			progress: 100,
			idempotencyKey: "idem_fixture",
			queuedAt: new Date("2026-01-01T00:00:00Z"),
			startedAt: new Date("2026-01-01T00:00:01Z"),
			completedAt: new Date("2026-01-01T00:00:05Z"),
			failedAt: null,
			createdAt: new Date("2026-01-01T00:00:00Z"),
			updatedAt: new Date("2026-01-01T00:00:05Z"),
		};

		const formatted = formatCompletedAnalysisResult(
			mockRun,
			validAnalysisResultFixture,
		);

		// Must parse against discriminated union schema
		const validated = analysisResultOutputSchema.parse(formatted);
		expect(validated.ready).toBe(true);
		if (validated.ready) {
			expect(validated.status).toBe("completed");
			expect(validated.verdict).toBe("suspicious");
			expect(validated.score.finalScore).toBe(40);
			expect(validated.summary.findingsCount).toBe(1);
			expect(validated.summary.highCount).toBe(1);
			expect(validated.summary.criticalCount).toBe(0);
			expect(validated.findings[0]?.ruleId).toBe("auth.spf.fail");
		}
	});

	it("serves the official fixture snapshot via analysis.getResult router procedure", async () => {
		const mockRun: AnalysisRunShell = {
			id: validAnalysisResultFixture.analysisRunId,
			organizationId: validAnalysisResultFixture.organizationId,
			caseId: validAnalysisResultFixture.caseId,
			evidenceId: "ev_01",
			status: "completed",
			verdict: validAnalysisResultFixture.verdict,
			score: validAnalysisResultFixture.score.finalScore,
			confidence: validAnalysisResultFixture.confidence,
			analysisVersion: validAnalysisResultFixture.analysisVersion,
			rulesetVersion: validAnalysisResultFixture.rulesetVersion,
			resultSchemaVersion: validAnalysisResultFixture.schemaVersion,
			resultSnapshot: validAnalysisResultFixture,
			failureCode: null,
			failureMessage: null,
			retryable: false,
			attempts: 1,
			phase: "completed",
			progress: 100,
			idempotencyKey: "idem_fixture_2",
			queuedAt: new Date("2026-01-01T00:00:00Z"),
			startedAt: new Date("2026-01-01T00:00:01Z"),
			completedAt: new Date("2026-01-01T00:00:05Z"),
			failedAt: null,
			createdAt: new Date("2026-01-01T00:00:00Z"),
			updatedAt: new Date("2026-01-01T00:00:05Z"),
		};

		const analysisRepo = new MemoryAnalysisRunRepository([mockRun]);
		const context: RpcContext = {
			requestId: "req_fixture_test",
			userId: "user_viewer",
			organizationId: validAnalysisResultFixture.organizationId,
			role: "viewer",
			repos: {
				analysisRuns: analysisRepo,
			},
		};
		const client = createRouterClient(router, { context });

		const result = await client.analysis.getResult({
			analysisRunId: validAnalysisResultFixture.analysisRunId,
		});

		expect(result.ready).toBe(true);
		if (result.ready) {
			expect(result.status).toBe("completed");
			expect(result.verdict).toBe("suspicious");
			expect(result.score.finalScore).toBe(40);
			expect(result.findings).toHaveLength(1);
			expect(result.summary.findingsCount).toBe(1);
			expect(result.summary.highCount).toBe(1);
		}
	});
});
