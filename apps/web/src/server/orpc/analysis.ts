import "server-only";

import { createHash } from "node:crypto";
import type { AnalysisIntakeRequest } from "@mailsentinel/contracts";
import {
	type AnalysisRunRepository,
	type AnalysisRunShell,
	ConflictError as DbConflictError,
	DrizzleAnalysisRunRepository,
	DrizzleAuditRepository,
	DrizzleCaseRepository,
	DrizzleEvidenceRepository,
	decodeCursor,
	encodeCursor,
	executeTransaction,
} from "@mailsentinel/db";
import { z } from "zod";
import {
	AnalyzerAuthError,
	AnalyzerTimeoutError,
	AnalyzerUnavailableError,
	AnalyzerValidationError,
	defaultAnalyzerClient,
} from "@/server/analyzer-client";
import { recordAuditEvent } from "@/server/audit";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import {
	analysisResultOutputSchema,
	analysisStatusOutputSchema,
	formatCompletedAnalysisResult,
} from "./analysis-schemas";
import type { RpcContext, TransactionExecutor } from "./context";
import { ConflictError, DependencyError, NotFoundError } from "./errors";
import {
	investigatorProcedure,
	ownerProcedure,
	viewerProcedure,
} from "./middleware";

const identifierSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9_-]+$/);

export const startAnalysisInput = z
	.object({
		caseId: identifierSchema,
		evidenceId: identifierSchema,
		idempotencyKey: z
			.string()
			.min(1, "Idempotency key must not be empty")
			.max(255, "Idempotency key must not exceed 255 characters")
			.optional(),
	})
	.strict();

export const retryAnalysisInput = z
	.object({
		analysisRunId: identifierSchema,
		caseId: identifierSchema.optional(),
	})
	.strict();

export const analysisRunOutputSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	caseId: z.string(),
	evidenceId: z.string().nullable().optional(),
	status: z.enum([
		"accepted",
		"queued",
		"processing",
		"completed",
		"deferred",
		"failed",
	]),
	phase: z.string().nullable().optional(),
	progress: z.number().nullable().optional(),
	failureCode: z.string().nullable().optional(),
	failureMessage: z.string().nullable().optional(),
	retryable: z.boolean(),
	attempts: z.number().int(),
	queuedAt: z.union([z.date(), z.string()]).nullable().optional(),
	startedAt: z.union([z.date(), z.string()]).nullable().optional(),
	completedAt: z.union([z.date(), z.string()]).nullable().optional(),
	failedAt: z.union([z.date(), z.string()]).nullable().optional(),
	createdAt: z.union([z.date(), z.string()]),
	updatedAt: z.union([z.date(), z.string()]),
});

export type AnalysisRunOutput = z.infer<typeof analysisRunOutputSchema>;

