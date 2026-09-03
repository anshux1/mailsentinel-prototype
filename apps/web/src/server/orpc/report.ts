import "server-only";

import {
	DrizzleReportRepository,
	decodeCursor,
	encodeCursor,
	type ReportShell,
} from "@mailsentinel/db";
import { z } from "zod";
import { db } from "@/server/db";
import { NotFoundError } from "./errors";
import { investigatorProcedure, viewerProcedure } from "./middleware";

export const deferredReportOutputSchema = z.object({
	status: z.literal("deferred"),
	reason: z.string(),
});

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

export const generateReportInput = z.object({
	caseId: z.string().min(1, "Case ID is required"),
});

export const getReportInput = z.object({
	reportId: z.string().min(1, "Report ID is required"),
	caseId: z.string().min(1, "Case ID is required").optional(),
});

export const listReportsInput = z.object({
	caseId: z.string().min(1, "Case ID is required").optional(),
	analysisRunId: z.string().min(1, "Analysis run ID is required").optional(),
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

export const reportRouter = {
	generate: investigatorProcedure
		.input(generateReportInput)
		.output(deferredReportOutputSchema)
		.handler(() => ({
			status: "deferred" as const,
			reason: "Reporting is outside setup",
		})),

	get: viewerProcedure
		.input(getReportInput)
		.output(reportOutputSchema)
		.handler(async ({ context, input }) => {
			const reportRepo =
				context.repos?.reports ?? new DrizzleReportRepository(db);
			const report = await reportRepo.getReport({
				organizationId: context.organizationId,
				reportId: input.reportId,
				caseId: input.caseId,
			});
			if (!report) {
				throw new NotFoundError("Report not found");
			}
			return toReportOutput(report);
		}),

	list: viewerProcedure
		.input(listReportsInput)
		.output(listReportsOutputSchema)
		.handler(async ({ context, input }) => {
			const boundedLimit = Math.min(input.limit ?? 50, 100);
			const reportRepo =
				context.repos?.reports ?? new DrizzleReportRepository(db);
			const records = await reportRepo.listReports({
				organizationId: context.organizationId,
				caseId: input.caseId,
				analysisRunId: input.analysisRunId,
				format: input.format,
				status: input.status,
				limit: boundedLimit + 1,
				cursor: input.cursor,
			});

			const hasMore = records.length > boundedLimit;
			const items = hasMore ? records.slice(0, boundedLimit) : records;
			const lastItem = items[items.length - 1];
			const nextCursor =
				hasMore && lastItem
					? encodeCursor(lastItem.createdAt, lastItem.id)
					: null;

			return {
				items: items.map(toReportOutput),
				nextCursor,
			};
		}),
};
