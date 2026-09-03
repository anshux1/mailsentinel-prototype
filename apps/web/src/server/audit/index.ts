import "server-only";

import type { AuditRecordShell, AuditRepository } from "@mailsentinel/db";
import { logger } from "@/server/logger";

export type AuditAction =
	| "case.create"
	| "case.view"
	| "evidence.upload_init"
	| "evidence.upload_complete"
	| "analysis.start"
	| "analysis.retry"
	| "report.generate"
	| "report.download"
	| "retention.purge"
	| "role.assign"
	| (string & {});

export type AuditResourceType =
	| "case"
	| "evidence"
	| "analysis_run"
	| "report"
	| "organization"
	| "membership"
	| (string & {});

export interface SafeAuditEventInput {
	organizationId: string;
	actorUserId: string | null;
	action: AuditAction;
	resourceType: AuditResourceType;
	resourceId?: string | null;
	requestId?: string;
	metadata?: Record<string, string | number | boolean | null | undefined>;
	createdAt?: Date;
}

const FORBIDDEN_METADATA_KEYS = [
	"body",
	"raw",
	"content",
	"attachment",
	"token",
	"secret",
	"password",
	"key",
	"credential",
] as const;

function isSafeMetadataKey(key: string): boolean {
	const lower = key.toLowerCase();
	return !FORBIDDEN_METADATA_KEYS.some((part) => lower.includes(part));
}

export function sanitizeAuditMetadata(
	metadata: Record<string, string | number | boolean | null | undefined> = {},
	requestId?: string,
): Record<string, string> {
	const result: Record<string, string> = {};

	if (requestId) {
		result.requestId = requestId.slice(0, 128);
	}

	for (const [key, value] of Object.entries(metadata)) {
		if (key === "requestId") continue;
		if (!isSafeMetadataKey(key)) {
			result[key] = "[REDACTED]";
			continue;
		}

		if (value === null || value === undefined) {
			result[key] = "";
		} else if (typeof value === "string") {
			result[key] = value.slice(0, 256);
		} else {
			result[key] = String(value).slice(0, 256);
		}
	}

	return result;
}

export async function recordAuditEvent(
	auditRepo: AuditRepository,
	event: SafeAuditEventInput,
): Promise<AuditRecordShell> {
	const safeMetadata = sanitizeAuditMetadata(event.metadata, event.requestId);

	const record = await auditRepo.appendAuditRecord({
		organizationId: event.organizationId,
		actorUserId: event.actorUserId,
		action: event.action,
		resourceType: event.resourceType,
		resourceId: event.resourceId ?? null,
		metadata: safeMetadata,
		createdAt: event.createdAt,
	});

	logger.info("audit.event_recorded", {
		requestId: event.requestId,
		organizationId: event.organizationId,
		userId: event.actorUserId,
		action: event.action,
		resourceType: event.resourceType,
		resourceId: event.resourceId ?? null,
	});

	return record;
}
