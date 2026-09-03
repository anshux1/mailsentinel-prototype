import "server-only";

import { canonicalJsonStringify } from "@mailsentinel/db";
import type { AnalysisResultCompleted } from "@/server/orpc/analysis-schemas";
import type { GeneratedReportFormat } from "@/server/storage/reports";

export const REPORT_VERSION = "1.0.0";

export interface ReportDocument {
	reportVersion: string;
	generatedAt: string;
	caseId: string;
	analysisRunId: string;
	analysisVersion: string;
	rulesetVersion: string;
	resultSchemaVersion: string;
	verdict: AnalysisResultCompleted["verdict"];
	score: number;
	confidence: number;
	executiveSummary: string;
	findings: Array<{
		ruleId: string;
		category: string;
		severity: string;
		scoreContribution: number;
		explanation: string;
		evidenceRefs: string[];
		source: string;
	}>;
	limitations: string[];
	enrichmentCoverage: {
		indicatorCount: number;
		enrichedIndicatorCount: number;
		providers: string[];
	};
}

export function buildReportDocument(
	result: AnalysisResultCompleted,
	generatedAt: Date,
): ReportDocument {
	const providers = [
		...new Set(result.enrichment.map((item) => item.provider)),
	].sort();
	const limitations = [
		"Authentication outcomes may be reported by message headers and are not independently verified unless explicitly stated.",
		"External enrichment may be incomplete or unavailable and does not independently determine the verdict.",
		"Attachments were inspected as bounded metadata only and were not executed.",
	];
	return {
		reportVersion: REPORT_VERSION,
		generatedAt: generatedAt.toISOString(),
		caseId: result.caseId,
		analysisRunId: result.analysisRunId,
		analysisVersion: result.analysisVersion,
		rulesetVersion: result.rulesetVersion,
		resultSchemaVersion: result.schemaVersion,
		verdict: result.verdict,
		score: result.score.finalScore,
		confidence: result.confidence,
		executiveSummary: `MailSentinel classified this evidence as ${result.verdict} with a risk score of ${result.score.finalScore}/100 and confidence ${result.confidence.toFixed(2)}. ${result.findings.length} explainable finding(s) contributed to the result.`,
		findings: result.findings.map((finding) => ({
			ruleId: finding.ruleId,
			category: finding.category,
			severity: finding.severity,
			scoreContribution: finding.scoreContribution,
			explanation: finding.explanation,
			evidenceRefs: [...finding.evidenceRefs],
			source: finding.source,
		})),
		limitations,
		enrichmentCoverage: {
			indicatorCount: result.indicators.length,
			enrichedIndicatorCount: result.enrichment.length,
			providers,
		},
	};
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function renderReport(
	document: ReportDocument,
	format: GeneratedReportFormat,
): {
	content: string;
	contentType: string;
} {
	if (format === "json") {
		return {
			content: canonicalJsonStringify(document),
			contentType: "application/json",
		};
	}
	if (format === "text") {
		const findings = document.findings
			.map(
				(finding) =>
					`[${finding.severity.toUpperCase()}] ${finding.ruleId}: ${finding.explanation} (${finding.scoreContribution >= 0 ? "+" : ""}${finding.scoreContribution})`,
			)
			.join("\n");
		return {
			content: [
				"MailSentinel Forensic Report",
				`Generated: ${document.generatedAt}`,
				`Case: ${document.caseId}`,
				`Analysis: ${document.analysisRunId}`,
				`Verdict: ${document.verdict}`,
				`Score: ${document.score}/100`,
				`Confidence: ${document.confidence}`,
				"",
				document.executiveSummary,
				"",
				"Findings",
				findings || "No findings.",
				"",
				"Limitations",
				...document.limitations.map((item) => `- ${item}`),
			].join("\n"),
			contentType: "text/plain; charset=utf-8",
		};
	}
	const findingRows = document.findings
		.map(
			(finding) =>
				`<tr><td>${escapeHtml(finding.severity)}</td><td>${escapeHtml(finding.ruleId)}</td><td>${escapeHtml(finding.explanation)}</td><td>${finding.scoreContribution}</td></tr>`,
		)
		.join("");
	return {
		content: `<!doctype html><html><head><meta charset="utf-8"><title>MailSentinel report</title></head><body><main><h1>MailSentinel Forensic Report</h1><p>${escapeHtml(document.executiveSummary)}</p><dl><dt>Case</dt><dd>${escapeHtml(document.caseId)}</dd><dt>Analysis</dt><dd>${escapeHtml(document.analysisRunId)}</dd><dt>Verdict</dt><dd>${escapeHtml(document.verdict)}</dd><dt>Score</dt><dd>${document.score}/100</dd><dt>Confidence</dt><dd>${document.confidence}</dd></dl><h2>Findings</h2><table><thead><tr><th>Severity</th><th>Rule</th><th>Explanation</th><th>Score</th></tr></thead><tbody>${findingRows}</tbody></table><h2>Limitations</h2><ul>${document.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></main></body></html>`,
		contentType: "text/html; charset=utf-8",
	};
}
