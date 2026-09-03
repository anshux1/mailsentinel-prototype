import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { SegmentationResult } from "@mailsentinel/contracts";
import {
	type AuditRepository,
	ConflictError as DbConflictError,
	DrizzleAuditRepository,
	DrizzleCaseRepository,
	DrizzleEvidenceRepository,
	DrizzleIngestionBatchRepository,
	decodeCursor,
	type EvidenceShell,
	encodeCursor,
	MemoryEvidenceRepository,
	MemoryIngestionBatchRepository,
} from "@mailsentinel/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { defaultAnalyzerClient } from "@/server/analyzer-client";
import { recordAuditEvent } from "@/server/audit";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import {
	defaultEvidenceStorage,
	type EvidenceStorage,
	evidenceObjectKey,
	MAX_EML_BYTES,
} from "@/server/storage/s3";
import {
	ConflictError,
	DependencyError,
	NotFoundError,
	PayloadTooLargeError,
} from "./errors";
import { investigatorProcedure, viewerProcedure } from "./middleware";

export const evidenceSummarySchema = z.object({
	from: z.string().nullable().optional(),
	subject: z.string().nullable().optional(),
	date: z.union([z.date(), z.string()]).nullable().optional(),
});

export type EvidenceSummary = z.infer<typeof evidenceSummarySchema>;

export const evidenceOutputSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	caseId: z.string(),
	sha256: z.string(),
	byteSize: z.number().int(),
	contentType: z.string(),
	status: z.enum(["pending", "stored", "verified", "failed"]),
	batchId: z.string().nullable().optional(),
	sequence: z.number().int().nullable().optional(),
	sourceMessageId: z.string().nullable().optional(),
	summary: evidenceSummarySchema.nullable().optional(),
	storedAt: z.union([z.date(), z.string()]).nullable().optional(),
	verifiedAt: z.union([z.date(), z.string()]).nullable().optional(),
	failedAt: z.union([z.date(), z.string()]).nullable().optional(),
	failureReason: z.string().nullable().optional(),
	createdAt: z.union([z.date(), z.string()]),
	updatedAt: z.union([z.date(), z.string()]),
});

export type EvidenceOutput = z.infer<typeof evidenceOutputSchema>;

// Alias for backwards compatibility
export const evidenceShell = evidenceOutputSchema;

