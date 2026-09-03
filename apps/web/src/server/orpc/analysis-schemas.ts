import "server-only";

import { z } from "zod";

export function sanitizeSafeText(str: string): string {
	return (
		str
			.replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: hostile evidence may contain control bytes
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;")
	);
}

function sanitizeStructuredValue<T>(value: T): T {
	if (typeof value === "string") return sanitizeSafeText(value) as T;
	if (Array.isArray(value))
		return value.map((item) => sanitizeStructuredValue(item)) as T;
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (key === "objectKey" || key === "raw") continue;
			result[key] = sanitizeStructuredValue(item);
		}
		return result as T;
	}
	return value;
}

export const verdictValueSchema = z.enum([
	"unknown",
	"benign",
	"suspicious",
	"malicious",
]);

export const severityValueSchema = z.enum([
	"info",
	"low",
	"medium",
	"high",
	"critical",
]);

export const findingCategorySchema = z.enum([
	"headers",
	"authentication",
	"routing",
	"url",
	"domain",
	"ip",
	"attachment",
	"content",
	"parser",
	"enrichment",
]);

export const digestAlgorithmSchema = z.enum(["sha256", "sha384", "sha512"]);

export const analysisPhaseSchema = z.enum([
	"queued",
	"fetching_evidence",
	"parsing",
	"extracting",
	"enriching",
	"scoring",
	"completed",
	"failed",
]);

export const analysisFailureCodeSchema = z.enum([
	"intake_invalid",
	"evidence_not_found",
	"evidence_too_large",
	"evidence_digest_mismatch",
	"evidence_size_mismatch",
	"evidence_storage_unavailable",
	"message_invalid",
	"header_limit_exceeded",
	"mime_limit_exceeded",
	"attachment_limit_exceeded",
	"analysis_run_not_found",
	"analysis_failed",
	"internal_error",
]);

export const findingSchema = z.object({
	ruleId: z.string(),
	category: findingCategorySchema,
	severity: severityValueSchema,
	scoreContribution: z.number(),
	explanation: z.string(),
	evidenceRefs: z.array(z.string()).default([]),
	source: z.string(),
});

export const scoreBreakdownSchema = z.object({
	baseScore: z.number(),
	contributions: z.array(findingSchema).default([]),
	finalScore: z.number(),
});

export const headerObservationSchema = z.object({
	name: z.string(),
	value: z.string(),
	occurrence: z.number().int(),
	malformed: z.boolean().default(false),
});

export const receivedHopSchema = z.object({
	position: z.number().int(),
	fromHost: z.string().nullable().default(null),
	byHost: z.string().nullable().default(null),
	sourceIp: z.string().nullable().default(null),
	timestamp: z.string().nullable().default(null),
	latencyJumpSeconds: z.number().nullable().default(null),
	privateSource: z.boolean().nullable().default(null),
	privateToPublic: z.boolean().nullable().default(null),
	parseWarning: z.string().nullable().default(null),
});

export const routingAnomalyObservationSchema = z.object({
	anomalyType: z.string(),
	hopPositions: z.array(z.number().int()).default([]),
	explanation: z.string(),
	details: z.string().nullable().default(null),
});

export const authenticationObservationSchema = z.object({
	method: z.string(),
	result: z.string(),
	declaringHost: z.string().nullable().default(null),
	reason: z.string().nullable().default(null),
	source: z.string().default("authentication-results"),
	independentlyVerified: z.boolean().default(false),
	selector: z.string().nullable().default(null),
	domain: z.string().nullable().default(null),
	signingDomain: z.string().nullable().default(null),
	identity: z.string().nullable().default(null),
	algorithm: z.string().nullable().default(null),
	signedHeaders: z.array(z.string()).default([]),
});

export const authConflictObservationSchema = z.object({
	method: z.string(),
	outcomes: z.array(z.string()).default([]),
	sources: z.array(z.string()).default([]),
	explanation: z.string(),
});

export const addressObservationSchema = z.object({
	address: z.string().nullable(),
	displayName: z.string().nullable(),
	domain: z.string().nullable(),
	source: z.string(),
	value: z.string(),
});

export const identityObservationSchema = z.object({
	source: z.string(),
	displayName: z.string(),
	address: z.string(),
	claimedIdentity: z.string(),
	inconsistencyType: z.string(),
	explanation: z.string(),
});

export const dateObservationSchema = z.object({
	rawValue: z.string().nullable().default(null),
	parsedDate: z.string().nullable().default(null),
	isValid: z.boolean().default(false),
	anomalies: z.array(z.string()).default([]),
	details: z.string().nullable().default(null),
});

