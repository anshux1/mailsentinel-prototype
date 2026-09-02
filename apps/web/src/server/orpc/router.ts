import "server-only";

import { DrizzleCaseRepository } from "@mailsentinel/db";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import { db } from "@/server/db";
import type { RpcContext } from "./context";

const base = os.$context<RpcContext>();
const protectedProcedure = base.use(({ context, next }) => {
	if (!context.userId || !context.organizationId)
		throw new ORPCError("UNAUTHORIZED");
	return next({
		context: { userId: context.userId, organizationId: context.organizationId },
	});
});

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
		health: base
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
		list: protectedProcedure
			.output(z.array(caseShell))
			.handler(async ({ context }) => {
				const repository = new DrizzleCaseRepository(db);
				return repository.listCases({ organizationId: context.organizationId });
			}),
		get: protectedProcedure
			.input(z.object({ caseId: z.string().min(1) }))
			.output(caseShell.nullable())
			.handler(async ({ context, input }) => {
				const repository = new DrizzleCaseRepository(db);
				return repository.getCase({
					organizationId: context.organizationId,
					caseId: input.caseId,
				});
			}),
		create: protectedProcedure
			.input(z.object({ title: z.string().min(1).max(160) }))
			.output(caseShell)
			.handler(async ({ context, input }) => {
				const repository = new DrizzleCaseRepository(db);
				try {
					return await repository.createCase({
						organizationId: context.organizationId,
						title: input.title,
					});
				} catch {
					throw new ORPCError("INTERNAL_SERVER_ERROR");
				}
			}),
	},
	analysis: {
		getStatus: protectedProcedure
			.input(z.object({ analysisRunId: z.string().min(1) }))
			.output(deferred)
			.handler(() => ({
				status: "deferred",
				reason: "No analysis has been started",
			})),
	},
	report: {
		generate: protectedProcedure
			.input(z.object({ caseId: z.string().min(1) }))
			.output(deferred)
			.handler(() => ({
				status: "deferred",
				reason: "Reporting is outside setup",
			})),
	},
};

export type AppRouter = typeof router;
