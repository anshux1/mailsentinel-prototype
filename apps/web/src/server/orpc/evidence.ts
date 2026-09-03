import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
	type AuditRepository,
	DrizzleAuditRepository,
	DrizzleCaseRepository,
	DrizzleEvidenceRepository,
	decodeCursor,
	type EvidenceShell,
	encodeCursor,
} from "@mailsentinel/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
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

export const evidenceOutputSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	caseId: z.string(),
	sha256: z.string(),
	byteSize: z.number().int(),
	contentType: z.string(),
	status: z.enum(["pending", "stored", "verified", "failed"]),
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

export function toEvidenceOutput(record: EvidenceShell): EvidenceOutput {
	return {
		id: record.id,
		organizationId: record.organizationId,
		caseId: record.caseId,
		sha256: record.sha256,
		byteSize: record.byteSize,
		contentType: record.contentType,
		status: record.status,
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

export const createUploadInput = z.object({
	caseId: z.string().min(1, "Case ID is required"),
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
	caseId: z.string().min(1, "Case ID is required"),
	evidenceId: z.string().min(1, "Evidence ID is required"),
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
	caseId: z.string().min(1, "Case ID is required"),
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
	caseId: z.string().min(1, "Case ID is required"),
	evidenceId: z.string().min(1, "Evidence ID is required"),
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

			if (input.idempotencyKey) {
				const existingList = await evidenceRepo.listEvidence({
					organizationId: context.organizationId,
					caseId: input.caseId,
				});
				const matching = existingList.find(
					(e) => e.idempotencyKey === input.idempotencyKey,
				);
				if (matching) {
					if (
						matching.sha256 === normalizedSha256 &&
						matching.byteSize === input.byteSize
					) {
						return toEvidenceOutput(matching);
					}
					throw new ConflictError(
						`Evidence with idempotencyKey '${input.idempotencyKey}' already exists with differing metadata`,
					);
				}
			}

			const artifactId = randomUUID();
			const evidenceId = `ev_${randomUUID()}`;
			const objectKey = evidenceObjectKey({
				organizationId: context.organizationId,
				caseId: input.caseId,
				artifactId,
			});

			const pending = await evidenceRepo.createPending({
				id: evidenceId,
				organizationId: context.organizationId,
				caseId: input.caseId,
				objectKey,
				sha256: normalizedSha256,
				byteSize: input.byteSize,
				contentType: input.contentType ?? "message/rfc822",
				idempotencyKey: input.idempotencyKey ?? null,
			});

			const auditRepo = context.repos?.audit ?? new DrizzleAuditRepository(db);
			await recordAuditEvent(auditRepo, {
				organizationId: context.organizationId,
				actorUserId: context.userId,
				action: "evidence.upload_init",
				resourceType: "evidence",
				resourceId: pending.id,
				requestId: context.requestId,
				metadata: {
					caseId: input.caseId,
					sha256: normalizedSha256,
					byteSize: input.byteSize,
					contentType: pending.contentType,
				},
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
				items: page.map(toEvidenceOutput),
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
