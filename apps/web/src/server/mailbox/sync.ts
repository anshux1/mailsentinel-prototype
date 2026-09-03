import "server-only";

import { createHash } from "node:crypto";
import type { AnalysisIntakeRequest } from "@mailsentinel/contracts";
import {
	ConflictError as DbConflictError,
	DrizzleAnalysisRunRepository,
	DrizzleAuditRepository,
	DrizzleCaseRepository,
	DrizzleEvidenceRepository,
	DrizzleIngestionBatchRepository,
	DrizzleMailboxConnectionRepository,
	type EvidenceShell,
} from "@mailsentinel/db";
import { env } from "@/env";
import { defaultAnalyzerClient } from "@/server/analyzer-client";
import { recordAuditEvent } from "@/server/audit";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { ConflictError, NotFoundError } from "@/server/orpc/errors";
import {
	defaultEvidenceStorage,
	evidenceObjectKey,
	MAX_EML_BYTES,
} from "@/server/storage/s3";
import { defaultGmailClient } from "./client";
import { decryptToken } from "./crypto";
import {
	GmailAuthError,
	type GmailClient,
	GmailHistoryExpiredError,
	GmailRateLimitError,
	type MailboxSyncOptions,
	type MailboxSyncResult,
} from "./types";

const MAX_PROVIDER_ATTEMPTS = 3;

async function withProviderRetry<T>(operation: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < MAX_PROVIDER_ATTEMPTS; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (
				!(error instanceof GmailRateLimitError) ||
				attempt === MAX_PROVIDER_ATTEMPTS - 1
			) {
				throw error;
			}
			const exponential = 100 * 2 ** attempt;
			const delay = Math.min(10_000, Math.max(exponential, error.retryAfterMs));
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}

function decodeGmailRaw(value: string): Buffer {
	if (
		value.length === 0 ||
		value.length > Math.ceil(MAX_EML_BYTES / 3) * 4 + 4 ||
		!/^[A-Za-z0-9_-]+={0,2}$/.test(value) ||
		value.length % 4 === 1
	) {
		throw new Error("invalid Gmail raw message encoding");
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.byteLength === 0 || decoded.byteLength > MAX_EML_BYTES) {
		throw new Error("Gmail raw message exceeds the configured size limit");
	}
	const canonicalInput = value.replace(/=+$/, "");
	if (decoded.toString("base64url") !== canonicalInput) {
		throw new Error("non-canonical Gmail raw message encoding");
	}
	return decoded;
}

function extractSafeSummary(buffer: Buffer): {
	from?: string | null;
	fromDisplayName?: string | null;
	subject?: string | null;
	date?: string | null;
	messageId?: string | null;
} {
	const headerEnd = buffer.indexOf("\r\n\r\n");
	const fallbackEnd = buffer.indexOf("\n\n");
	const end =
		headerEnd >= 0
			? headerEnd
			: fallbackEnd >= 0
				? fallbackEnd
				: Math.min(buffer.byteLength, 65_536);
	const headerText = buffer
		.subarray(0, Math.min(end, 65_536))
		.toString("utf8")
		.replace(/\r?\n[ \t]+/g, " ");
	const values = new Map<string, string>();
	for (const line of headerText.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const name = line.slice(0, separator).trim().toLowerCase();
		if (!values.has(name)) values.set(name, line.slice(separator + 1).trim());
	}
	const from = values.get("from")?.slice(0, 500) ?? null;
	const displayMatch = from?.match(/^\s*"?([^"<]+?)"?\s*</);
	return {
		from,
		fromDisplayName: displayMatch?.[1]?.trim().slice(0, 500) ?? null,
		subject: values.get("subject")?.slice(0, 2_000) ?? null,
		date: values.get("date")?.slice(0, 200) ?? null,
		messageId: values.get("message-id")?.slice(0, 998) ?? null,
	};
}

