import "server-only";

import {
	DrizzleIngestionBatchRepository,
	decodeCursor,
	encodeCursor,
	type IngestionBatchShell,
} from "@mailsentinel/db";
import { z } from "zod";
import { db } from "@/server/db";
import { viewerProcedure } from "./middleware";

export const batchOutputSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	caseId: z.string(),
	source: z.enum(["upload_single", "upload_container", "mailbox_sync"]),
	status: z.enum(["pending", "segmenting", "ready", "partial", "failed"]),
	containerEvidenceId: z.string().nullable().optional(),
	messageCount: z.number().int(),
	readyCount: z.number().int(),
	failedCount: z.number().int(),
	failureReason: z.string().nullable().optional(),
	metadata: z.record(z.string(), z.unknown()),
	createdAt: z.union([z.date(), z.string()]),
	updatedAt: z.union([z.date(), z.string()]),
});

export type BatchOutput = z.infer<typeof batchOutputSchema>;

export function toBatchOutput(record: IngestionBatchShell): BatchOutput {
	return {
		id: record.id,
		organizationId: record.organizationId,
		caseId: record.caseId,
		source: record.source,
		status: record.status,
		containerEvidenceId: record.containerEvidenceId ?? null,
		messageCount: record.messageCount,
		readyCount: record.readyCount,
		failedCount: record.failedCount,
		failureReason: record.failureReason ?? null,
		metadata: (record.metadata as Record<string, unknown>) ?? {},
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export const listBatchesInput = z.object({
	caseId: z.string().min(1, "Case ID is required"),
	limit: z.number().int().min(1).max(100).default(50).optional(),
	cursor: z
		.string()
		.max(1024)
		.refine((val) => decodeCursor(val) !== null, "Invalid cursor")
		.nullable()
		.optional(),
});

export const batchListOutputSchema = z.object({
	items: z.array(batchOutputSchema),
	nextCursor: z.string().nullable(),
});

export const getBatchInput = z.object({
	batchId: z.string().min(1, "Batch ID is required"),
	caseId: z.string().optional(),
});

export const batchRouter = {
	list: viewerProcedure
		.input(listBatchesInput)
		.output(batchListOutputSchema)
		.handler(async ({ context, input }) => {
			const batchRepo =
				context.repos?.batches ?? new DrizzleIngestionBatchRepository(db);
			const limit = input.limit ?? 50;
			const records = await batchRepo.listBatchesByCase({
				organizationId: context.organizationId,
				caseId: input.caseId,
				limit: limit + 1,
				cursor: input.cursor ?? null,
			});

			const hasMore = records.length > limit;
			const page = hasMore ? records.slice(0, limit) : records;
			const last = page.at(-1);

			return {
				items: page.map(toBatchOutput),
				nextCursor:
					hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
			};
		}),

	get: viewerProcedure
		.input(getBatchInput)
		.output(batchOutputSchema.nullable())
		.handler(async ({ context, input }) => {
			const batchRepo =
				context.repos?.batches ?? new DrizzleIngestionBatchRepository(db);
			const record = await batchRepo.getBatch({
				organizationId: context.organizationId,
				batchId: input.batchId,
				caseId: input.caseId,
			});

			return record ? toBatchOutput(record) : null;
		}),
};
