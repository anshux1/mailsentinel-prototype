import "server-only";

import {
	DrizzleAnalysisRunRepository,
	DrizzleAuditRepository,
	DrizzleReportRepository,
	decodeCursor,
	encodeCursor,
	executeTransaction,
	type ReportShell,
} from "@mailsentinel/db";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit";
import { db } from "@/server/db";
import { formatCompletedAnalysisResult } from "@/server/orpc/analysis-schemas";
import {
	buildReportDocument,
	REPORT_VERSION,
	renderReport,
} from "@/server/reports";
import {
	defaultReportStorage,
	type GeneratedReportFormat,
	reportObjectKey,
} from "@/server/storage/reports";
import type { RpcContext, TransactionExecutor } from "./context";
import { ConflictError, DependencyError, NotFoundError } from "./errors";
import { investigatorProcedure, viewerProcedure } from "./middleware";

const reportFormatSchema = z.enum(["json", "html", "text"]);

export const reportOutputSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	caseId: z.string(),
	analysisRunId: z.string(),
	version: z.number().int(),
	status: z.enum(["pending", "generating", "completed", "failed"]),
	format: z.enum(["json", "html", "pdf", "markdown", "text"]),
	metadata: z.record(z.string(), z.unknown()),
	failureReason: z.string().nullable().optional(),
	generatedAt: z.union([z.date(), z.string()]).nullable().optional(),
	createdAt: z.union([z.date(), z.string()]),
	updatedAt: z.union([z.date(), z.string()]),
});

const reportContentOutputSchema = reportOutputSchema.extend({
	content: z.string().nullable(),
	contentType: z.string().nullable(),
});

export type ReportOutput = z.infer<typeof reportOutputSchema>;

