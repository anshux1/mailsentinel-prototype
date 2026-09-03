import "server-only";

import {
	DrizzleAuditRepository,
	DrizzleCaseRepository,
	decodeCursor,
	encodeCursor,
} from "@mailsentinel/db";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { investigatorProcedure, viewerProcedure } from "./middleware";

export const caseShell = z.object({
	id: z.string(),
	organizationId: z.string(),
	title: z.string(),
	createdAt: z.union([z.date(), z.string()]),
	updatedAt: z.union([z.date(), z.string()]),
});

export type CaseShellOutput = z.infer<typeof caseShell>;

export const listCasesInput = z
	.object({
		limit: z.number().int().min(1).max(100).default(50).optional(),
		cursor: z
			.string()
			.max(1024)
			.refine((value) => decodeCursor(value) !== null, "Invalid cursor")
			.optional(),
	})
	.optional();

export const getCaseInput = z.object({
	caseId: z
		.string()
		.min(1, "Case ID is required")
		.max(200)
		.regex(/^[A-Za-z0-9_-]+$/),
});

export const createCaseInput = z.object({
	title: z
		.string()
		.trim()
		.min(1, "Title is required")
		.max(160, "Title cannot exceed 160 characters"),
});

export const caseListOutputSchema = z.object({
	items: z.array(caseShell),
	nextCursor: z.string().nullable(),
});

export const caseRouter = {
	list: viewerProcedure
		.input(listCasesInput)
		.output(caseListOutputSchema)
		.handler(async ({ context, input }) => {
			const limit = input?.limit ?? 50;
			const repository = context.repos?.cases ?? new DrizzleCaseRepository(db);
			const records = await repository.listCases({
				organizationId: context.organizationId,
				limit: limit + 1,
				cursor: input?.cursor,
			});
			const hasMore = records.length > limit;
			const items = hasMore ? records.slice(0, limit) : records;
			const last = items.at(-1);
			return {
				items,
				nextCursor:
					hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
			};
		}),

	get: viewerProcedure
		.input(getCaseInput)
		.output(caseShell.nullable())
		.handler(async ({ context, input }) => {
			const repository = context.repos?.cases ?? new DrizzleCaseRepository(db);
			return repository.getCase({
				organizationId: context.organizationId,
				caseId: input.caseId,
			});
		}),

	create: investigatorProcedure
		.input(createCaseInput)
		.output(caseShell)
		.handler(async ({ context, input }) => {
			const caseRepository =
				context.repos?.cases ?? new DrizzleCaseRepository(db);
			const auditRepository =
				context.repos?.audit ?? new DrizzleAuditRepository(db);

			const createdCase = await caseRepository.createCase({
				organizationId: context.organizationId,
				title: input.title,
			});

			await recordAuditEvent(auditRepository, {
				organizationId: context.organizationId,
				actorUserId: context.userId,
				action: "case.create",
				resourceType: "case",
				resourceId: createdCase.id,
				requestId: context.requestId,
				metadata: {
					title: createdCase.title,
				},
			});
			logger.info("case.created", {
				requestId: context.requestId,
				organizationId: context.organizationId,
				caseId: createdCase.id,
			});

			return createdCase;
		}),
};
