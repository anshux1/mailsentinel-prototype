import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	ConflictError,
	createDb,
	createDrizzleRepositories,
	createEvidenceWithRunAndAudit,
	DependencyError,
	executeTransaction,
	InvalidStateError,
	NotFoundError,
	type Repositories,
} from "./index";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel";

describe("PostgreSQL repository integration tests", () => {
	let sql: postgres.Sql;
	let db: ReturnType<typeof createDb>;
	let repos: Repositories;

	const uid = randomUUID().replace(/-/g, "").slice(0, 8);
	const orgA = `org_test_a_${uid}`;
	const orgB = `org_test_b_${uid}`;
	const caseA = `case_test_a_${uid}`;
	const caseB = `case_test_b_${uid}`;
	let evA: { id: string };
	let evB: { id: string };

	beforeAll(async () => {
		sql = postgres(databaseUrl, { max: 5 });
		db = createDb(databaseUrl);
		repos = createDrizzleRepositories(db);

		// Seed two test organizations and initial cases
		await sql`INSERT INTO organizations (id, name) VALUES (${orgA}, 'Org Alpha'), (${orgB}, 'Org Beta')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseA}, ${orgA}, 'Case Alpha')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseB}, ${orgB}, 'Case Beta')`;

		evA = await repos.evidence.createPending({
			organizationId: orgA,
			caseId: caseA,
			objectKey: `test/${orgA}/base_ev_${uid}.eml`,
			sha256: "hash_base_a",
			byteSize: 100,
		});
		evB = await repos.evidence.createPending({
			organizationId: orgB,
			caseId: caseB,
			objectKey: `test/${orgB}/base_ev_${uid}.eml`,
			sha256: "hash_base_b",
			byteSize: 100,
		});
	});

	afterAll(async () => {
		// Clean up organizations (cascades to all children)
		await sql`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
		await sql.end();
	});

	describe("Cross-tenant boundaries on every get, list, update, and dependency", () => {
		it("enforces tenant boundary on cases", async () => {
			// Get
			expect(await repos.cases.getCase({ organizationId: orgB, caseId: caseA })).toBeNull();
			expect(await repos.cases.getCase({ organizationId: orgA, caseId: caseA })).not.toBeNull();

			// List
			const listB = await repos.cases.listCases({ organizationId: orgB });
			expect(listB.some((c) => c.id === caseA)).toBe(false);
			expect(listB.some((c) => c.id === caseB)).toBe(true);
		});

		it("enforces tenant boundary on evidence get, list, update, and foreign-key dependencies", async () => {
			const evA = await repos.evidence.createPending({
				organizationId: orgA,
				caseId: caseA,
				objectKey: `test/${orgA}/ev_1.eml`,
				sha256: "hash_ev_1",
				byteSize: 100,
			});

			// Cross-tenant get
			expect(await repos.evidence.getEvidence({ organizationId: orgB, evidenceId: evA.id })).toBeNull();

			// Cross-tenant list
			const listB = await repos.evidence.listEvidence({ organizationId: orgB, caseId: caseA });
			expect(listB).toEqual([]);

			// Cross-tenant updates
			await expect(repos.evidence.markStored({ organizationId: orgB, evidenceId: evA.id })).rejects.toThrow(
				NotFoundError,
			);
			await expect(repos.evidence.markVerified({ organizationId: orgB, evidenceId: evA.id })).rejects.toThrow(
				NotFoundError,
			);
			await expect(
				repos.evidence.markFailed({ organizationId: orgB, evidenceId: evA.id, failureReason: "x" }),
			).rejects.toThrow(NotFoundError);

			// Cross-tenant dependency: Org B creating evidence referencing Org A's case
			await expect(
				repos.evidence.createPending({
					organizationId: orgB,
					caseId: caseA,
					objectKey: `test/${orgB}/cross.eml`,
					sha256: "hash_cross",
					byteSize: 100,
				}),
			).rejects.toThrow(DependencyError);
		});

		it("enforces tenant boundary on analysis runs get, list, status, result, and updates", async () => {
			const evA = await repos.evidence.createPending({
				organizationId: orgA,
				caseId: caseA,
				objectKey: `test/${orgA}/ev_run.eml`,
				sha256: "hash_run",
				byteSize: 200,
			});

			const runA = await repos.analysisRuns.createAnalysisRun({
				organizationId: orgA,
				caseId: caseA,
				evidenceId: evA.id,
			});

			// Cross-tenant get / status / result / list
			expect(await repos.analysisRuns.getAnalysisRun({ organizationId: orgB, analysisRunId: runA.id })).toBeNull();
			expect(await repos.analysisRuns.getAnalysisStatus({ organizationId: orgB, analysisRunId: runA.id })).toBeNull();
			expect(await repos.analysisRuns.getAnalysisResult({ organizationId: orgB, analysisRunId: runA.id })).toBeNull();
			const listB = await repos.analysisRuns.listAnalysisRuns({ organizationId: orgB, caseId: caseA });
			expect(listB).toEqual([]);

			// Cross-tenant updates
			await expect(
				repos.analysisRuns.transitionStatus({
					organizationId: orgB,
					analysisRunId: runA.id,
					fromStatus: "accepted",
					toStatus: "queued",
				}),
			).rejects.toThrow(NotFoundError);

			await expect(
				repos.analysisRuns.saveResult({
					organizationId: orgB,
					analysisRunId: runA.id,
					verdict: "benign",
					score: 0,
					confidence: 1,
					analysisVersion: "1.0",
					rulesetVersion: "1.0",
					resultSchemaVersion: "1.0",
					resultSnapshot: {},
				}),
			).rejects.toThrow(NotFoundError);

			await expect(
				repos.analysisRuns.retryAnalysisRun({
					organizationId: orgB,
					analysisRunId: runA.id,
				}),
			).rejects.toThrow(NotFoundError);

			// Cross-tenant dependency: Org B creating run referencing Org A's case
			await expect(
				repos.analysisRuns.createAnalysisRun({
					organizationId: orgB,
					caseId: caseA,
					evidenceId: evB.id,
				}),
			).rejects.toThrow(DependencyError);

			// Cross-tenant dependency: Org A creating run referencing Org B's case
			await expect(
				repos.analysisRuns.createAnalysisRun({
					organizationId: orgA,
					caseId: caseB,
					evidenceId: evA.id,
				}),
			).rejects.toThrow(DependencyError);
		});

		it("enforces tenant boundary on reports get, list, update, and dependencies", async () => {
			const run = await repos.analysisRuns.createAnalysisRun({
				organizationId: orgA,
				caseId: caseA,
				evidenceId: evA.id,
				status: "completed",
			});

			const repA = await repos.reports.createReport({
				organizationId: orgA,
				caseId: caseA,
				analysisRunId: run.id,
				format: "html",
				objectKey: `reports/${orgA}/rep_${uid}.html`,
			});

			// Cross-tenant get / list
			expect(await repos.reports.getReport({ organizationId: orgB, reportId: repA.id })).toBeNull();
			const listB = await repos.reports.listReports({ organizationId: orgB, caseId: caseA });
			expect(listB).toEqual([]);

			// Cross-tenant update
			await expect(
				repos.reports.updateReportStatus({
					organizationId: orgB,
					reportId: repA.id,
					status: "completed",
				}),
			).rejects.toThrow(NotFoundError);

			// Cross-tenant dependency: Org B creating report referencing Org A's case/run
			await expect(
				repos.reports.createReport({
					organizationId: orgB,
					caseId: caseA,
					analysisRunId: run.id,
					format: "html",
				}),
			).rejects.toThrow(DependencyError);
		});

		it("enforces tenant boundary on audit append and retrieval", async () => {
			await repos.audit.appendAuditRecord({
				organizationId: orgA,
				action: "test.event.a",
				resourceType: "case",
				resourceId: caseA,
			});
			await repos.audit.appendAuditRecord({
				organizationId: orgB,
				action: "test.event.b",
				resourceType: "case",
				resourceId: caseB,
			});

			const recordsA = await repos.audit.listAuditRecords({ organizationId: orgA });
			expect(recordsA.every((r) => r.organizationId === orgA)).toBe(true);
			expect(recordsA.some((r) => r.action === "test.event.a")).toBe(true);
			expect(recordsA.some((r) => r.action === "test.event.b")).toBe(false);

			const recordsB = await repos.audit.listAuditRecords({ organizationId: orgB });
			expect(recordsB.every((r) => r.organizationId === orgB)).toBe(true);
			expect(recordsB.some((r) => r.action === "test.event.b")).toBe(true);
			expect(recordsB.some((r) => r.action === "test.event.a")).toBe(false);
		});
	});

	describe("Lifecycle transitions, immutability, and retry policy on PostgreSQL", () => {
		it("manages evidence lifecycle from pending to verified", async () => {
			const ev = await repos.evidence.createPending({
				organizationId: orgA,
				caseId: caseA,
				objectKey: `test/${orgA}/lifecycle_${uid}.eml`,
				sha256: "hash_init",
				byteSize: 300,
			});
			expect(ev.status).toBe("pending");

			const stored = await repos.evidence.markStored({
				organizationId: orgA,
				evidenceId: ev.id,
			});
			expect(stored.status).toBe("stored");
			expect(stored.storedAt).toBeDefined();

			const verified = await repos.evidence.markVerified({
				organizationId: orgA,
				evidenceId: ev.id,
			});
			expect(verified.status).toBe("verified");
			expect(verified.verifiedAt).toBeDefined();

			// Idempotent duplicate markVerified with absent metadata
			const dupAbsent = await repos.evidence.markVerified({
				organizationId: orgA,
				evidenceId: ev.id,
			});
			expect(dupAbsent.id).toBe(ev.id);

			// Idempotent duplicate markVerified with matching metadata
			const dupMatch = await repos.evidence.markVerified({
				organizationId: orgA,
				evidenceId: ev.id,
				sha256: "hash_init",
				byteSize: 300,
			});
			expect(dupMatch.id).toBe(ev.id);

			// Conflicting digest on duplicate markVerified throws ConflictError
			await expect(
				repos.evidence.markVerified({
					organizationId: orgA,
					evidenceId: ev.id,
					sha256: "hash_conflicting",
				}),
			).rejects.toThrow(ConflictError);

			// Conflicting byteSize on duplicate markVerified throws ConflictError
			await expect(
				repos.evidence.markVerified({
					organizationId: orgA,
					evidenceId: ev.id,
					byteSize: 9999,
				}),
			).rejects.toThrow(ConflictError);

			// Cannot mark failed once verified (rewrite forbidden)
			await expect(
				repos.evidence.markFailed({
					organizationId: orgA,
					evidenceId: ev.id,
					failureReason: "Cannot rewrite verified evidence",
				}),
			).rejects.toThrow(InvalidStateError);

			// Cannot mark stored once verified
			await expect(repos.evidence.markStored({ organizationId: orgA, evidenceId: ev.id })).rejects.toThrow(
				InvalidStateError,
			);
		});

		it("executes atomic analysis transitions and prevents invalid jumps", async () => {
			const run = await repos.analysisRuns.createAnalysisRun({
				organizationId: orgA,
				caseId: caseA,
				evidenceId: evA.id,
			});
			expect(run.status).toBe("accepted");

			// Accepted -> queued
			const queued = await repos.analysisRuns.transitionStatus({
				organizationId: orgA,
				analysisRunId: run.id,
				fromStatus: "accepted",
				toStatus: "queued",
			});
			expect(queued.status).toBe("queued");

			// Queued -> processing
			const processing = await repos.analysisRuns.transitionStatus({
				organizationId: orgA,
				analysisRunId: run.id,
				fromStatus: "queued",
				toStatus: "processing",
				startedAt: new Date(),
			});
			expect(processing.status).toBe("processing");

			// Invalid transition: fromStatus 'accepted' does not match current 'processing'
			await expect(
				repos.analysisRuns.transitionStatus({
					organizationId: orgA,
					analysisRunId: run.id,
					fromStatus: "accepted",
					toStatus: "failed",
				}),
			).rejects.toThrow(InvalidStateError);
		});

		it("enforces transactional immutable result saving on PostgreSQL", async () => {
			const run = await repos.analysisRuns.createAnalysisRun({
				organizationId: orgA,
				caseId: caseA,
				evidenceId: evA.id,
			});

			await repos.analysisRuns.transitionStatus({
				organizationId: orgA,
				analysisRunId: run.id,
				fromStatus: "accepted",
				toStatus: "processing",
			});

			// Save result
			const snapshot = { findings: [{ id: "spf_fail", score: 40 }] };
			const saved = await repos.analysisRuns.saveResult({
				organizationId: orgA,
				analysisRunId: run.id,
				verdict: "suspicious",
				score: 40,
				confidence: 0.85,
				analysisVersion: "1.0.0",
				rulesetVersion: "1.1.0",
				resultSchemaVersion: "1.0.0",
				resultSnapshot: snapshot,
			});
			expect(saved.status).toBe("completed");
			expect(saved.verdict).toBe("suspicious");

			// Idempotent duplicate identical result save returns existing
			const duplicate = await repos.analysisRuns.saveResult({
				organizationId: orgA,
				analysisRunId: run.id,
				verdict: "suspicious",
				score: 40,
				confidence: 0.85,
				analysisVersion: "1.0.0",
				rulesetVersion: "1.1.0",
				resultSchemaVersion: "1.0.0",
				resultSnapshot: snapshot,
			});
			expect(duplicate.id).toBe(saved.id);

			// Idempotent duplicate result save with reordered JSON keys returns existing
			const duplicateReordered = await repos.analysisRuns.saveResult({
				organizationId: orgA,
				analysisRunId: run.id,
				verdict: "suspicious",
				score: 40,
				confidence: 0.85,
				analysisVersion: "1.0.0",
				rulesetVersion: "1.1.0",
				resultSchemaVersion: "1.0.0",
				resultSnapshot: { findings: [{ score: 40, id: "spf_fail" }] },
			});
			expect(duplicateReordered.id).toBe(saved.id);

			// Mismatched result save on completed run fails with ConflictError (immutable)
			// Confidence mismatch
			await expect(
				repos.analysisRuns.saveResult({
					organizationId: orgA,
					analysisRunId: run.id,
					verdict: "suspicious",
					score: 40,
					confidence: 0.99,
					analysisVersion: "1.0.0",
					rulesetVersion: "1.1.0",
					resultSchemaVersion: "1.0.0",
					resultSnapshot: snapshot,
				}),
			).rejects.toThrow(ConflictError);

			// Version columns mismatch
			await expect(
				repos.analysisRuns.saveResult({
					organizationId: orgA,
					analysisRunId: run.id,
					verdict: "suspicious",
					score: 40,
					confidence: 0.85,
					analysisVersion: "2.0.0",
					rulesetVersion: "1.1.0",
					resultSchemaVersion: "1.0.0",
					resultSnapshot: snapshot,
				}),
			).rejects.toThrow(ConflictError);

			// Verdict and snapshot mismatch
			await expect(
				repos.analysisRuns.saveResult({
					organizationId: orgA,
					analysisRunId: run.id,
					verdict: "benign",
					score: 5,
					confidence: 0.85,
					analysisVersion: "1.0.0",
					rulesetVersion: "1.1.0",
					resultSchemaVersion: "1.0.0",
					resultSnapshot: {},
				}),
			).rejects.toThrow(ConflictError);
		});

		it("enforces explicit retry policy on PostgreSQL", async () => {
			const run = await repos.analysisRuns.createAnalysisRun({
				organizationId: orgA,
				caseId: caseA,
				evidenceId: evA.id,
			});

			// Fail run with retryable: false
			await repos.analysisRuns.transitionStatus({
				organizationId: orgA,
				analysisRunId: run.id,
				fromStatus: "accepted",
				toStatus: "failed",
				retryable: false,
				failureCode: "FATAL_ERROR",
			});

			// Cannot retry non-retryable
			await expect(
				repos.analysisRuns.retryAnalysisRun({ organizationId: orgA, analysisRunId: run.id }),
			).rejects.toThrow(InvalidStateError);

			// Create retryable failed run
			const retryableRun = await repos.analysisRuns.createAnalysisRun({
				organizationId: orgA,
				caseId: caseA,
				evidenceId: evA.id,
			});
			await repos.analysisRuns.transitionStatus({
				organizationId: orgA,
				analysisRunId: retryableRun.id,
				fromStatus: "accepted",
				toStatus: "failed",
				retryable: true,
				failureCode: "TIMEOUT",
			});

			// Retry 1: succeeds, transitions to accepted, attempts = 1
			const retried1 = await repos.analysisRuns.retryAnalysisRun({
				organizationId: orgA,
				analysisRunId: retryableRun.id,
				maxAttempts: 2,
			});
			expect(retried1.status).toBe("accepted");
			expect(retried1.attempts).toBe(1);
			expect(retried1.failureCode).toBeNull();

			// Fail again
			await repos.analysisRuns.transitionStatus({
				organizationId: orgA,
				analysisRunId: retryableRun.id,
				fromStatus: ["accepted", "queued"],
				toStatus: "failed",
				retryable: true,
			});

			// Retry 2: succeeds, attempts = 2
			const retried2 = await repos.analysisRuns.retryAnalysisRun({
				organizationId: orgA,
				analysisRunId: retryableRun.id,
				maxAttempts: 2,
			});
			expect(retried2.status).toBe("accepted");
			expect(retried2.attempts).toBe(2);

			// Fail again
			await repos.analysisRuns.transitionStatus({
				organizationId: orgA,
				analysisRunId: retryableRun.id,
				fromStatus: ["accepted", "queued"],
				toStatus: "failed",
				retryable: true,
			});

			// Retry 3: exceeds maxAttempts (current: 2 >= 2) -> throws InvalidStateError
			await expect(
				repos.analysisRuns.retryAnalysisRun({
					organizationId: orgA,
					analysisRunId: retryableRun.id,
					maxAttempts: 2,
				}),
			).rejects.toThrow(InvalidStateError);
		});

		it("auto-increments report versions and prevents duplicate version conflicts", async () => {
			const run = await repos.analysisRuns.createAnalysisRun({
				organizationId: orgA,
				caseId: caseA,
				evidenceId: evA.id,
				status: "completed",
			});

			const r1 = await repos.reports.createReport({
				organizationId: orgA,
				caseId: caseA,
				analysisRunId: run.id,
				format: "json",
			});
			expect(r1.version).toBe(1);

			const r2 = await repos.reports.createReport({
				organizationId: orgA,
				caseId: caseA,
				analysisRunId: run.id,
				format: "json",
			});
			expect(r2.version).toBe(2);

			// Explicit duplicate version fails with ConflictError
			await expect(
				repos.reports.createReport({
					organizationId: orgA,
					caseId: caseA,
					analysisRunId: run.id,
					format: "json",
					version: 1,
				}),
			).rejects.toThrow(ConflictError);
		});
	});

	describe("Concurrent analysis creation and idempotency", () => {
		it("safely handles concurrent analysis creation with identical idempotencyKey", async () => {
			const idempotencyKey = `idem_concurrent_${uid}`;

			// Launch two concurrent requests with identical idempotencyKey within same organization
			const [res1, res2] = await Promise.allSettled([
				repos.analysisRuns.createAnalysisRun({
					organizationId: orgA,
					caseId: caseA,
					evidenceId: evA.id,
					idempotencyKey,
				}),
				repos.analysisRuns.createAnalysisRun({
					organizationId: orgA,
					caseId: caseA,
					evidenceId: evA.id,
					idempotencyKey,
				}),
			]);

			// Exactly one must succeed and one must fail with ConflictError
			const successes = [res1, res2].filter((r) => r.status === "fulfilled");
			const failures = [res1, res2].filter((r) => r.status === "rejected");

			expect(successes.length).toBe(1);
			expect(failures.length).toBe(1);
			expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

			// Different organization can use the same idempotencyKey independently
			const orgBRun = await repos.analysisRuns.createAnalysisRun({
				organizationId: orgB,
				caseId: caseB,
				evidenceId: evB.id,
				idempotencyKey,
			});
			expect(orgBRun.organizationId).toBe(orgB);
			expect(orgBRun.idempotencyKey).toBe(idempotencyKey);
		});
	});

	describe("PostgreSQL transaction rollback", () => {
		it("rolls back all changes when transaction callback throws", async () => {
			const objectKey = `test/${orgA}/rollback_${uid}.eml`;
			let createdEvidenceId = "";

			await expect(
				executeTransaction(db, async (txRepos) => {
					const evidence = await txRepos.evidence.createPending({
						organizationId: orgA,
						caseId: caseA,
						objectKey,
						sha256: "hash_rollback",
						byteSize: 100,
					});
					createdEvidenceId = evidence.id;

					await txRepos.analysisRuns.createAnalysisRun({
						organizationId: orgA,
						caseId: caseA,
						evidenceId: evidence.id,
					});

					// Simulate an unexpected error or business abort
					throw new Error("Simulated failure triggering rollback");
				}),
			).rejects.toThrow("Simulated failure triggering rollback");

			// Verify evidence record was rolled back from database
			expect(createdEvidenceId).not.toBe("");
			const fetched = await repos.evidence.getEvidence({
				organizationId: orgA,
				evidenceId: createdEvidenceId,
			});
			expect(fetched).toBeNull();
		});

		it("executes composite transaction helper createEvidenceWithRunAndAudit atomically", async () => {
			const objectKey = `test/${orgA}/composite_${uid}.eml`;

			const result = await executeTransaction(db, async (txRepos) => {
				return await createEvidenceWithRunAndAudit(txRepos, {
					organizationId: orgA,
					caseId: caseA,
					evidence: {
						objectKey,
						sha256: "hash_composite",
						byteSize: 450,
						status: "verified",
					},
					run: {
						analysisVersion: "1.0.0",
						rulesetVersion: "1.1.0",
					},
					audit: {
						metadata: { flow: "test_intake" },
					},
				});
			});

			expect(result.evidence.status).toBe("verified");
			expect(result.run.evidenceId).toBe(result.evidence.id);
			expect(result.audit.resourceId).toBe(result.evidence.id);
			expect(result.audit.metadata?.objectKey).toBeUndefined();

			// Verify persisted in database
			const persistedEv = await repos.evidence.getEvidence({
				organizationId: orgA,
				evidenceId: result.evidence.id,
			});
			expect(persistedEv?.status).toBe("verified");

			const persistedRun = await repos.analysisRuns.getAnalysisRun({
				organizationId: orgA,
				analysisRunId: result.run.id,
			});
			expect(persistedRun?.evidenceId).toBe(result.evidence.id);

			// Verify persisted audit record does not contain objectKey in metadata
			const auditRecords = await repos.audit.listAuditRecords({
				organizationId: orgA,
				resourceType: "evidence",
				resourceId: result.evidence.id,
			});
			expect(auditRecords.length).toBeGreaterThanOrEqual(1);
			expect(auditRecords[0]?.metadata?.objectKey).toBeUndefined();
			expect(auditRecords[0]?.metadata?.caseId).toBe(caseA);
		});
	});
});