export function toReportOutput(record: ReportShell): ReportOutput {
	return {
		id: record.id,
		organizationId: record.organizationId,
		caseId: record.caseId,
		analysisRunId: record.analysisRunId,
		version: record.version,
		status: record.status,
		format: record.format,
		metadata: (record.metadata as Record<string, unknown>) ?? {},
		failureReason: record.failureReason ?? null,
		generatedAt: record.generatedAt ?? null,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export const generateReportInput = z
	.object({
		analysisRunId: z.string().min(1).max(200),
		format: reportFormatSchema.default("html").optional(),
	})
	.strict();

export const getReportInput = z.object({
	reportId: z.string().min(1).max(200),
	caseId: z.string().min(1).max(200).optional(),
});

export const listReportsInput = z.object({
	caseId: z.string().min(1).max(200).optional(),
	analysisRunId: z.string().min(1).max(200).optional(),
	format: z.enum(["json", "html", "pdf", "markdown", "text"]).optional(),
	status: z.enum(["pending", "generating", "completed", "failed"]).optional(),
	limit: z.number().int().min(1).max(100).default(50).optional(),
	cursor: z
		.string()
		.max(1024)
		.refine((value) => decodeCursor(value) !== null, "Invalid cursor")
		.optional(),
});

export const listReportsOutputSchema = z.object({
	items: z.array(reportOutputSchema),
	nextCursor: z.string().nullable(),
});

function transactionExecutor(context: RpcContext): TransactionExecutor {
	if (context.executeTx) return context.executeTx;
	if (
		context.repos &&
		typeof (context.repos as { transaction?: TransactionExecutor })
			.transaction === "function"
	) {
		return (
			context.repos as { transaction: TransactionExecutor }
		).transaction.bind(context.repos);
	}
	return (operation) => executeTransaction(db, operation);
}

function contentTypeFor(record: ReportShell): string | null {
	const value = (record.metadata as Record<string, unknown> | null)
		?.contentType;
	return typeof value === "string" ? value : null;
}

export const reportRouter = {
	generate: investigatorProcedure
		.input(generateReportInput)
		.output(reportContentOutputSchema)
		.handler(async ({ context, input }) => {
			const analysisRepo =
				context.repos?.analysisRuns ?? new DrizzleAnalysisRunRepository(db);
			const run = await analysisRepo.getAnalysisRun({
				organizationId: context.organizationId,
				analysisRunId: input.analysisRunId,
			});
			if (!run) throw new NotFoundError("Analysis run not found");
			if (run.status !== "completed" || !run.resultSnapshot) {
				throw new ConflictError(
					"A completed analysis result is required to generate a report",
				);
			}

			const result = formatCompletedAnalysisResult(
				run,
				run.resultSnapshot as Record<string, unknown>,
			);
			const generatedAt = (context.now ?? (() => new Date()))();
			const format: GeneratedReportFormat = input.format ?? "html";
			const document = buildReportDocument(result, generatedAt);
			const rendered = renderReport(document, format);

			const created = await transactionExecutor(context)(async (repos) => {
				const report = await repos.reports.createReport({
					organizationId: context.organizationId,
					caseId: run.caseId,
					analysisRunId: run.id,
					format,
					status: "generating",
					metadata: { reportVersion: REPORT_VERSION },
				});
				await recordAuditEvent(repos.audit, {
					organizationId: context.organizationId,
					actorUserId: context.userId,
					action: "report.requested",
					resourceType: "report",
					resourceId: report.id,
					requestId: context.requestId,
					metadata: {
						caseId: run.caseId,
						analysisRunId: run.id,
						format,
						version: report.version,
					},
				});
				return report;
			});

			const objectKey = reportObjectKey({
				organizationId: context.organizationId,
				caseId: run.caseId,
				analysisRunId: run.id,
				version: created.version,
				format,
			});
			const storage = context.reportStorage ?? defaultReportStorage;
			const reportRepo =
				context.repos?.reports ?? new DrizzleReportRepository(db);

			try {
				await storage.put({
					objectKey,
					organizationId: context.organizationId,
					caseId: run.caseId,
					analysisRunId: run.id,
					content: rendered.content,
					contentType: rendered.contentType,
				});
			} catch (error) {
				await reportRepo.updateReportStatus({
					organizationId: context.organizationId,
					reportId: created.id,
					status: "failed",
					failureReason: "Report storage write failed",
				});
				throw new DependencyError(
					"Report storage is unavailable",
					"storage",
					undefined,
					{
						cause: error,
					},
				);
			}

			let completed: ReportShell;
			try {
				completed = await reportRepo.updateReportStatus({
					organizationId: context.organizationId,
					reportId: created.id,
					status: "completed",
					objectKey,
					generatedAt,
					failureReason: null,
					metadata: {
						reportVersion: REPORT_VERSION,
						contentType: rendered.contentType,
						byteSize: Buffer.byteLength(rendered.content, "utf8"),
						findingCount: document.findings.length,
					},
				});
			} catch (error) {
				try {
					await storage.delete({
						objectKey,
						organizationId: context.organizationId,
						caseId: run.caseId,
						analysisRunId: run.id,
					});
				} catch {
					// Cleanup is best effort; never log object keys or raw provider errors.
				}
				throw error;
			}

			const auditRepo = context.repos?.audit ?? new DrizzleAuditRepository(db);
			await recordAuditEvent(auditRepo, {
				organizationId: context.organizationId,
				actorUserId: context.userId,
				action: "report.generate",
				resourceType: "report",
				resourceId: completed.id,
				requestId: context.requestId,
				metadata: {
					caseId: run.caseId,
					analysisRunId: run.id,
					format,
					version: completed.version,
				},
			});

			return {
				...toReportOutput(completed),
				content: rendered.content,
				contentType: rendered.contentType,
			};
		}),

	get: viewerProcedure
		.input(getReportInput)
		.output(reportContentOutputSchema)
		.handler(async ({ context, input }) => {
			const reportRepo =
				context.repos?.reports ?? new DrizzleReportRepository(db);
			const report = await reportRepo.getReport({
				organizationId: context.organizationId,
				reportId: input.reportId,
				caseId: input.caseId,
			});
			if (!report) throw new NotFoundError("Report not found");
			if (report.status !== "completed" || !report.objectKey) {
				return {
					...toReportOutput(report),
					content: null,
					contentType: contentTypeFor(report),
				};
			}
			const storage = context.reportStorage ?? defaultReportStorage;
			const content = await storage.get({
				objectKey: report.objectKey,
				organizationId: context.organizationId,
				caseId: report.caseId,
				analysisRunId: report.analysisRunId,
			});
			if (content === null)
				throw new DependencyError("Report object is unavailable", "storage");
			return {
				...toReportOutput(report),
				content,
				contentType: contentTypeFor(report),
			};
		}),

	list: viewerProcedure
		.input(listReportsInput)
		.output(listReportsOutputSchema)
		.handler(async ({ context, input }) => {
			const limit = input.limit ?? 50;
			const reportRepo =
				context.repos?.reports ?? new DrizzleReportRepository(db);
			const records = await reportRepo.listReports({
				organizationId: context.organizationId,
				caseId: input.caseId,
				analysisRunId: input.analysisRunId,
				format: input.format,
				status: input.status,
				limit: limit + 1,
				cursor: input.cursor,
			});
			const hasMore = records.length > limit;
			const items = hasMore ? records.slice(0, limit) : records;
			const last = items.at(-1);
			return {
				items: items.map(toReportOutput),
				nextCursor:
					hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
			};
		}),
};
