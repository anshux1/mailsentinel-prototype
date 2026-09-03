import "server-only";

import {
	DrizzleAnalysisRunRepository,
	DrizzleAuditRepository,
	DrizzleCaseRepository,
	DrizzleEvidenceRepository,
	DrizzleIngestionBatchRepository,
	DrizzleMailboxConnectionRepository,
	DrizzleReportRepository,
	type MailboxConnectionShell,
} from "@mailsentinel/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { env } from "@/env";
import { defaultAnalyzerClient } from "@/server/analyzer-client";
import { recordAuditEvent } from "@/server/audit";
import { db } from "@/server/db";
import { defaultGmailClient } from "@/server/mailbox/client";
import { runMailboxSync } from "@/server/mailbox/sync";
import { defaultEvidenceStorage } from "@/server/storage/s3";
import { NotFoundError } from "./errors";
import {
	investigatorProcedure,
	ownerProcedure,
	viewerProcedure,
} from "./middleware";

function assertMailboxEnabled(requestId?: string): void {
	if (!env.MAILBOX_CONNECTORS_ENABLED) {
		throw new ORPCError("FORBIDDEN", {
			message: "Mailbox connectors are disabled",
			data: {
				requestId,
				code: "MAILBOX_CONNECTORS_DISABLED",
			},
		});
	}
}

const mailboxViewerProcedure = viewerProcedure.use(({ context, next }) => {
	assertMailboxEnabled(context.requestId);
	return next();
});

const mailboxInvestigatorProcedure = investigatorProcedure.use(
	({ context, next }) => {
		assertMailboxEnabled(context.requestId);
		return next();
	},
);

const mailboxOwnerProcedure = ownerProcedure.use(({ context, next }) => {
	assertMailboxEnabled(context.requestId);
	return next();
});

export const mailboxConnectionOutputSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	provider: z.literal("gmail"),
	accountEmail: z.string(),
	scopes: z.string().nullable().optional(),
	syncCursor: z.string().nullable().optional(),
	status: z.enum(["connected", "disconnected", "syncing", "error"]),
	lastSyncedAt: z.union([z.date(), z.string()]).nullable().optional(),
	lastFailureReason: z.string().nullable().optional(),
	createdByUserId: z.string().nullable().optional(),
	createdAt: z.union([z.date(), z.string()]),
	updatedAt: z.union([z.date(), z.string()]),
});

export type MailboxConnectionOutput = z.infer<
	typeof mailboxConnectionOutputSchema
>;

export function toMailboxConnectionOutput(
	record: MailboxConnectionShell,
): MailboxConnectionOutput {
	return {
		id: record.id,
		organizationId: record.organizationId,
		provider: record.provider,
		accountEmail: record.accountEmail,
		scopes: record.scopes ?? null,
		syncCursor: record.syncCursor ?? null,
		status: record.status,
		lastSyncedAt: record.lastSyncedAt ?? null,
		lastFailureReason: record.lastFailureReason ?? null,
		createdByUserId: record.createdByUserId ?? null,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

const mailboxIdentifierSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9_-]+$/);

export const listMailboxConnectionsInput = z
	.object({
		status: z
			.enum(["connected", "disconnected", "syncing", "error"])
			.optional(),
	})
	.optional();

export const listMailboxConnectionsOutputSchema = z.object({
	items: z.array(mailboxConnectionOutputSchema),
});

export const getMailboxStatusInput = z.object({
	connectionId: mailboxIdentifierSchema,
});

export const startMailboxSyncInput = z.object({
	connectionId: mailboxIdentifierSchema,
	caseId: mailboxIdentifierSchema,
	maxMessages: z.number().int().min(1).max(1000).default(200).optional(),
	label: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[A-Za-z0-9_-]+$/)
		.optional(),
	startDate: z.iso.datetime({ offset: true }).optional(),
	endDate: z.iso.datetime({ offset: true }).optional(),
});