export function toAnalysisRunOutput(
	record: AnalysisRunShell,
): AnalysisRunOutput {
	return {
		id: record.id,
		organizationId: record.organizationId,
		caseId: record.caseId,
		evidenceId: record.evidenceId ?? null,
		status: record.status,
		phase: record.phase ?? null,
		progress: record.progress ?? null,
		failureCode: record.failureCode ?? null,
		failureMessage: record.failureMessage ?? null,
		retryable: record.retryable,
		attempts: record.attempts,
		queuedAt: record.queuedAt ?? null,
		startedAt: record.startedAt ?? null,
		completedAt: record.completedAt ?? null,
		failedAt: record.failedAt ?? null,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export const listAnalysisRunsInput = z.object({
	caseId: identifierSchema.optional(),
	evidenceId: identifierSchema.optional(),
	status: z
		.enum([
			"accepted",
			"queued",
			"processing",
			"completed",
			"deferred",
			"failed",
		])
		.optional(),
	verdict: z.enum(["unknown", "benign", "suspicious", "malicious"]).optional(),
	limit: z.number().int().min(1).max(100).default(50).optional(),
	cursor: z
		.string()
		.max(1024)
		.refine((value) => decodeCursor(value) !== null, "Invalid cursor")
		.optional(),
});

export const listAnalysisRunsOutputSchema = z.object({
	items: z.array(analysisRunOutputSchema),
	nextCursor: z.string().nullable(),
});

export const getAnalysisStatusInput = z.object({
	analysisRunId: identifierSchema,
	caseId: identifierSchema.optional(),
});

export const getAnalysisResultInput = z.object({
	analysisRunId: identifierSchema,
	caseId: identifierSchema.optional(),
});

function getTxExecutor(context: RpcContext): TransactionExecutor {
	if (context.executeTx) {
		return context.executeTx;
	}
	if (
		context.repos &&
		typeof (context.repos as { transaction?: TransactionExecutor })
			.transaction === "function"
	) {
		return (
			context.repos as { transaction: TransactionExecutor }
		).transaction.bind(context.repos);
	}
	return (fn) => executeTransaction(db, fn);
}

async function reconcileDispatchedRun(
	analysisRepo: AnalysisRunRepository,
	organizationId: string,
	analysisRunId: string,
	caseId: string,
): Promise<AnalysisRunShell> {
	const canonicalRun = await analysisRepo.getAnalysisRun({
		organizationId,
		analysisRunId,
		caseId,
	});
	if (!canonicalRun) {
		throw new NotFoundError("Analysis run not found");
	}

	if (["queued", "processing", "completed"].includes(canonicalRun.status)) {
		return canonicalRun;
	}

	if (canonicalRun.status === "accepted") {
		try {
			return await analysisRepo.transitionStatus({
				organizationId,
				analysisRunId,
				fromStatus: "accepted",
				toStatus: "queued",
				phase: "queued",
				progress: 0,
				queuedAt: new Date(),
			});
		} catch (transitionErr) {
			const recheck = await analysisRepo.getAnalysisRun({
				organizationId,
				analysisRunId,
				caseId,
			});
			if (
				recheck &&
				["queued", "processing", "completed"].includes(recheck.status)
			) {
				return recheck;
			}
			throw transitionErr;
		}
	}

	return canonicalRun;
}

export const analysisRouter = {
	start: investigatorProcedure
		.input(startAnalysisInput)
		.output(analysisRunOutputSchema)
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
			const evidence = await evidenceRepo.getEvidence({
				organizationId: context.organizationId,
				caseId: input.caseId,
				evidenceId: input.evidenceId,
			});
			if (!evidence) {
				throw new NotFoundError("Evidence not found");
			}

			if (evidence.status !== "verified") {
				throw new ConflictError(
					`Evidence '${input.evidenceId}' is in status '${evidence.status}'; only verified immutable evidence can be analyzed`,
				);
			}

			const analysisRepo =
				context.repos?.analysisRuns ?? new DrizzleAnalysisRunRepository(db);
			const auditRepo = context.repos?.audit ?? new DrizzleAuditRepository(db);

			// Deterministic server-owned idempotency key when browser omits one
			const effectiveIdempotencyKey =
				input.idempotencyKey ??
				`srv_${createHash("sha256")
					.update(`${context.organizationId}:${caseRecord.id}:${evidence.id}`)
					.digest("hex")}`;

			// Idempotency check 1: Matching idempotencyKey
			const existingRuns = await analysisRepo.listAnalysisRuns({
				organizationId: context.organizationId,
				caseId: input.caseId,
			});
			const matching = existingRuns.find(
				(r) => r.idempotencyKey === effectiveIdempotencyKey,
			);
			if (matching) {
				if (matching.evidenceId === input.evidenceId) {
					return toAnalysisRunOutput(matching);
				}
				throw new ConflictError(
					`Analysis run with idempotencyKey '${effectiveIdempotencyKey}' already exists with differing evidence`,
				);
			}

			// Idempotency check 2: Prevent duplicate active run on same evidence
			const runsForEvidence = await analysisRepo.listAnalysisRuns({
				organizationId: context.organizationId,
				caseId: input.caseId,
				evidenceId: input.evidenceId,
			});
			const activeRun = runsForEvidence.find((r) =>
				["accepted", "queued", "processing"].includes(r.status),
			);
			if (activeRun) {
				return toAnalysisRunOutput(activeRun);
			}

			// Transactionally create accepted run + audit record
			const txExecutor = getTxExecutor(context);
			let run: AnalysisRunShell;

			try {
				run = await txExecutor(async (txRepos) => {
					const createdRun = await txRepos.analysisRuns.createAnalysisRun({
						organizationId: context.organizationId,
						caseId: input.caseId,
						evidenceId: input.evidenceId,
						status: "accepted",
						idempotencyKey: effectiveIdempotencyKey,
					});

					await recordAuditEvent(txRepos.audit, {
						organizationId: context.organizationId,
						actorUserId: context.userId,
						action: "analysis.start",
						resourceType: "analysis_run",
						resourceId: createdRun.id,
						requestId: context.requestId,
						metadata: {
							caseId: input.caseId,
							evidenceId: input.evidenceId,
							status: createdRun.status,
						},
					});

					return createdRun;
				});
			} catch (txErr) {
				// Handle concurrency race on duplicate idempotency key
				if (txErr instanceof DbConflictError) {
					const runs = await analysisRepo.listAnalysisRuns({
						organizationId: context.organizationId,
						caseId: input.caseId,
					});
					const matching = runs.find(
						(r) => r.idempotencyKey === effectiveIdempotencyKey,
					);
					if (matching) {
						if (matching.evidenceId === input.evidenceId) {
							return toAnalysisRunOutput(matching);
						}
						throw new ConflictError(
							`Analysis run with idempotencyKey '${effectiveIdempotencyKey}' already exists with differing evidence`,
						);
					}
				}
				throw txErr;
			}

			// Build generated AnalysisIntakeRequest exclusively from authoritative DB metadata
			const requestedAt = new Date().toISOString();
			const intakeRequest: AnalysisIntakeRequest = {
				analysisRunId: run.id,
				organizationId: context.organizationId,
				caseId: run.caseId,
				requestedAt,
				artifact: {
					objectKey: evidence.objectKey,
					sha256: evidence.sha256,
					byteSize: evidence.byteSize,
					digestAlgorithm: "sha256",
				},
			};

			// Dispatch private analyzer
			const analyzer = context.analyzerClient ?? defaultAnalyzerClient;

			try {
				await analyzer.dispatchIntake({
					request: intakeRequest,
					requestId: context.requestId,
				});
			} catch (analyzerErr: unknown) {
				let failureCode = "analyzer_unavailable";
				let failureMessage = "Analyzer service unavailable";
				let safeError: Error;

				if (analyzerErr instanceof AnalyzerAuthError) {
					failureCode = "analyzer_unauthorized";
					failureMessage = "Analyzer service authentication failed";
					safeError = new DependencyError(
						"Analyzer service authentication failed",
						"analyzer",
					);
				} else if (analyzerErr instanceof AnalyzerValidationError) {
					failureCode = "intake_invalid";
					failureMessage = "Analyzer rejected intake payload as invalid";
					safeError = new DependencyError(
						"Analyzer rejected intake payload as invalid",
						"analyzer",
					);
				} else if (analyzerErr instanceof AnalyzerTimeoutError) {
					failureCode = "analyzer_timeout";
					failureMessage = "Analyzer service request timed out";
					safeError = new DependencyError(
						"Analyzer service request timed out",
						"analyzer",
					);
				} else if (analyzerErr instanceof AnalyzerUnavailableError) {
					failureCode = "analyzer_unavailable";
					failureMessage = "Analyzer service is unavailable";
					safeError = new DependencyError(
						"Analyzer service is unavailable",
						"analyzer",
					);
				} else {
					failureCode = "analyzer_unavailable";
					failureMessage = "Analyzer service dispatch failed";
					safeError = new DependencyError(
						"Analyzer service dispatch failed",
						"analyzer",
					);
				}

				// Retain recoverable DB state: transition active status -> failed (retryable: true)
				// Do not clobber processing or completed if worker progressed
				let didFail = false;
				try {
					await analysisRepo.transitionStatus({
						organizationId: context.organizationId,
						analysisRunId: run.id,
						fromStatus: ["accepted", "queued"],
						toStatus: "failed",
						retryable: true,
						failureCode,
						failureMessage,
						failedAt: new Date(),
					});
					didFail = true;
				} catch {
					// Suppress secondary transition error
				}

				if (didFail) {
					try {
						await recordAuditEvent(auditRepo, {
							organizationId: context.organizationId,
							actorUserId: context.userId,
							action: "analysis.failed",
							resourceType: "analysis_run",
							resourceId: run.id,
							requestId: context.requestId,
							metadata: {
								caseId: run.caseId,
								evidenceId: input.evidenceId,
								failureCode,
							},
						});
					} catch {
						// Suppress secondary audit error
					}
				}

				throw safeError;
			}

			// Reconcile canonical tenant run status after dispatch
			const finalRun = await reconcileDispatchedRun(
				analysisRepo,
				context.organizationId,
				run.id,
				run.caseId,
			);

			await recordAuditEvent(auditRepo, {
				organizationId: context.organizationId,
				actorUserId: context.userId,
				action: "analysis.intake_dispatched",
				resourceType: "analysis_run",
				resourceId: finalRun.id,
				requestId: context.requestId,
				metadata: {
					caseId: finalRun.caseId,
					evidenceId: input.evidenceId,
					status: finalRun.status,
				},
			});
			logger.info("analysis.start_dispatched", {
				requestId: context.requestId,
				organizationId: context.organizationId,
				caseId: finalRun.caseId,
				analysisRunId: finalRun.id,
				status: finalRun.status,
			});

			return toAnalysisRunOutput(finalRun);
		}),

	retry: ownerProcedure
		.input(retryAnalysisInput)
		.output(analysisRunOutputSchema)
		.handler(async ({ context, input }) => {
			const analysisRepo =
				context.repos?.analysisRuns ?? new DrizzleAnalysisRunRepository(db);
			const auditRepo = context.repos?.audit ?? new DrizzleAuditRepository(db);
			const evidenceRepo =
				context.repos?.evidence ?? new DrizzleEvidenceRepository(db);

			// Authoritative lookup
			const run = await analysisRepo.getAnalysisRun({
				organizationId: context.organizationId,
				analysisRunId: input.analysisRunId,
				caseId: input.caseId,
			});
			if (!run) {
				throw new NotFoundError("Analysis run not found");
			}

			// Policy and state checks
			if (run.status !== "failed" && run.status !== "deferred") {
				throw new ConflictError(
					`Cannot retry analysis run '${input.analysisRunId}' with status '${run.status}'; only failed or deferred runs can be retried`,
				);
			}

			if (!run.retryable) {
				throw new ConflictError(
					`Analysis run '${input.analysisRunId}' is not marked as retryable`,
				);
			}

			if (run.attempts >= 3) {
				throw new ConflictError(
					`Maximum retry attempts (3) exceeded for analysis run '${input.analysisRunId}'`,
				);
			}

			if (!run.evidenceId) {
				throw new ConflictError(
					`Analysis run '${input.analysisRunId}' has no associated evidence record`,
				);
			}

			const evidence = await evidenceRepo.getEvidence({
				organizationId: context.organizationId,
				caseId: run.caseId,
				evidenceId: run.evidenceId,
			});
			if (!evidence || evidence.status !== "verified") {
				throw new ConflictError(
					`Associated evidence '${run.evidenceId}' is not verified or no longer exists`,
				);
			}

			// Transition to queued and increment attempts
			const retriedRun = await analysisRepo.retryAnalysisRun({
				organizationId: context.organizationId,
				analysisRunId: run.id,
				maxAttempts: 3,
			});

			await recordAuditEvent(auditRepo, {
				organizationId: context.organizationId,
				actorUserId: context.userId,
				action: "analysis.retry",
				resourceType: "analysis_run",
				resourceId: retriedRun.id,
				requestId: context.requestId,
				metadata: {
					caseId: retriedRun.caseId,
					evidenceId: run.evidenceId,
					attempts: String(retriedRun.attempts),
				},
			});

			// Re-dispatch authoritative data to analyzer
			const requestedAt = new Date().toISOString();
			const intakeRequest: AnalysisIntakeRequest = {
				analysisRunId: retriedRun.id,
				organizationId: context.organizationId,
				caseId: retriedRun.caseId,
				requestedAt,
				artifact: {
					objectKey: evidence.objectKey,
					sha256: evidence.sha256,
					byteSize: evidence.byteSize,
					digestAlgorithm: "sha256",
				},
			};

			const analyzer = context.analyzerClient ?? defaultAnalyzerClient;

			try {
				await analyzer.dispatchIntake({
					request: intakeRequest,
					requestId: context.requestId,
				});
			} catch (analyzerErr: unknown) {
				let failureCode = "analyzer_unavailable";
				let failureMessage = "Analyzer service unavailable during retry";
				let safeError: Error;

				if (analyzerErr instanceof AnalyzerAuthError) {
					failureCode = "analyzer_unauthorized";
					failureMessage = "Analyzer service authentication failed";
					safeError = new DependencyError(
						"Analyzer service authentication failed",
						"analyzer",
					);
				} else if (analyzerErr instanceof AnalyzerValidationError) {
					failureCode = "intake_invalid";
					failureMessage = "Analyzer rejected intake payload as invalid";
					safeError = new DependencyError(
						"Analyzer rejected intake payload as invalid",
						"analyzer",
					);
				} else if (analyzerErr instanceof AnalyzerTimeoutError) {
					failureCode = "analyzer_timeout";
					failureMessage = "Analyzer service request timed out";
					safeError = new DependencyError(
						"Analyzer service request timed out",
						"analyzer",
					);
				} else if (analyzerErr instanceof AnalyzerUnavailableError) {
					failureCode = "analyzer_unavailable";
					failureMessage = "Analyzer service is unavailable";
					safeError = new DependencyError(
						"Analyzer service is unavailable",
						"analyzer",
					);
				} else {
					failureCode = "analyzer_unavailable";
					failureMessage = "Analyzer redispatch failed";
					safeError = new DependencyError(
						"Analyzer redispatch failed",
						"analyzer",
					);
				}

				let didFail = false;
				try {
					await analysisRepo.transitionStatus({
						organizationId: context.organizationId,
						analysisRunId: retriedRun.id,
						fromStatus: ["accepted", "queued"],
						toStatus: "failed",
						retryable: true,
						failureCode,
						failureMessage,
						failedAt: new Date(),
					});
					didFail = true;
				} catch {
					// Suppress secondary transition error
				}

				if (didFail) {
					try {
						await recordAuditEvent(auditRepo, {
							organizationId: context.organizationId,
							actorUserId: context.userId,
							action: "analysis.failed",
							resourceType: "analysis_run",
							resourceId: retriedRun.id,
							requestId: context.requestId,
							metadata: {
								caseId: retriedRun.caseId,
								evidenceId: run.evidenceId,
								failureCode,
								attempts: String(retriedRun.attempts),
							},
						});
					} catch {
						// Suppress secondary audit error
					}
				}

				throw safeError;
			}

			// Reconcile canonical tenant run status after retry dispatch
			const finalRun = await reconcileDispatchedRun(
				analysisRepo,
				context.organizationId,
				retriedRun.id,
				retriedRun.caseId,
			);

			await recordAuditEvent(auditRepo, {
				organizationId: context.organizationId,
				actorUserId: context.userId,
				action: "analysis.intake_dispatched",
				resourceType: "analysis_run",
				resourceId: finalRun.id,
				requestId: context.requestId,
				metadata: {
					caseId: finalRun.caseId,
					evidenceId: run.evidenceId,
					status: finalRun.status,
				},
			});
			logger.info("analysis.retry_dispatched", {
				requestId: context.requestId,
				organizationId: context.organizationId,
				caseId: finalRun.caseId,
				analysisRunId: finalRun.id,
				attempts: finalRun.attempts,
				status: finalRun.status,
			});

			return toAnalysisRunOutput(finalRun);
		}),

	list: viewerProcedure
		.input(listAnalysisRunsInput)
		.output(listAnalysisRunsOutputSchema)
		.handler(async ({ context, input }) => {
			const boundedLimit = Math.min(input.limit ?? 50, 100);
			const analysisRepo =
				context.repos?.analysisRuns ?? new DrizzleAnalysisRunRepository(db);
			const records = await analysisRepo.listAnalysisRuns({
				organizationId: context.organizationId,
				caseId: input.caseId,
				evidenceId: input.evidenceId,
				status: input.status,
				verdict: input.verdict,
				limit: boundedLimit + 1,
				cursor: input.cursor,
			});

			const hasMore = records.length > boundedLimit;
			const items = hasMore ? records.slice(0, boundedLimit) : records;
			const lastItem = items[items.length - 1];
			const nextCursor =
				hasMore && lastItem
					? encodeCursor(lastItem.createdAt, lastItem.id)
					: null;

			return {
				items: items.map(toAnalysisRunOutput),
				nextCursor,
			};
		}),

	getStatus: viewerProcedure
		.input(getAnalysisStatusInput)
		.output(analysisStatusOutputSchema)
		.handler(async ({ context, input }) => {
			const analysisRepo =
				context.repos?.analysisRuns ?? new DrizzleAnalysisRunRepository(db);
			const status = await analysisRepo.getAnalysisStatus({
				organizationId: context.organizationId,
				analysisRunId: input.analysisRunId,
			});
			if (!status) {
				throw new NotFoundError("Analysis run not found");
			}
			if (input.caseId && status.caseId !== input.caseId) {
				throw new NotFoundError("Analysis run not found");
			}

			const failure = status.failureCode
				? {
						code: status.failureCode,
						message: status.failureMessage ?? "Analysis run failed",
						retryable: status.retryable,
						requestId: null,
					}
				: null;

			return {
				id: status.id,
				analysisRunId: status.id,
				organizationId: status.organizationId,
				caseId: status.caseId,
				status: status.status,
				phase: status.phase ?? null,
				progress: status.progress ?? null,
				failureCode: status.failureCode ?? null,
				failureMessage: status.failureMessage ?? null,
				retryable: status.retryable,
				attempts: status.attempts,
				queuedAt: status.queuedAt ?? null,
				startedAt: status.startedAt ?? null,
				completedAt: status.completedAt ?? null,
				failedAt: status.failedAt ?? null,
				updatedAt: status.updatedAt,
				failure,
			};
		}),

	getResult: viewerProcedure
		.input(getAnalysisResultInput)
		.output(analysisResultOutputSchema)
		.handler(async ({ context, input }) => {
			const analysisRepo =
				context.repos?.analysisRuns ?? new DrizzleAnalysisRunRepository(db);
			const run = await analysisRepo.getAnalysisRun({
				organizationId: context.organizationId,
				analysisRunId: input.analysisRunId,
				caseId: input.caseId,
			});
			if (!run) {
				throw new NotFoundError("Analysis run not found");
			}

			if (run.status !== "completed") {
				return {
					ready: false as const,
					status: run.status,
					analysisRunId: run.id,
					organizationId: run.organizationId,
					caseId: run.caseId,
					phase: run.phase ?? null,
					progress: run.progress ?? null,
					failureCode: run.failureCode ?? null,
					failureMessage: run.failureMessage ?? null,
					retryable: run.retryable,
					attempts: run.attempts,
					queuedAt: run.queuedAt ?? null,
					startedAt: run.startedAt ?? null,
					failedAt: run.failedAt ?? null,
					updatedAt: run.updatedAt,
					createdAt: run.createdAt,
				};
			}

			const snapshot = (run.resultSnapshot as Record<string, unknown>) ?? {};
			return formatCompletedAnalysisResult(run, snapshot);
		}),
};
