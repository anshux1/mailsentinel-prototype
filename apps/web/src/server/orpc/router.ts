import "server-only";

import {
	DrizzleAuditRepository,
	DrizzleCaseRepository,
} from "@mailsentinel/db";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit";
import { db } from "@/server/db";
import { evidenceRouter } from "./evidence";
import {
	investigatorProcedure,
	publicProcedure,
	viewerProcedure,
} from "./middleware";

export {
	authedProcedure,
	investigatorProcedure,
	ownerProcedure,
	protectedProcedure,
	publicProcedure,
	requirePermission,
	requireRole,
	tenantProcedure,
	viewerProcedure,
} from "./middleware";

const caseShell = z.object({
	id: z.string(),
	organizationId: z.string(),
	title: z.string(),
});

const deferred = z.object({
	status: z.literal("deferred"),
	reason: z.string(),
});

export const router = {
	system: {
		health: publicProcedure
			.route({ method: "GET" })
			.output(
				z.object({
					ok: z.boolean(),
					service: z.literal("web"),
					timestamp: z.string(),
				}),
			)
			.handler(() => ({
				ok: true,
				service: "web" as const,
				timestamp: new Date().toISOString(),
			})),
	},
	case: {
		list: viewerProcedure
			.output(z.array(caseShell))
			.handler(async ({ context }) => {
				const repository =
					context.repos?.cases ?? new DrizzleCaseRepository(db);
				return repository.listCases({ organizationId: context.organizationId });
			}),
		get: viewerProcedure
			.input(z.object({ caseId: z.string().min(1) }))
			.output(caseShell.nullable())
			.handler(async ({ context, input }) => {
				const repository =
					context.repos?.cases ?? new DrizzleCaseRepository(db);
				return repository.getCase({
					organizationId: context.organizationId,
					caseId: input.caseId,
				});
			}),
		create: investigatorProcedure
			.input(z.object({ title: z.string().min(1).max(160) }))
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

				return createdCase;
			}),
	},
	evidence: evidenceRouter,
	analysis: {
		getStatus: viewerProcedure
			.input(z.object({ analysisRunId: z.string().min(1) }))
			.output(deferred)
			.handler(() => ({
				status: "deferred",
				reason: "No analysis has been started",
			})),
	},
	report: {
		generate: investigatorProcedure
			.input(z.object({ caseId: z.string().min(1) }))
			.output(deferred)
			.handler(() => ({
				status: "deferred",
				reason: "Reporting is outside setup",
			})),
	},
};

export type AppRouter = typeof router;