export function toEvidenceOutput(
	record: EvidenceShell,
	summary?: EvidenceSummary | null,
): EvidenceOutput {
	const explicitSummary =
		typeof summary === "object" && summary !== null ? summary : null;
	const recordSummary = (
		record as unknown as { summary?: EvidenceSummary | null }
	).summary;
	return {
		id: record.id,
		organizationId: record.organizationId,
		caseId: record.caseId,
		sha256: record.sha256,
		byteSize: record.byteSize,
		contentType: record.contentType,
		status: record.status,
		batchId: record.batchId ?? null,
		sequence: record.sequence ?? null,
		sourceMessageId: record.sourceMessageId ?? null,
		summary:
			explicitSummary ??
			(typeof recordSummary === "object" && recordSummary !== null
				? recordSummary
				: null),
		storedAt: record.storedAt ?? null,
		verifiedAt: record.verifiedAt ?? null,
		failedAt: record.failedAt ?? null,
		failureReason: record.failureReason ?? null,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export async function attemptStorageCleanup(params: {
	storage: EvidenceStorage;
	objectKey: string;
	organizationId: string;
	caseId: string;
	evidenceId: string;
	requestId?: string;
	trigger: "put_failure" | "lifecycle_failure";
}): Promise<void> {
	try {
		await params.storage.deleteEvidence({
			objectKey: params.objectKey,
			organizationId: params.organizationId,
			caseId: params.caseId,
		});
	} catch {
		// Log cleanup failure with stable safe fields only:
		// No raw error messages, stacks, object keys, or evidence content
		logger.error("Storage cleanup compensation failed", {
			requestId: params.requestId,
			organizationId: params.organizationId,
			caseId: params.caseId,
			evidenceId: params.evidenceId,
			trigger: params.trigger,
		});
	}
}

async function recordUploadInitAudit(
	auditRepo: AuditRepository,
	params: {
		organizationId: string;
		actorUserId: string | null;
		evidence: EvidenceShell;
		requestId?: string;
	},
) {
	return recordAuditEvent(auditRepo, {
		organizationId: params.organizationId,
		actorUserId: params.actorUserId,
		action: "evidence.upload_init",
		resourceType: "evidence",
		resourceId: params.evidence.id,
		requestId: params.requestId,
		metadata: {
			caseId: params.evidence.caseId,
			sha256: params.evidence.sha256,
			byteSize: params.evidence.byteSize,
			contentType: params.evidence.contentType,
		},
	});
}

export async function recordCompletionAudit(
	auditRepo: AuditRepository,
	params: {
		organizationId: string;
		actorUserId: string | null;
		evidenceId: string;
		caseId: string;
		sha256: string;
		byteSize: number;
		status: string;
		requestId?: string;
	},
) {
	return recordAuditEvent(auditRepo, {
		organizationId: params.organizationId,
		actorUserId: params.actorUserId,
		action: "evidence.upload_complete",
		resourceType: "evidence",
		resourceId: params.evidenceId,
		requestId: params.requestId,
		metadata: {
			caseId: params.caseId,
			sha256: params.sha256,
			byteSize: params.byteSize,
			status: params.status,
		},
	});
}

export function validateAndSanitizeFilename(filename: string): string {
	const trimmed = filename.trim();
	if (trimmed.length === 0 || trimmed.length > 255) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Filename must be between 1 and 255 characters",
		});
	}
	if (
		trimmed.includes("/") ||
		trimmed.includes("\\") ||
		trimmed.includes("..") ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: detect control characters and null bytes in filenames
		/[\x00-\x1f\x7f]/.test(trimmed)
	) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Invalid filename: path traversal or illegal characters detected",
		});
	}
	if (!trimmed.toLowerCase().endsWith(".eml")) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Evidence filename must have a .eml extension",
		});
	}
	return trimmed;
}

const identifierSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9_-]+$/);
export const createUploadInput = z.object({
	caseId: identifierSchema,
	byteSize: z
		.number()
		.int("Byte size must be an integer")
		.min(1, "Evidence payload cannot be empty")
		.max(
			MAX_EML_BYTES,
			`Evidence exceeds maximum allowed size (${MAX_EML_BYTES} bytes)`,
		),
	sha256: z
		.string()
		.regex(
			/^[0-9a-fA-F]{64}$/,
			"Must be a valid 64-character hex SHA-256 digest",
		),
	filename: z.string().max(255).optional(),
	contentType: z
		.string()
		.refine((val) => val === "message/rfc822", {
			message: "Invalid content type: only message/rfc822 is supported",
		})
		.default("message/rfc822")
		.optional(),
	idempotencyKey: z.string().min(1).max(255).optional(),
});

export const completeUploadInput = z.object({
	caseId: identifierSchema,
	evidenceId: identifierSchema,
	body: z.string().min(1, "Evidence payload cannot be empty"),
	sha256: z
		.string()
		.regex(
			/^[0-9a-fA-F]{64}$/,
			"Must be a valid 64-character hex SHA-256 digest",
		)
		.optional(),
});

export const listEvidenceInput = z.object({
	caseId: identifierSchema,
	status: z.enum(["pending", "stored", "verified", "failed"]).optional(),
	limit: z.number().int().min(1).max(100).default(50).optional(),
	cursor: z
		.string()
		.max(1024)
		.refine((value) => decodeCursor(value) !== null, "Invalid cursor")
		.optional(),
});

export const listEvidenceOutputSchema = z.object({
	items: z.array(evidenceOutputSchema),
	nextCursor: z.string().nullable(),
});

export const getEvidenceInput = z.object({
	caseId: identifierSchema,
	evidenceId: identifierSchema,
});