export const messageIdObservationSchema = z.object({
	rawValue: z.string().nullable().default(null),
	messageId: z.string().nullable().default(null),
	domain: z.string().nullable().default(null),
	isValidSyntax: z.boolean().default(false),
	alignedWithSender: z.boolean().default(false),
	senderDomains: z.array(z.string()).default([]),
	anomalies: z.array(z.string()).default([]),
	details: z.string().nullable().default(null),
});

export const mimePartObservationSchema = z.object({
	partId: z.string(),
	contentType: z.string(),
	byteSize: z.number().int(),
	disposition: z.string().nullable().default(null),
	filename: z.string().nullable().default(null),
	isAttachment: z.boolean().default(false),
	sha256: z.string().nullable().default(null),
	digestAlgorithm: digestAlgorithmSchema.nullable().default(null),
	dangerousExtension: z.boolean().default(false),
	typeExtensionMismatch: z.boolean().default(false),
});

export const indicatorObservationSchema = z.object({
	kind: z.string(),
	value: z.string(),
	normalizedValue: z.string(),
	source: z.string(),
	privateOrReserved: z.boolean().nullable().default(null),
});

export const linkMismatchObservationSchema = z.object({
	displayText: z.string(),
	displayDomain: z.string(),
	actualHref: z.string(),
	actualDomain: z.string(),
	explanation: z.string(),
});

export const contentIndicatorObservationSchema = z.object({
	category: z.string(),
	matchedPhrase: z.string(),
	snippet: z.string(),
	source: z.string(),
});

export const enrichmentDetailsSchema = z.object({
	deterministic: z.boolean().nullable().default(null),
	category: z.string().nullable().default(null),
	dnsRecords: z.array(z.string()).default([]),
	asn: z.string().nullable().default(null),
	country: z.string().nullable().default(null),
	rawScore: z.number().nullable().default(null),
});

export const enrichmentObservationSchema = z.object({
	indicator: z.string(),
	provider: z.string(),
	mode: z.string(),
	reputation: z.string().nullable().default(null),
	score: z.number().nullable().default(null),
	timestamp: z.string().nullable().default(null),
	details: enrichmentDetailsSchema.optional(),
});

export const analysisFailureSchema = z.object({
	code: z.string(),
	message: z.string(),
	requestId: z.string().nullable().default(null),
	retryable: z.boolean().default(false),
});

export const analysisSummarySchema = z.object({
	verdict: verdictValueSchema,
	finalScore: z.number(),
	confidence: z.number(),
	findingsCount: z.number().int(),
	criticalCount: z.number().int(),
	highCount: z.number().int(),
	mediumCount: z.number().int(),
	lowCount: z.number().int(),
	infoCount: z.number().int(),
});

export const analysisStatusOutputSchema = z.object({
	id: z.string(),
	analysisRunId: z.string(),
	organizationId: z.string(),
	caseId: z.string(),
	status: z.enum([
		"accepted",
		"queued",
		"processing",
		"completed",
		"deferred",
		"failed",
	]),
	phase: z.string().nullable().optional(),
	progress: z.number().nullable().optional(),
	failureCode: z.string().nullable().optional(),
	failureMessage: z.string().nullable().optional(),
	retryable: z.boolean(),
	attempts: z.number().int(),
	queuedAt: z.union([z.date(), z.string()]).nullable().optional(),
	startedAt: z.union([z.date(), z.string()]).nullable().optional(),
	completedAt: z.union([z.date(), z.string()]).nullable().optional(),
	failedAt: z.union([z.date(), z.string()]).nullable().optional(),
	updatedAt: z.union([z.date(), z.string()]),
	createdAt: z.union([z.date(), z.string()]).optional(),
	failure: analysisFailureSchema.nullable().optional(),
});

export type AnalysisStatusOutput = z.infer<typeof analysisStatusOutputSchema>;

export const analysisResultNotReadySchema = z.object({
	ready: z.literal(false),
	status: z.enum(["accepted", "queued", "processing", "deferred", "failed"]),
	analysisRunId: z.string(),
	organizationId: z.string(),
	caseId: z.string(),
	phase: z.string().nullable().optional(),
	progress: z.number().nullable().optional(),
	failureCode: z.string().nullable().optional(),
	failureMessage: z.string().nullable().optional(),
	retryable: z.boolean().default(false),
	attempts: z.number().int().default(0),
	queuedAt: z.union([z.date(), z.string()]).nullable().optional(),
	startedAt: z.union([z.date(), z.string()]).nullable().optional(),
	failedAt: z.union([z.date(), z.string()]).nullable().optional(),
	updatedAt: z.union([z.date(), z.string()]).optional(),
	createdAt: z.union([z.date(), z.string()]).optional(),
});