export const startMailboxSyncOutputSchema = z.object({
	batchId: z.string(),
	status: z.enum(["ready", "partial", "failed"]),
	messageCount: z.number().int(),
	readyCount: z.number().int(),
	failedCount: z.number().int(),
	failureReason: z.string().nullable().optional(),
});

export const disconnectMailboxInput = z.object({
	connectionId: mailboxIdentifierSchema,
});

export const disconnectMailboxOutputSchema = z.object({
	success: z.boolean(),
});

export const mailboxRouter = {
	list: mailboxViewerProcedure
		.input(listMailboxConnectionsInput)
		.output(listMailboxConnectionsOutputSchema)
		.handler(async ({ context, input }) => {
			const mailboxRepo =
				context.repos?.mailbox ?? new DrizzleMailboxConnectionRepository(db);
			const records = await mailboxRepo.listConnections({
				organizationId: context.organizationId,
			});
			const filtered = input?.status
				? records.filter((r) => r.status === input.status)
				: records;

			return {
				items: filtered.map(toMailboxConnectionOutput),
			};
		}),

	status: mailboxViewerProcedure
		.input(getMailboxStatusInput)
		.output(mailboxConnectionOutputSchema.nullable())
		.handler(async ({ context, input }) => {
			const mailboxRepo =
				context.repos?.mailbox ?? new DrizzleMailboxConnectionRepository(db);
			const record = await mailboxRepo.getConnection({
				organizationId: context.organizationId,
				connectionId: input.connectionId,
			});

			return record ? toMailboxConnectionOutput(record) : null;
		}),

	startSync: mailboxInvestigatorProcedure
		.input(startMailboxSyncInput)
		.output(startMailboxSyncOutputSchema)
		.handler(async ({ context, input }) => {
			const result = await runMailboxSync({
				organizationId: context.organizationId,
				connectionId: input.connectionId,
				caseId: input.caseId,
				maxMessages: input.maxMessages,
				label: input.label,
				startDate: input.startDate,
				endDate: input.endDate,
				actorUserId: context.userId,
				requestId: context.requestId,
				repos: {
					cases: context.repos?.cases ?? new DrizzleCaseRepository(db),
					evidence:
						context.repos?.evidence ?? new DrizzleEvidenceRepository(db),
					analysisRuns:
						context.repos?.analysisRuns ?? new DrizzleAnalysisRunRepository(db),
					reports: context.repos?.reports ?? new DrizzleReportRepository(db),
					audit: context.repos?.audit ?? new DrizzleAuditRepository(db),
					batches:
						context.repos?.batches ?? new DrizzleIngestionBatchRepository(db),
					mailbox:
						context.repos?.mailbox ??
						new DrizzleMailboxConnectionRepository(db),
				},
				storage: context.storage ?? defaultEvidenceStorage,
				analyzerClient: context.analyzerClient ?? defaultAnalyzerClient,
				gmailClient: context.gmailClient ?? defaultGmailClient,
			});

			return result;
		}),

	disconnect: mailboxOwnerProcedure
		.input(disconnectMailboxInput)
		.output(disconnectMailboxOutputSchema)
		.handler(async ({ context, input }) => {
			const mailboxRepo =
				context.repos?.mailbox ?? new DrizzleMailboxConnectionRepository(db);
			const auditRepo = context.repos?.audit ?? new DrizzleAuditRepository(db);

			const existing = await mailboxRepo.getConnection({
				organizationId: context.organizationId,
				connectionId: input.connectionId,
			});

			if (!existing) {
				throw new NotFoundError("Mailbox connection not found");
			}

			await mailboxRepo.deleteConnection({
				organizationId: context.organizationId,
				connectionId: input.connectionId,
			});

			await recordAuditEvent(auditRepo, {
				organizationId: context.organizationId,
				actorUserId: context.userId,
				action: "mailbox.disconnected",
				resourceType: "mailbox_connection",
				resourceId: input.connectionId,
				requestId: context.requestId,
				metadata: {
					accountEmail: existing.accountEmail,
					provider: existing.provider,
				},
			});

			return { success: true };
		}),
};