export const evidenceRouter = {
	createUpload: investigatorProcedure
		.input(createUploadInput)
		.output(evidenceOutputSchema)
		.handler(async ({ context, input }) => {
			const caseRepo = context.repos?.cases ?? new DrizzleCaseRepository(db);
			const caseRecord = await caseRepo.getCase({
				organizationId: context.organizationId,
				caseId: input.caseId,
			});
			if (!caseRecord) {
				throw new NotFoundError("Case not found");
			}

			if (input.filename) {
				validateAndSanitizeFilename(input.filename);
			}

			const normalizedSha256 = input.sha256.toLowerCase();
			const evidenceRepo =
				context.repos?.evidence ?? new DrizzleEvidenceRepository(db);

			const auditRepo = context.repos?.audit ?? new DrizzleAuditRepository(db);
			const findByIdempotencyKey = async () => {
				if (!input.idempotencyKey) return undefined;
				const records = await evidenceRepo.listEvidence({
					organizationId: context.organizationId,
					caseId: input.caseId,
				});
				return records.find(
					(record) => record.idempotencyKey === input.idempotencyKey,
				);
			};
			const returnExisting = async (matching: EvidenceShell) => {
				if (
					matching.sha256 !== normalizedSha256 ||
					matching.byteSize !== input.byteSize
				) {
					throw new ConflictError(
						"Idempotent upload metadata does not match the existing evidence",
					);
				}
				await recordUploadInitAudit(auditRepo, {
					organizationId: context.organizationId,
					actorUserId: context.userId,
					evidence: matching,
					requestId: context.requestId,
				});
				return toEvidenceOutput(matching);
			};

			const existing = await findByIdempotencyKey();
			if (existing) return returnExisting(existing);

			let pending: EvidenceShell;
			try {
				pending = await evidenceRepo.createPending({
					id: `ev_${randomUUID()}`,
					organizationId: context.organizationId,
					caseId: input.caseId,
					objectKey: evidenceObjectKey({
						organizationId: context.organizationId,
						caseId: input.caseId,
						artifactId: randomUUID(),
					}),
					sha256: normalizedSha256,
					byteSize: input.byteSize,
					contentType: input.contentType ?? "message/rfc822",
					idempotencyKey: input.idempotencyKey ?? null,
				});
			} catch (error) {
				if (input.idempotencyKey && error instanceof DbConflictError) {
					const raced = await findByIdempotencyKey();
					if (raced) return returnExisting(raced);
				}
				throw error;
			}

			await recordUploadInitAudit(auditRepo, {
				organizationId: context.organizationId,
				actorUserId: context.userId,
				evidence: pending,
				requestId: context.requestId,
			});
			return toEvidenceOutput(pending);
		}),

	completeUpload: investigatorProcedure
		.input(completeUploadInput)
		.output(evidenceOutputSchema)
		.handler(async ({ context, input }) => {
			const caseRepo = context.repos?.cases ?? new DrizzleCaseRepository(db);
			const caseRecord = await caseRepo.getCase({
				organizationId: context.organizationId,
				caseId: input.caseId,
			});
			if (!caseRecord) {
				throw new NotFoundError("Case not found");
			}

			const maxDecodedBytes = MAX_EML_BYTES;
			const maxBase64Chars = Math.ceil(maxDecodedBytes / 3) * 4 + 16;
			const maxRawStringLength = Math.ceil(maxBase64Chars * 1.05) + 64;

			if (input.body.length > maxRawStringLength) {
				throw new PayloadTooLargeError(
					"Base64 payload exceeds maximum allowed size",
				);
			}

			const cleanBody = input.body.replace(/\s+/g, "");
			if (cleanBody.length === 0) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Evidence payload cannot be empty",
				});
			}

			if (cleanBody.length > maxBase64Chars) {
				throw new PayloadTooLargeError(
					"Base64 payload exceeds maximum allowed size",
				);
			}

			if (
				!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBody) ||
				cleanBody.length % 4 !== 0
			) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Invalid base64 payload",
				});
			}

			const buffer = Buffer.from(cleanBody, "base64");
			if (buffer.byteLength === 0) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Evidence payload cannot be empty",
				});
			}
			if (buffer.byteLength > maxDecodedBytes) {
				throw new PayloadTooLargeError(
					"Decoded evidence exceeds maximum size limit",
				);
			}

			const actualSha256 = createHash("sha256")
				.update(buffer)
				.digest("hex")
				.toLowerCase();
			if (input.sha256 && input.sha256.toLowerCase() !== actualSha256) {
				throw new ConflictError(
					"Payload SHA-256 does not match provided digest",
				);
			}

			const evidenceRepo =
				context.repos?.evidence ?? new DrizzleEvidenceRepository(db);
			const existing = await evidenceRepo.getEvidence({
				organizationId: context.organizationId,
				caseId: input.caseId,
				evidenceId: input.evidenceId,
			});
			if (!existing) {
				throw new NotFoundError("Evidence not found");
			}

			let verifiedRecord: EvidenceShell;

			if (existing.status === "verified") {
				if (
					existing.sha256 === actualSha256 &&
					existing.byteSize === buffer.byteLength
				) {
					verifiedRecord = existing;
				} else {
					throw new ConflictError(
						"Evidence is already verified and is immutable",
					);
				}
			} else if (existing.status === "failed") {
				throw new ConflictError(
					`Evidence upload has failed (${existing.failureReason ?? "unknown reason"}) and cannot be completed`,
				);
			} else if (
				existing.sha256 !== actualSha256 ||
				existing.byteSize !== buffer.byteLength
			) {
				await evidenceRepo.markFailed({
					organizationId: context.organizationId,
					caseId: input.caseId,
					evidenceId: input.evidenceId,
					failureReason:
						"Payload digest or size mismatch with registered metadata",
				});
				throw new ConflictError(
					"Decoded payload digest or size does not match registered metadata",
				);
			} else {
				const storage = context.storage ?? defaultEvidenceStorage;

				try {
					await storage.putEvidence({
						objectKey: existing.objectKey,
						organizationId: context.organizationId,
						caseId: input.caseId,
						body: buffer,
						sha256: actualSha256,
					});
				} catch (storageErr) {
					let storedObjectMatches = false;
					try {
						const stored = await storage.headEvidence({
							objectKey: existing.objectKey,
							organizationId: context.organizationId,
							caseId: input.caseId,
						});
						storedObjectMatches =
							stored?.byteSize === buffer.byteLength &&
							stored.sha256?.toLowerCase() === actualSha256 &&
							(!stored.contentType || stored.contentType === "message/rfc822");
					} catch {
						storedObjectMatches = false;
					}
					if (!storedObjectMatches) {
						await attemptStorageCleanup({
							storage,
							objectKey: existing.objectKey,
							organizationId: context.organizationId,
							caseId: input.caseId,
							evidenceId: input.evidenceId,
							requestId: context.requestId,
							trigger: "put_failure",
						});
						try {
							await evidenceRepo.markFailed({
								organizationId: context.organizationId,
								caseId: input.caseId,
								evidenceId: input.evidenceId,
								failureReason: "Storage write failed",
							});
						} catch {
							// Suppress secondary DB error during storage failure handling
						}
						throw new DependencyError(
							"Storage service write failed",
							"s3",
							undefined,
							{
								cause: storageErr,
							},
						);
					}
				}

				try {
					if (existing.status === "pending") {
						await evidenceRepo.markStored({
							organizationId: context.organizationId,
							caseId: input.caseId,
							evidenceId: input.evidenceId,
						});
					}
					verifiedRecord = await evidenceRepo.markVerified({
						organizationId: context.organizationId,
						caseId: input.caseId,
						evidenceId: input.evidenceId,
						sha256: actualSha256,
						byteSize: buffer.byteLength,
					});
				} catch (dbErr) {
					const recheck = await evidenceRepo.getEvidence({
						organizationId: context.organizationId,
						caseId: input.caseId,
						evidenceId: input.evidenceId,
					});

					if (
						recheck &&
						recheck.status === "verified" &&
						recheck.sha256 === actualSha256 &&
						recheck.byteSize === buffer.byteLength
					) {
						verifiedRecord = recheck;
					} else if (
						recheck &&
						recheck.status === "stored" &&
						recheck.sha256 === actualSha256 &&
						recheck.byteSize === buffer.byteLength
					) {
						try {
							verifiedRecord = await evidenceRepo.markVerified({
								organizationId: context.organizationId,
								caseId: input.caseId,
								evidenceId: input.evidenceId,
								sha256: actualSha256,
								byteSize: buffer.byteLength,
							});
						} catch (retryErr) {
							const finalCheck = await evidenceRepo.getEvidence({
								organizationId: context.organizationId,
								caseId: input.caseId,
								evidenceId: input.evidenceId,
							});
							if (
								finalCheck &&
								finalCheck.status === "verified" &&
								finalCheck.sha256 === actualSha256 &&
								finalCheck.byteSize === buffer.byteLength
							) {
								verifiedRecord = finalCheck;
							} else {
								await attemptStorageCleanup({
									storage,
									objectKey: existing.objectKey,
									organizationId: context.organizationId,
									caseId: input.caseId,
									evidenceId: input.evidenceId,
									requestId: context.requestId,
									trigger: "lifecycle_failure",
								});
								try {
									await evidenceRepo.markFailed({
										organizationId: context.organizationId,
										caseId: input.caseId,
										evidenceId: input.evidenceId,
										failureReason: "Database lifecycle transition failed",
									});
								} catch {
									// Suppress secondary DB error
								}
								throw retryErr;
							}
						}
					} else {
						await attemptStorageCleanup({
							storage,
							objectKey: existing.objectKey,
							organizationId: context.organizationId,
							caseId: input.caseId,
							evidenceId: input.evidenceId,
							requestId: context.requestId,
							trigger: "lifecycle_failure",
						});
						try {
							await evidenceRepo.markFailed({
								organizationId: context.organizationId,
								caseId: input.caseId,
								evidenceId: input.evidenceId,
								failureReason: "Database lifecycle transition failed",
							});
						} catch {
							// Suppress secondary DB error
						}
						throw dbErr;
					}
				}
			}

			const auditRepo = context.repos?.audit ?? new DrizzleAuditRepository(db);
			await recordCompletionAudit(auditRepo, {
				organizationId: context.organizationId,
				actorUserId: context.userId,
				evidenceId: verifiedRecord.id,
				caseId: input.caseId,
				sha256: actualSha256,
				byteSize: buffer.byteLength,
				status: verifiedRecord.status,
				requestId: context.requestId,
			});
			logger.info("evidence.upload_completed", {
				requestId: context.requestId,
				organizationId: context.organizationId,
				caseId: input.caseId,
				evidenceId: verifiedRecord.id,
				byteSize: buffer.byteLength,
			});

			const batchRepo =
				context.repos?.batches ??
				(context.repos?.evidence instanceof MemoryEvidenceRepository
					? new MemoryIngestionBatchRepository([])
					: new DrizzleIngestionBatchRepository(db));
			const analyzer = context.analyzerClient ?? defaultAnalyzerClient;
			const storage = context.storage ?? defaultEvidenceStorage;

			// Check if batch already exists for this container
			const caseBatches = await batchRepo.listBatchesByCase({
				organizationId: context.organizationId,
				caseId: input.caseId,
			});
			const existingBatch = caseBatches.find(
				(b) => b.containerEvidenceId === verifiedRecord.id,
			);

			if (existingBatch && existingBatch.status === "ready") {
				// Idempotent: re-uploading the same container digest returns existing batch and does not duplicate children
				return toEvidenceOutput(verifiedRecord);
			}

			let segmentation: SegmentationResult | null = null;
			try {
				segmentation = await analyzer.segmentEvidence({
					request: {
						organizationId: context.organizationId,
						caseId: input.caseId,
						evidenceId: verifiedRecord.id,
						objectKey: verifiedRecord.objectKey,
						sha256: verifiedRecord.sha256,
						byteSize: verifiedRecord.byteSize,
					},
					requestId: context.requestId,
				});
			} catch {
				// Safe degradation: Analyzer unavailable during segmentation degrades safely:
				// the container is kept as ordinary single evidence with a recorded reason, never lost.
				logger.warn(
					"Analyzer segmentation unavailable or failed; proceeding with single evidence",
					{
						requestId: context.requestId,
						organizationId: context.organizationId,
						caseId: input.caseId,
						evidenceId: verifiedRecord.id,
					},
				);
			}

			const segments = segmentation?.segments ?? [];

			if (
				!segmentation ||
				segmentation.messageCount <= 1 ||
				segmentation.containerFormat === "single" ||
				segments.length <= 1
			) {
				// Single message path: must not change, plus an upload_single batch record
				if (!existingBatch) {
					const singleBatch = await batchRepo.createBatch({
						organizationId: context.organizationId,
						caseId: input.caseId,
						source: "upload_single",
						status: "ready",
						containerEvidenceId: verifiedRecord.id,
						messageCount: 1,
						readyCount: 1,
						failedCount: 0,
						metadata: segmentation
							? { containerFormat: segmentation.containerFormat }
							: { degradationReason: "analyzer_segmentation_unavailable" },
					});

					await recordAuditEvent(auditRepo, {
						organizationId: context.organizationId,
						actorUserId: context.userId,
						action: "batch.created",
						resourceType: "batch",
						resourceId: singleBatch.id,
						requestId: context.requestId,
						metadata: { caseId: input.caseId, source: "upload_single" },
					});

					await recordAuditEvent(auditRepo, {
						organizationId: context.organizationId,
						actorUserId: context.userId,
						action: "batch.completed",
						resourceType: "batch",
						resourceId: singleBatch.id,
						requestId: context.requestId,
						metadata: { caseId: input.caseId, messageCount: 1, readyCount: 1 },
					});
				}
			} else {
				// Multi-message container ingestion path:
				const batch =
					existingBatch ??
					(await batchRepo.createBatch({
						organizationId: context.organizationId,
						caseId: input.caseId,
						source: "upload_container",
						status: "segmenting",
						containerEvidenceId: verifiedRecord.id,
						messageCount: segments.length,
						readyCount: 0,
						failedCount: 0,
						metadata: {
							containerFormat: segmentation.containerFormat,
							segmentCount: segments.length,
						},
					}));

				if (!existingBatch) {
					await recordAuditEvent(auditRepo, {
						organizationId: context.organizationId,
						actorUserId: context.userId,
						action: "batch.created",
						resourceType: "batch",
						resourceId: batch.id,
						requestId: context.requestId,
						metadata: {
							caseId: input.caseId,
							source: "upload_container",
							messageCount: segments.length,
						},
					});
				}

				const writtenChildKeys: string[] = [];
				try {
					const childRecords: {
						sequence: number;
						sourceMessageId: string | null;
						objectKey: string;
						sha256: string;
						byteSize: number;
					}[] = [];

					for (const segment of segments) {
						const childBuffer = buffer.subarray(
							segment.byteOffset,
							segment.byteOffset + segment.byteLength,
						);
						const childSha256 = createHash("sha256")
							.update(childBuffer)
							.digest("hex")
							.toLowerCase();
						const artifactId = `${verifiedRecord.id.replace(/[^A-Za-z0-9_-]/g, "_")}_child_${segment.index}`;
						const childObjectKey = evidenceObjectKey({
							organizationId: context.organizationId,
							caseId: input.caseId,
							artifactId,
						});

						await storage.putEvidence({
							objectKey: childObjectKey,
							organizationId: context.organizationId,
							caseId: input.caseId,
							body: childBuffer,
							sha256: childSha256,
						});
						writtenChildKeys.push(childObjectKey);

						childRecords.push({
							sequence: segment.index,
							sourceMessageId: segment.summary?.messageId ?? null,
							objectKey: childObjectKey,
							sha256: childSha256,
							byteSize: childBuffer.byteLength,
						});
					}

					// Idempotent child creation: check existing children to avoid duplicates
					const existingChildren = await evidenceRepo.listEvidenceByBatch({
						organizationId: context.organizationId,
						batchId: batch.id,
					});
					const existingSeqs = new Set(existingChildren.map((c) => c.sequence));

					for (const child of childRecords) {
						if (!existingSeqs.has(child.sequence)) {
							const createdChild = await evidenceRepo.createVerified({
								organizationId: context.organizationId,
								caseId: input.caseId,
								batchId: batch.id,
								sequence: child.sequence,
								sourceMessageId: child.sourceMessageId,
								objectKey: child.objectKey,
								sha256: child.sha256,
								byteSize: child.byteSize,
								contentType: "message/rfc822",
							});

							await recordAuditEvent(auditRepo, {
								organizationId: context.organizationId,
								actorUserId: context.userId,
								action: "evidence.child_registered",
								resourceType: "evidence",
								resourceId: createdChild.id,
								requestId: context.requestId,
								metadata: {
									caseId: input.caseId,
									batchId: batch.id,
									sequence: child.sequence,
									sourceMessageId: child.sourceMessageId,
								},
							});
						}
					}

					await batchRepo.transitionStatus({
						organizationId: context.organizationId,
						batchId: batch.id,
						status: "ready",
						metadata: {
							containerFormat: segmentation.containerFormat,
							childCount: childRecords.length,
						},
					});
					await batchRepo.incrementCounts({
						organizationId: context.organizationId,
						batchId: batch.id,
						readyIncrement: childRecords.length,
					});

					await recordAuditEvent(auditRepo, {
						organizationId: context.organizationId,
						actorUserId: context.userId,
						action: "evidence.container_segmented",
						resourceType: "evidence",
						resourceId: verifiedRecord.id,
						requestId: context.requestId,
						metadata: {
							caseId: input.caseId,
							batchId: batch.id,
							containerFormat: segmentation.containerFormat,
							childCount: childRecords.length,
						},
					});

					await recordAuditEvent(auditRepo, {
						organizationId: context.organizationId,
						actorUserId: context.userId,
						action: "batch.completed",
						resourceType: "batch",
						resourceId: batch.id,
						requestId: context.requestId,
						metadata: {
							caseId: input.caseId,
							messageCount: childRecords.length,
							readyCount: childRecords.length,
						},
					});
				} catch (childErr) {
					// Storage or registration failure: cleanup written child objects and mark batch failed
					for (const key of writtenChildKeys) {
						await attemptStorageCleanup({
							storage,
							objectKey: key,
							organizationId: context.organizationId,
							caseId: input.caseId,
							evidenceId: verifiedRecord.id,
							requestId: context.requestId,
							trigger: "put_failure",
						});
					}

					try {
						await batchRepo.transitionStatus({
							organizationId: context.organizationId,
							batchId: batch.id,
							status: "failed",
							failureReason: "Container segmentation processing failed",
						});
					} catch {
						// Suppress secondary DB error
					}

					await recordAuditEvent(auditRepo, {
						organizationId: context.organizationId,
						actorUserId: context.userId,
						action: "batch.failed",
						resourceType: "batch",
						resourceId: batch.id,
						requestId: context.requestId,
						metadata: {
							caseId: input.caseId,
							reason: "Container segmentation processing failed",
						},
					});

					throw childErr;
				}
			}

			return toEvidenceOutput(verifiedRecord);
		}),

	list: viewerProcedure
		.input(listEvidenceInput)
		.output(listEvidenceOutputSchema)
		.handler(async ({ context, input }) => {
			const caseRepo = context.repos?.cases ?? new DrizzleCaseRepository(db);
			const caseRecord = await caseRepo.getCase({
				organizationId: context.organizationId,
				caseId: input.caseId,
			});
			if (!caseRecord) {
				throw new NotFoundError("Case not found");
			}

			const limit = input.limit ?? 50;
			const evidenceRepo =
				context.repos?.evidence ?? new DrizzleEvidenceRepository(db);
			const records = await evidenceRepo.listEvidence({
				organizationId: context.organizationId,
				caseId: input.caseId,
				status: input.status,
				limit: limit + 1,
				cursor: input.cursor,
			});
			const hasMore = records.length > limit;
			const page = hasMore ? records.slice(0, limit) : records;
			const last = page.at(-1);
			return {
				items: page.map((rec) => toEvidenceOutput(rec)),
				nextCursor:
					hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
			};
		}),

	listByBatch: viewerProcedure
		.input(
			z.object({
				batchId: z.string().min(1),
				caseId: z.string().optional(),
				limit: z.number().int().min(1).max(100).default(50).optional(),
				cursor: z.string().nullable().optional(),
			}),
		)
		.output(listEvidenceOutputSchema)
		.handler(async ({ context, input }) => {
			const evidenceRepo =
				context.repos?.evidence ?? new DrizzleEvidenceRepository(db);
			const batchRepo =
				context.repos?.batches ??
				(context.repos?.evidence instanceof MemoryEvidenceRepository
					? new MemoryIngestionBatchRepository([])
					: new DrizzleIngestionBatchRepository(db));

			const batch = await batchRepo.getBatch({
				organizationId: context.organizationId,
				batchId: input.batchId,
				caseId: input.caseId,
			});
			if (!batch) {
				throw new NotFoundError("Batch not found");
			}

			const limit = input.limit ?? 50;
			const records = await evidenceRepo.listEvidenceByBatch({
				organizationId: context.organizationId,
				batchId: input.batchId,
				caseId: input.caseId,
				limit: limit + 1,
				cursor: input.cursor ?? null,
			});

			const hasMore = records.length > limit;
			const page = hasMore ? records.slice(0, limit) : records;
			const last = page.at(-1);

			let summaryMap: Map<string, EvidenceSummary> | undefined;
			if (context.repos?.analysisRuns) {
				try {
					const runs = await context.repos.analysisRuns.listAnalysisRuns({
						organizationId: context.organizationId,
						caseId: batch.caseId,
					});
					summaryMap = new Map();
					for (const run of runs) {
						if (run.evidenceId && run.resultSnapshot) {
							const snap = run.resultSnapshot as Record<string, unknown>;
							const headers = (snap.headers ?? []) as Array<{
								name?: string;
								value?: string;
							}>;
							const fromHdr = headers.find(
								(h) => h.name?.toLowerCase() === "from",
							)?.value;
							const subjectHdr = headers.find(
								(h) => h.name?.toLowerCase() === "subject",
							)?.value;
							const dateHdr = headers.find(
								(h) => h.name?.toLowerCase() === "date",
							)?.value;

							summaryMap.set(run.evidenceId, {
								from: fromHdr ?? null,
								subject: subjectHdr ?? null,
								date: dateHdr ?? null,
							});
						}
					}
				} catch {
					// Fallback to null summaries on error
				}
			}

			return {
				items: page.map((rec) =>
					toEvidenceOutput(rec, summaryMap?.get(rec.id)),
				),
				nextCursor:
					hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
			};
		}),

	get: viewerProcedure
		.input(getEvidenceInput)
		.output(evidenceOutputSchema.nullable())
		.handler(async ({ context, input }) => {
			const caseRepo = context.repos?.cases ?? new DrizzleCaseRepository(db);
			const caseRecord = await caseRepo.getCase({
				organizationId: context.organizationId,
				caseId: input.caseId,
			});
			if (!caseRecord) {
				throw new NotFoundError("Case not found");
			}

			const evidenceRepo =
				context.repos?.evidence ?? new DrizzleEvidenceRepository(db);
			const record = await evidenceRepo.getEvidence({
				organizationId: context.organizationId,
				caseId: input.caseId,
				evidenceId: input.evidenceId,
			});
			return record ? toEvidenceOutput(record) : null;
		}),
};