export async function runMailboxSync(
	options: MailboxSyncOptions,
): Promise<MailboxSyncResult> {
	const repos = {
		cases: options.repos?.cases ?? new DrizzleCaseRepository(db),
		evidence: options.repos?.evidence ?? new DrizzleEvidenceRepository(db),
		analysisRuns:
			options.repos?.analysisRuns ?? new DrizzleAnalysisRunRepository(db),
		batches: options.repos?.batches ?? new DrizzleIngestionBatchRepository(db),
		mailbox:
			options.repos?.mailbox ?? new DrizzleMailboxConnectionRepository(db),
		audit: options.repos?.audit ?? new DrizzleAuditRepository(db),
	};
	const storage = options.storage ?? defaultEvidenceStorage;
	const analyzer = options.analyzerClient ?? defaultAnalyzerClient;
	const gmailClient: GmailClient = options.gmailClient ?? defaultGmailClient;

	const connection = await repos.mailbox.getConnection({
		organizationId: options.organizationId,
		connectionId: options.connectionId,
	});
	if (!connection) throw new NotFoundError("Mailbox connection not found");
	if (connection.status === "disconnected")
		throw new ConflictError("Mailbox connection is disconnected");

	const caseRecord = await repos.cases.getCase({
		organizationId: options.organizationId,
		caseId: options.caseId,
	});
	if (!caseRecord) throw new NotFoundError("Case not found");

	// Database compare-and-set prevents concurrent syncs across application instances.
	await repos.mailbox.beginSync({
		organizationId: options.organizationId,
		connectionId: connection.id,
	});

	let refreshToken: string;
	try {
		refreshToken = decryptToken(
			{
				encryptedRefreshToken: connection.encryptedRefreshToken,
				tokenNonce: connection.tokenNonce,
			},
			options.encryptionKey,
		);
	} catch {
		await repos.mailbox.updateCursorAndStatus({
			organizationId: options.organizationId,
			connectionId: connection.id,
			status: "error",
			lastFailureReason: "Failed to decrypt credentials",
		});
		throw new ConflictError(
			"Stored mailbox credentials are unreadable or tampered",
		);
	}

	const effectiveMaxMessages = Math.min(
		Math.max(1, options.maxMessages ?? env.MAILBOX_SYNC_MAX_MESSAGES ?? 200),
		1000,
	);
	const batch = await repos.batches.createBatch({
		organizationId: options.organizationId,
		caseId: options.caseId,
		source: "mailbox_sync",
		status: "pending",
		messageCount: 0,
		readyCount: 0,
		failedCount: 0,
		metadata: {
			provider: connection.provider,
			label: options.label ?? null,
		},
	});

	await recordAuditEvent(repos.audit, {
		organizationId: options.organizationId,
		actorUserId: options.actorUserId ?? null,
		action: "mailbox.sync_started",
		resourceType: "mailbox_connection",
		resourceId: connection.id,
		requestId: options.requestId,
		metadata: { caseId: options.caseId, batchId: batch.id },
	});

	let accessToken: string;
	try {
		accessToken = (
			await withProviderRetry(() =>
				gmailClient.refreshAccessToken({ refreshToken }),
			)
		).accessToken;
	} catch {
		await repos.mailbox.updateCursorAndStatus({
			organizationId: options.organizationId,
			connectionId: connection.id,
			status: "error",
			lastFailureReason: "Authentication expired or revoked",
		});
		await repos.batches.transitionStatus({
			organizationId: options.organizationId,
			batchId: batch.id,
			status: "failed",
			failureReason: "Authentication expired or revoked",
		});
		return {
			batchId: batch.id,
			status: "failed",
			messageCount: 0,
			readyCount: 0,
			failedCount: 0,
			failureReason: "Authentication expired or revoked",
		};
	}

	let latestHistoryId: string | null = connection.syncCursor ?? null;
	let candidateMessageIds: string[] = [];
	let discoveryFailure: "auth" | "rate" | "provider" | null = null;
	const useHistory = Boolean(
		connection.syncCursor &&
			!options.label &&
			!options.startDate &&
			!options.endDate,
	);
	let historyExpired = false;

	if (useHistory) {
		try {
			const collected = new Set<string>();
			let pageToken: string | undefined;
			do {
				const page = await withProviderRetry(() =>
					gmailClient.listHistory({
						accessToken,
						startHistoryId: connection.syncCursor as string,
						maxResults: Math.min(500, effectiveMaxMessages - collected.size),
						pageToken,
					}),
				);
				for (const entry of page.history ?? []) {
					for (const added of entry.messagesAdded ?? []) {
						if (added.message.id) collected.add(added.message.id);
						if (collected.size >= effectiveMaxMessages) break;
					}
					if (collected.size >= effectiveMaxMessages) break;
				}
				if (page.historyId) latestHistoryId = page.historyId;
				pageToken = page.nextPageToken;
			} while (pageToken && collected.size < effectiveMaxMessages);
			candidateMessageIds = [...collected];
		} catch (error) {
			if (error instanceof GmailHistoryExpiredError) historyExpired = true;
			else if (error instanceof GmailAuthError) discoveryFailure = "auth";
			else if (error instanceof GmailRateLimitError) discoveryFailure = "rate";
			else discoveryFailure = "provider";
		}
	}

	// Empty successful history means no changes. Full listing is used only for
	// first/filtered syncs or an explicitly expired cursor.
	if ((!useHistory || historyExpired) && !discoveryFailure) {
		try {
			const queryParts: string[] = [];
			if (options.startDate)
				queryParts.push(
					`after:${Math.floor(new Date(options.startDate).getTime() / 1000)}`,
				);
			if (options.endDate)
				queryParts.push(
					`before:${Math.floor(new Date(options.endDate).getTime() / 1000)}`,
				);
			const collected = new Set<string>();
			let pageToken: string | undefined;
			do {
				const page = await withProviderRetry(() =>
					gmailClient.listMessages({
						accessToken,
						q: queryParts.length ? queryParts.join(" ") : undefined,
						labelIds: options.label ? [options.label] : undefined,
						maxResults: Math.min(500, effectiveMaxMessages - collected.size),
						pageToken,
					}),
				);
				for (const message of page.messages) {
					if (message.id) collected.add(message.id);
					if (collected.size >= effectiveMaxMessages) break;
				}
				pageToken = page.nextPageToken;
			} while (pageToken && collected.size < effectiveMaxMessages);
			candidateMessageIds = [...collected];
			const profile = await withProviderRetry(() =>
				gmailClient.getProfile({ accessToken }),
			);
			if (profile.historyId) latestHistoryId = profile.historyId;
		} catch (error) {
			if (error instanceof GmailAuthError) discoveryFailure = "auth";
			else if (error instanceof GmailRateLimitError) discoveryFailure = "rate";
			else discoveryFailure = "provider";
		}
	}

	let readyCount = 0;
	let failedCount = 0;
	let sequence = 0;
	const existingEvidenceList = await repos.evidence.listEvidence({
		organizationId: options.organizationId,
		caseId: options.caseId,
	});
	const existingByKey = new Map<string, EvidenceShell>();
	for (const evidence of existingEvidenceList) {
		if (evidence.idempotencyKey)
			existingByKey.set(evidence.idempotencyKey, evidence);
	}

	if (!discoveryFailure) {
		for (const messageId of candidateMessageIds) {
			const idempotencyKey = `gmail:${connection.id}:${messageId}`;
			if (existingByKey.has(idempotencyKey)) continue;
			const currentSequence = sequence++;
			try {
				const rawMessage = await withProviderRetry(() =>
					gmailClient.getMessageRaw({ accessToken, messageId }),
				);
				const buffer = decodeGmailRaw(rawMessage.raw);
				if (
					rawMessage.historyId &&
					(!latestHistoryId ||
						BigInt(rawMessage.historyId) > BigInt(latestHistoryId))
				) {
					latestHistoryId = rawMessage.historyId;
				}
				const sha256 = createHash("sha256").update(buffer).digest("hex");
				const objectKey = evidenceObjectKey({
					organizationId: options.organizationId,
					caseId: options.caseId,
					artifactId: `gmail_${connection.id.slice(0, 8)}_${messageId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)}`,
				});
				await storage.putEvidence({
					objectKey,
					organizationId: options.organizationId,
					caseId: options.caseId,
					body: buffer,
					sha256,
				});

				let createdEvidence: EvidenceShell;
				try {
					createdEvidence = await repos.evidence.createVerified({
						organizationId: options.organizationId,
						caseId: options.caseId,
						batchId: batch.id,
						sequence: currentSequence,
						sourceMessageId: messageId,
						summary: extractSafeSummary(buffer),
						objectKey,
						sha256,
						byteSize: buffer.byteLength,
						contentType: "message/rfc822",
						idempotencyKey,
					});
				} catch (error) {
					if (!(error instanceof DbConflictError)) throw error;
					// A concurrent sync won the idempotency race. It is not a member
					// of this batch and therefore is not counted here.
					continue;
				}
				existingByKey.set(idempotencyKey, createdEvidence);
				readyCount++;

				try {
					const run = await repos.analysisRuns.createAnalysisRun({
						organizationId: options.organizationId,
						caseId: options.caseId,
						evidenceId: createdEvidence.id,
						status: "accepted",
						idempotencyKey: `run:${idempotencyKey}`,
					});
					const intakeRequest: AnalysisIntakeRequest = {
						analysisRunId: run.id,
						organizationId: options.organizationId,
						caseId: options.caseId,
						requestedAt: new Date().toISOString(),
						artifact: {
							objectKey: createdEvidence.objectKey,
							sha256: createdEvidence.sha256,
							byteSize: createdEvidence.byteSize,
							digestAlgorithm: "sha256",
						},
					};
					await analyzer.dispatchIntake({
						request: intakeRequest,
						requestId: options.requestId,
					});
				} catch {
					logger.warn("mailbox.analysis_dispatch_deferred", {
						requestId: options.requestId,
						organizationId: options.organizationId,
						evidenceId: createdEvidence.id,
					});
					await recordAuditEvent(repos.audit, {
						organizationId: options.organizationId,
						actorUserId: options.actorUserId ?? null,
						action: "analysis.dispatch_deferred",
						resourceType: "evidence",
						resourceId: createdEvidence.id,
						requestId: options.requestId,
						metadata: { retryable: true },
					});
				}
			} catch (error) {
				if (error instanceof GmailAuthError) discoveryFailure = "auth";
				else if (error instanceof GmailRateLimitError)
					discoveryFailure = "rate";
				else failedCount++;
				if (discoveryFailure) break;
			}
		}
	}

	let status: "ready" | "partial" | "failed" = "ready";
	let failureReason: string | null = null;
	if (discoveryFailure === "auth")
		failureReason = "Authentication expired or revoked";
	else if (discoveryFailure === "rate") failureReason = "Rate limit exceeded";
	else if (discoveryFailure === "provider")
		failureReason = "Mailbox provider unavailable";
	else if (failedCount > 0) failureReason = "Some messages failed to sync";
	if (failureReason) status = readyCount > 0 ? "partial" : "failed";

	const messageCount = readyCount + failedCount;
	await repos.batches.setCounts({
		organizationId: options.organizationId,
		batchId: batch.id,
		messageCount,
		readyCount,
		failedCount,
	});
	await repos.batches.transitionStatus({
		organizationId: options.organizationId,
		batchId: batch.id,
		status,
		failureReason,
	});

	await repos.mailbox.updateCursorAndStatus({
		organizationId: options.organizationId,
		connectionId: connection.id,
		status: discoveryFailure === "auth" ? "error" : "connected",
		...(discoveryFailure ? {} : { syncCursor: latestHistoryId }),
		lastSyncedAt: new Date(),
		lastFailureReason: failureReason,
	});
	await recordAuditEvent(repos.audit, {
		organizationId: options.organizationId,
		actorUserId: options.actorUserId ?? null,
		action: "mailbox.sync_completed",
		resourceType: "mailbox_connection",
		resourceId: connection.id,
		requestId: options.requestId,
		metadata: {
			caseId: options.caseId,
			batchId: batch.id,
			messageCount,
			readyCount,
			failedCount,
		},
	});
	return {
		batchId: batch.id,
		status,
		messageCount,
		readyCount,
		failedCount,
		failureReason,
	};
}
