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
import { defaultEvidenceStorage, evidenceObjectKey } from "@/server/storage/s3";
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

	// 1. Verify connection ownership and status
	const connection = await repos.mailbox.getConnection({
		organizationId: options.organizationId,
		connectionId: options.connectionId,
	});

	if (!connection) {
		throw new NotFoundError("Mailbox connection not found");
	}

	if (connection.status === "disconnected") {
		throw new ConflictError("Mailbox connection is disconnected");
	}

	// 2. Verify target case exists and belongs to the active organization
	const caseRecord = await repos.cases.getCase({
		organizationId: options.organizationId,
		caseId: options.caseId,
	});

	if (!caseRecord) {
		throw new NotFoundError("Case not found");
	}

	// 3. Decrypt refresh token in the sync worker only.
	// Never log, audit, or return decrypted or encrypted tokens.
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

	// 4. Enforce bounds strictly server-side
	const rawMax = options.maxMessages ?? env.MAILBOX_SYNC_MAX_MESSAGES ?? 200;
	const effectiveMaxMessages = Math.min(Math.max(1, rawMax), 1000);

	// 5. Create ingestion batch for this mailbox sync run
	const batch = await repos.batches.createBatch({
		organizationId: options.organizationId,
		caseId: options.caseId,
		source: "mailbox_sync",
		status: "pending",
		messageCount: 0,
		readyCount: 0,
		failedCount: 0,
		metadata: {
			connectionId: connection.id,
			accountEmail: connection.accountEmail,
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
		metadata: {
			caseId: options.caseId,
			batchId: batch.id,
			accountEmail: connection.accountEmail,
		},
	});

	// Transition connection status to syncing
	await repos.mailbox.updateCursorAndStatus({
		organizationId: options.organizationId,
		connectionId: connection.id,
		status: "syncing",
	});

	// 6. Acquire access token via refresh token
	let accessToken: string;
	try {
		const tokenRes = await gmailClient.refreshAccessToken({ refreshToken });
		accessToken = tokenRes.accessToken;
	} catch {
		logger.warn("mailbox.auth_refresh_failed", {
			requestId: options.requestId,
			organizationId: options.organizationId,
			connectionId: connection.id,
		});

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

	// 7. Discover candidate message IDs (resuming from historyId or querying messages)
	let candidateMessageIds: string[] = [];
	let latestHistoryId: string | null = connection.syncCursor ?? null;
	let rateLimitHit = false;
	let authFailed = false;

	const useHistory =
		connection.syncCursor &&
		!options.label &&
		!options.startDate &&
		!options.endDate;

	if (useHistory) {
		try {
			const historyRes = await gmailClient.listHistory({
				accessToken,
				startHistoryId: connection.syncCursor as string,
				maxResults: effectiveMaxMessages,
			});

			if (historyRes.historyId) {
				latestHistoryId = historyRes.historyId;
			}

			const collected = new Set<string>();
			for (const entry of historyRes.history ?? []) {
				for (const added of entry.messagesAdded ?? []) {
					if (added.message?.id) {
						collected.add(added.message.id);
					}
				}
			}
			candidateMessageIds = Array.from(collected).slice(
				0,
				effectiveMaxMessages,
			);
		} catch (err) {
			if (err instanceof GmailHistoryExpiredError) {
				logger.info("mailbox.history_expired_falling_back", {
					requestId: options.requestId,
					organizationId: options.organizationId,
					connectionId: connection.id,
				});
				// Fall back to message listing below
			} else if (err instanceof GmailRateLimitError) {
				rateLimitHit = true;
			} else if (err instanceof GmailAuthError) {
				authFailed = true;
			} else {
				logger.warn("mailbox.history_query_failed", {
					requestId: options.requestId,
					organizationId: options.organizationId,
				});
			}
		}
	}

	if (candidateMessageIds.length === 0 && !rateLimitHit && !authFailed) {
		// Build search query q
		const queryParts: string[] = [];
		if (options.startDate) {
			const startSec = Math.floor(new Date(options.startDate).getTime() / 1000);
			if (!Number.isNaN(startSec)) {
				queryParts.push(`after:${startSec}`);
			}
		}
		if (options.endDate) {
			const endSec = Math.floor(new Date(options.endDate).getTime() / 1000);
			if (!Number.isNaN(endSec)) {
				queryParts.push(`before:${endSec}`);
			}
		}

		try {
			const listRes = await gmailClient.listMessages({
				accessToken,
				q: queryParts.length > 0 ? queryParts.join(" ") : undefined,
				labelIds: options.label ? [options.label] : undefined,
				maxResults: effectiveMaxMessages,
			});
			candidateMessageIds = listRes.messages
				.map((m) => m.id)
				.slice(0, effectiveMaxMessages);
		} catch (err) {
			if (err instanceof GmailRateLimitError) {
				rateLimitHit = true;
			} else if (err instanceof GmailAuthError) {
				authFailed = true;
			} else {
				logger.warn("mailbox.list_messages_failed", {
					requestId: options.requestId,
					organizationId: options.organizationId,
				});
			}
		}
	}

	// 8. Fetch, decode, store, verify, and dispatch candidate messages
	let readyCount = 0;
	let failedCount = 0;
	let sequence = 0;

	// Load existing evidence to deduplicate by idempotency key
	const existingEvidenceList = await repos.evidence.listEvidence({
		organizationId: options.organizationId,
		caseId: options.caseId,
	});
	const existingByKey = new Map<string, EvidenceShell>();
	for (const ev of existingEvidenceList) {
		if (ev.idempotencyKey) {
			existingByKey.set(ev.idempotencyKey, ev);
		}
	}

	for (const messageId of candidateMessageIds) {
		if (rateLimitHit || authFailed) break;

		const idempotencyKey = `gmail:${connection.id}:${messageId}`;

		// Re-sync deduplication check: never duplicate evidence or analysis runs
		const existing = existingByKey.get(idempotencyKey);
		if (existing) {
			readyCount++;
			continue;
		}

		// Fetch raw RFC 822 format with backoff on rate limit
		let rawMessage: { raw: string; historyId?: string } | null = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				rawMessage = await gmailClient.getMessageRaw({
					accessToken,
					messageId,
				});
				break;
			} catch (err) {
				if (err instanceof GmailRateLimitError) {
					if (attempt < 2) {
						await new Promise((resolve) =>
							setTimeout(resolve, 50 * (attempt + 1)),
						);
						continue;
					}
					rateLimitHit = true;
					break;
				}
				if (err instanceof GmailAuthError) {
					authFailed = true;
					break;
				}
				logger.warn("mailbox.message_fetch_failed", {
					requestId: options.requestId,
					organizationId: options.organizationId,
					messageId,
				});
				break;
			}
		}

		if (!rawMessage || rateLimitHit || authFailed) {
			if (!rateLimitHit && !authFailed) {
				failedCount++;
			}
			continue;
		}

		if (rawMessage.historyId) {
			latestHistoryId = rawMessage.historyId;
		}

		// Base64URL-decode raw message
		const buffer = Buffer.from(rawMessage.raw, "base64url");
		const sha256 = createHash("sha256")
			.update(buffer)
			.digest("hex")
			.toLowerCase();

		const artifactId = `gmail_${connection.id.slice(0, 8)}_${messageId}`;
		const objectKey = evidenceObjectKey({
			organizationId: options.organizationId,
			caseId: options.caseId,
			artifactId,
		});

		try {
			// Write to private storage
			await storage.putEvidence({
				objectKey,
				organizationId: options.organizationId,
				caseId: options.caseId,
				body: buffer,
				sha256,
			});

			// Create verified evidence record
			let createdEvidence: EvidenceShell;
			try {
				createdEvidence = await repos.evidence.createVerified({
					organizationId: options.organizationId,
					caseId: options.caseId,
					batchId: batch.id,
					sequence: sequence++,
					sourceMessageId: messageId,
					objectKey,
					sha256,
					byteSize: buffer.byteLength,
					contentType: "message/rfc822",
					idempotencyKey,
				});
			} catch (createErr) {
				if (createErr instanceof DbConflictError) {
					// Duplicate raced in concurrently
					readyCount++;
					continue;
				}
				throw createErr;
			}

			existingByKey.set(idempotencyKey, createdEvidence);

			// Dispatch analysis run
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
				// Analysis failure degrades safely without failing the whole sync
			}

			await repos.batches.incrementCounts({
				organizationId: options.organizationId,
				batchId: batch.id,
				readyIncrement: 1,
			});

			readyCount++;
		} catch {
			logger.warn("mailbox.message_ingest_failed", {
				requestId: options.requestId,
				organizationId: options.organizationId,
			});
			failedCount++;
		}
	}

	// 9. Determine final sync outcome
	let finalBatchStatus: "ready" | "partial" | "failed" = "ready";
	let safeFailureReason: string | null = null;

	if (authFailed) {
		safeFailureReason = "Authentication expired or revoked";
		finalBatchStatus = readyCount > 0 ? "partial" : "failed";
	} else if (rateLimitHit) {
		safeFailureReason = "Rate limit exceeded";
		finalBatchStatus = readyCount > 0 ? "partial" : "failed";
	} else if (failedCount > 0 && readyCount === 0) {
		finalBatchStatus = "failed";
		safeFailureReason = "Sync failed to process messages";
	} else if (failedCount > 0) {
		finalBatchStatus = "partial";
		safeFailureReason = "Some messages failed to sync";
	}

	// Transition batch status
	await repos.batches.transitionStatus({
		organizationId: options.organizationId,
		batchId: batch.id,
		status: finalBatchStatus,
		failureReason: safeFailureReason,
	});

	// Update connection cursor and status
	await repos.mailbox.updateCursorAndStatus({
		organizationId: options.organizationId,
		connectionId: connection.id,
		status: authFailed ? "error" : "connected",
		syncCursor: latestHistoryId,
		lastSyncedAt: new Date(),
		lastFailureReason: safeFailureReason,
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
			messageCount: readyCount + failedCount,
			readyCount,
			failedCount,
		},
	});

	return {
		batchId: batch.id,
		status: finalBatchStatus,
		messageCount: readyCount + failedCount,
		readyCount,
		failedCount,
		failureReason: safeFailureReason,
	};
}