export type AnalysisResultNotReady = z.infer<
	typeof analysisResultNotReadySchema
>;

export const analysisResultCompletedSchema = z.object({
	ready: z.literal(true),
	status: z.literal("completed"),
	analysisRunId: z.string(),
	organizationId: z.string(),
	caseId: z.string(),
	verdict: verdictValueSchema,
	score: scoreBreakdownSchema,
	confidence: z.number(),
	analysisVersion: z.string(),
	rulesetVersion: z.string(),
	schemaVersion: z.string(),
	completedAt: z.union([z.date(), z.string()]).nullable().optional(),
	summary: analysisSummarySchema,
	findings: z.array(findingSchema),
	headers: z.array(headerObservationSchema).default([]),
	addresses: z.array(addressObservationSchema).default([]),
	receivedHops: z.array(receivedHopSchema).default([]),
	authentication: z.array(authenticationObservationSchema).default([]),
	authConflicts: z.array(authConflictObservationSchema).default([]),
	identityObservations: z.array(identityObservationSchema).default([]),
	dateObservations: z.array(dateObservationSchema).default([]),
	messageIdObservations: z.array(messageIdObservationSchema).default([]),
	mimeParts: z.array(mimePartObservationSchema).default([]),
	indicators: z.array(indicatorObservationSchema).default([]),
	linkMismatches: z.array(linkMismatchObservationSchema).default([]),
	contentIndicators: z.array(contentIndicatorObservationSchema).default([]),
	parserWarnings: z.array(z.string()).default([]),
	routingAnomalies: z.array(routingAnomalyObservationSchema).default([]),
	enrichment: z.array(enrichmentObservationSchema).default([]),
	artifactSha256: z.string(),
	artifactByteSize: z.number().int(),
	artifactDigestAlgorithm: digestAlgorithmSchema,
	analyzedAt: z.string(),
});

export type AnalysisResultCompleted = z.infer<
	typeof analysisResultCompletedSchema
>;

export const analysisResultOutputSchema = z.discriminatedUnion("ready", [
	analysisResultNotReadySchema,
	analysisResultCompletedSchema,
]);

export type AnalysisResultOutput = z.infer<typeof analysisResultOutputSchema>;

const persistedAnalysisResultSchema = analysisResultCompletedSchema.omit({
	ready: true,
	status: true,
	completedAt: true,
	summary: true,
});

export function formatCompletedAnalysisResult(
	run: {
		id: string;
		organizationId: string;
		caseId: string;
		verdict?: string | null;
		score?: number | null;
		confidence?: number | null;
		analysisVersion?: string | null;
		rulesetVersion?: string | null;
		resultSchemaVersion?: string | null;
		completedAt?: Date | null;
	},
	snapshot: Record<string, unknown>,
): AnalysisResultCompleted {
	const parsed = persistedAnalysisResultSchema.parse(snapshot);
	if (
		parsed.analysisRunId !== run.id ||
		parsed.organizationId !== run.organizationId ||
		parsed.caseId !== run.caseId ||
		(run.verdict !== null &&
			run.verdict !== undefined &&
			parsed.verdict !== run.verdict) ||
		(run.score !== null &&
			run.score !== undefined &&
			parsed.score.finalScore !== run.score) ||
		(run.confidence !== null &&
			run.confidence !== undefined &&
			Math.abs(parsed.confidence - run.confidence) > 1e-5) ||
		(run.analysisVersion !== null &&
			run.analysisVersion !== undefined &&
			parsed.analysisVersion !== run.analysisVersion) ||
		(run.rulesetVersion !== null &&
			run.rulesetVersion !== undefined &&
			parsed.rulesetVersion !== run.rulesetVersion) ||
		(run.resultSchemaVersion !== null &&
			run.resultSchemaVersion !== undefined &&
			parsed.schemaVersion !== run.resultSchemaVersion)
	) {
		throw new Error("Persisted analysis result metadata mismatch");
	}

	const safe = sanitizeStructuredValue(parsed);
	const findings = safe.findings;
	return {
		...safe,
		ready: true,
		status: "completed",
		completedAt: run.completedAt ?? safe.analyzedAt,
		summary: {
			verdict: safe.verdict,
			finalScore: safe.score.finalScore,
			confidence: safe.confidence,
			findingsCount: findings.length,
			criticalCount: findings.filter(
				(finding) => finding.severity === "critical",
			).length,
			highCount: findings.filter((finding) => finding.severity === "high")
				.length,
			mediumCount: findings.filter((finding) => finding.severity === "medium")
				.length,
			lowCount: findings.filter((finding) => finding.severity === "low").length,
			infoCount: findings.filter((finding) => finding.severity === "info")
				.length,
		},
	};
}
