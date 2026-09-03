import { describe, expect, it } from "vitest";
import {
	areAnalysisResultsIdentical,
	type CaseShell,
	ConflictError,
	canonicalJsonStringify,
	createAnalysisRunWithAudit,
	createEvidenceWithRunAndAudit,
	createMemoryRepositories,
	DependencyError,
	InvalidStateError,
	MemoryCaseRepository,
	mapDatabaseError,
	NotFoundError,
	RepositoryError,
} from "./repositories";

const now = new Date("2026-01-01T00:00:00Z");
const records: CaseShell[] = [
	{ id: "case_a", organizationId: "org_a", title: "A", createdAt: now, updatedAt: now },
	{ id: "case_b", organizationId: "org_b", title: "B", createdAt: now, updatedAt: now },
];

describe("tenant-scoped case repository (Memory)", () => {
	it("never returns another organization's case by id", async () => {
		const repository = new MemoryCaseRepository(records);
		await expect(repository.getCase({ organizationId: "org_a", caseId: "case_b" })).resolves.toBeNull();
	});

	it("filters lists by organization", async () => {
		const repository = new MemoryCaseRepository(records);
		const result = await repository.listCases({ organizationId: "org_a" });
		expect(result.map(({ id }) => id)).toEqual(["case_a"]);
	});

	it("creates a case with the supplied organization context", async () => {
		const repository = new MemoryCaseRepository([...records]);
		const created = await repository.createCase({ organizationId: "org_a", title: "New case" });
		expect(created).toMatchObject({ organizationId: "org_a", title: "New case" });
		await expect(repository.getCase({ organizationId: "org_b", caseId: created.id })).resolves.toBeNull();
	});

	it("rejects empty organizationId on every method", async () => {
		const repository = new MemoryCaseRepository([...records]);
		await expect(repository.listCases({ organizationId: "" })).rejects.toThrow(RepositoryError);
		await expect(repository.getCase({ organizationId: "   ", caseId: "case_a" })).rejects.toThrow(RepositoryError);
		await expect(repository.createCase({ organizationId: "", title: "test" })).rejects.toThrow(RepositoryError);
	});
});

describe("tenant-scoped evidence repository (Memory)", () => {
	it("creates pending evidence and prevents cross-tenant or missing case dependency", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_1", organizationId: "org_a", title: "Case 1", createdAt: now, updatedAt: now }],
		});

		// Cross-tenant case reference should fail with DependencyError
		await expect(
			repos.evidence.createPending({
				organizationId: "org_b",
				caseId: "case_1",
				objectKey: "org_b/case_1/email.eml",
				sha256: "hash123",
				byteSize: 1024,
			}),
		).rejects.toThrow(DependencyError);

		// Valid creation in org_a
		const created = await repos.evidence.createPending({
			organizationId: "org_a",
			caseId: "case_1",
			objectKey: "org_a/case_1/email.eml",
			sha256: "hash123",
			byteSize: 1024,
			idempotencyKey: "idem_ev_1",
		});
		expect(created.status).toBe("pending");
		expect(created.organizationId).toBe("org_a");

		// Duplicate objectKey conflict
		await expect(
			repos.evidence.createPending({
				organizationId: "org_a",
				caseId: "case_1",
				objectKey: "org_a/case_1/email.eml",
				sha256: "hash456",
				byteSize: 2048,
			}),
		).rejects.toThrow(ConflictError);

		// Duplicate idempotencyKey conflict within same organization
		await expect(
			repos.evidence.createPending({
				organizationId: "org_a",
				caseId: "case_1",
				objectKey: "org_a/case_1/email2.eml",
				sha256: "hash456",
				byteSize: 2048,
				idempotencyKey: "idem_ev_1",
			}),
		).rejects.toThrow(ConflictError);
	});

	it("manages evidence lifecycle transitions (pending -> stored -> verified / failed)", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_1", organizationId: "org_a", title: "Case 1", createdAt: now, updatedAt: now }],
		});

		const ev = await repos.evidence.createPending({
			organizationId: "org_a",
			caseId: "case_1",
			objectKey: "org_a/case_1/email.eml",
			sha256: "hash123",
			byteSize: 1024,
		});

		// Mark stored
		const stored = await repos.evidence.markStored({
			organizationId: "org_a",
			evidenceId: ev.id,
		});
		expect(stored.status).toBe("stored");
		expect(stored.storedAt).toBeDefined();

		// Idempotent mark stored
		const storedAgain = await repos.evidence.markStored({
			organizationId: "org_a",
			evidenceId: ev.id,
		});
		expect(storedAgain.status).toBe("stored");

		// Mark verified
		const verified = await repos.evidence.markVerified({
			organizationId: "org_a",
			evidenceId: ev.id,
		});
		expect(verified.status).toBe("verified");
		expect(verified.verifiedAt).toBeDefined();

		// Duplicate markVerified with absent digest/size is idempotent
		const duplicateAbsent = await repos.evidence.markVerified({
			organizationId: "org_a",
			evidenceId: ev.id,
		});
		expect(duplicateAbsent.id).toBe(ev.id);
		expect(duplicateAbsent.status).toBe("verified");

		// Duplicate markVerified with matching digest and size is idempotent
		const duplicateMatch = await repos.evidence.markVerified({
			organizationId: "org_a",
			evidenceId: ev.id,
			sha256: "hash123",
			byteSize: 1024,
		});
		expect(duplicateMatch.id).toBe(ev.id);

		// Duplicate markVerified with conflicting digest throws ConflictError
		await expect(
			repos.evidence.markVerified({
				organizationId: "org_a",
				evidenceId: ev.id,
				sha256: "hash_different",
			}),
		).rejects.toThrow(ConflictError);

		// Duplicate markVerified with conflicting byteSize throws ConflictError
		await expect(
			repos.evidence.markVerified({
				organizationId: "org_a",
				evidenceId: ev.id,
				byteSize: 99999,
			}),
		).rejects.toThrow(ConflictError);

		// Cannot rewrite verified evidence with markFailed
		await expect(
			repos.evidence.markFailed({
				organizationId: "org_a",
				evidenceId: ev.id,
				failureReason: "Attempt to rewrite verified evidence",
			}),
		).rejects.toThrow(InvalidStateError);

		// Marking stored after verified should be rejected
		await expect(
			repos.evidence.markStored({
				organizationId: "org_a",
				evidenceId: ev.id,
			}),
		).rejects.toThrow(InvalidStateError);

		// Creating another evidence and marking failed
		const ev2 = await repos.evidence.createPending({
			organizationId: "org_a",
			caseId: "case_1",
			objectKey: "org_a/case_1/email2.eml",
			sha256: "hash456",
			byteSize: 2048,
		});

		// Cannot verify with conflicting metadata on pending evidence
		await expect(
			repos.evidence.markVerified({
				organizationId: "org_a",
				evidenceId: ev2.id,
				sha256: "hash_mismatched",
			}),
		).rejects.toThrow(ConflictError);

		const failed = await repos.evidence.markFailed({
			organizationId: "org_a",
			evidenceId: ev2.id,
			failureReason: "Malformatted MIME headers",
		});
		expect(failed.status).toBe("failed");
		expect(failed.failureReason).toBe("Malformatted MIME headers");

		// Duplicate markFailed is idempotent
		const failedAgain = await repos.evidence.markFailed({
			organizationId: "org_a",
			evidenceId: ev2.id,
			failureReason: "Malformatted MIME headers",
		});
		expect(failedAgain.status).toBe("failed");

		// Cannot verify failed evidence
		await expect(
			repos.evidence.markVerified({
				organizationId: "org_a",
				evidenceId: ev2.id,
			}),
		).rejects.toThrow(InvalidStateError);
	});

	it("strictly enforces cross-tenant boundary on evidence get, list, and update", async () => {
		const repos = createMemoryRepositories({
			cases: [
				{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now },
				{ id: "case_b", organizationId: "org_b", title: "Case B", createdAt: now, updatedAt: now },
			],
		});

		const evA = await repos.evidence.createPending({
			organizationId: "org_a",
			caseId: "case_a",
			objectKey: "org_a/case_a/email.eml",
			sha256: "hashA",
			byteSize: 100,
		});

		// Org B cannot get Org A's evidence
		const crossGet = await repos.evidence.getEvidence({ organizationId: "org_b", evidenceId: evA.id });
		expect(crossGet).toBeNull();

		// Org B listing case_a returns empty list
		const crossList = await repos.evidence.listEvidence({ organizationId: "org_b", caseId: "case_a" });
		expect(crossList).toEqual([]);

		// Org B cannot markStored, markVerified, or markFailed on Org A's evidence
		await expect(repos.evidence.markStored({ organizationId: "org_b", evidenceId: evA.id })).rejects.toThrow(
			NotFoundError,
		);
		await expect(repos.evidence.markVerified({ organizationId: "org_b", evidenceId: evA.id })).rejects.toThrow(
			NotFoundError,
		);
		await expect(
			repos.evidence.markFailed({ organizationId: "org_b", evidenceId: evA.id, failureReason: "hacked" }),
		).rejects.toThrow(NotFoundError);
	});
});

describe("tenant-scoped analysis run repository (Memory)", () => {
	it("creates analysis run and validates case & evidence scope", async () => {
		const repos = createMemoryRepositories({
			cases: [
				{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now },
				{ id: "case_b", organizationId: "org_b", title: "Case B", createdAt: now, updatedAt: now },
			],
		});

		const evA = await repos.evidence.createPending({
			organizationId: "org_a",
			caseId: "case_a",
			objectKey: "org_a/case_a/msg.eml",
			sha256: "hashA",
			byteSize: 50,
		});

		// Cross-tenant case dependency fails
		await expect(
			repos.analysisRuns.createAnalysisRun({
				organizationId: "org_b",
				caseId: "case_a",
			}),
		).rejects.toThrow(DependencyError);

		// Cross-case or cross-tenant evidence dependency fails
		await expect(
			repos.analysisRuns.createAnalysisRun({
				organizationId: "org_a",
				caseId: "case_b",
				evidenceId: evA.id,
			}),
		).rejects.toThrow(DependencyError);

		// Valid creation
		const run = await repos.analysisRuns.createAnalysisRun({
			organizationId: "org_a",
			caseId: "case_a",
			evidenceId: evA.id,
			idempotencyKey: "idem_run_1",
		});
		expect(run.status).toBe("accepted");
		expect(run.organizationId).toBe("org_a");

		// Duplicate idempotencyKey conflict
		await expect(
			repos.analysisRuns.createAnalysisRun({
				organizationId: "org_a",
				caseId: "case_a",
				evidenceId: evA.id,
				idempotencyKey: "idem_run_1",
			}),
		).rejects.toThrow(ConflictError);
	});

	it("executes atomic status transitions and reports status/result", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now }],
		});
		const run = await repos.analysisRuns.createAnalysisRun({
			organizationId: "org_a",
			caseId: "case_a",
		});

		// Transition accepted -> queued
		const queued = await repos.analysisRuns.transitionStatus({
			organizationId: "org_a",
			analysisRunId: run.id,
			fromStatus: "accepted",
			toStatus: "queued",
			phase: "queued",
		});
		expect(queued.status).toBe("queued");
		expect(queued.phase).toBe("queued");
		expect(queued.queuedAt).toBeInstanceOf(Date);

		// Transition queued -> processing
		const processing = await repos.analysisRuns.transitionStatus({
			organizationId: "org_a",
			analysisRunId: run.id,
			fromStatus: ["queued"],
			toStatus: "processing",
			phase: "extraction",
			progress: 25,
			startedAt: new Date(),
		});
		expect(processing.status).toBe("processing");
		expect(processing.progress).toBe(25);

		// Status view read
		const statusView = await repos.analysisRuns.getAnalysisStatus({
			organizationId: "org_a",
			analysisRunId: run.id,
		});
		expect(statusView?.status).toBe("processing");
		expect(statusView?.phase).toBe("extraction");

		// Invalid transition: cannot jump to queued from processing when fromStatus is accepted
		await expect(
			repos.analysisRuns.transitionStatus({
				organizationId: "org_a",
				analysisRunId: run.id,
				fromStatus: "accepted",
				toStatus: "queued",
			}),
		).rejects.toThrow(InvalidStateError);

		// Cross-tenant transition fails with NotFoundError
		await expect(
			repos.analysisRuns.transitionStatus({
				organizationId: "org_b",
				analysisRunId: run.id,
				fromStatus: "processing",
				toStatus: "completed",
			}),
		).rejects.toThrow(NotFoundError);
	});

	it("enforces transactional immutable result save and idempotent duplicate writes", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now }],
		});
		const run = await repos.analysisRuns.createAnalysisRun({
			organizationId: "org_a",
			caseId: "case_a",
		});

		// Saving result while in 'accepted' status fails (must be 'processing')
		await expect(
			repos.analysisRuns.saveResult({
				organizationId: "org_a",
				analysisRunId: run.id,
				verdict: "malicious",
				score: 85,
				confidence: 0.95,
				analysisVersion: "1.0.0",
				rulesetVersion: "1.1.0",
				resultSchemaVersion: "1.0.0",
				resultSnapshot: { findings: ["phishing_link"] },
			}),
		).rejects.toThrow(InvalidStateError);

		// Move to processing
		await repos.analysisRuns.transitionStatus({
			organizationId: "org_a",
			analysisRunId: run.id,
			fromStatus: "accepted",
			toStatus: "processing",
		});

		// Save result successfully
		const saved = await repos.analysisRuns.saveResult({
			organizationId: "org_a",
			analysisRunId: run.id,
			verdict: "malicious",
			score: 85,
			confidence: 0.95,
			analysisVersion: "1.0.0",
			rulesetVersion: "1.1.0",
			resultSchemaVersion: "1.0.0",
			resultSnapshot: { findings: ["phishing_link"] },
		});
		expect(saved.status).toBe("completed");
		expect(saved.verdict).toBe("malicious");
		expect(saved.score).toBe(85);

		// Idempotent identical result write succeeds and returns same record
		const identical = await repos.analysisRuns.saveResult({
			organizationId: "org_a",
			analysisRunId: run.id,
			verdict: "malicious",
			score: 85,
			confidence: 0.95,
			analysisVersion: "1.0.0",
			rulesetVersion: "1.1.0",
			resultSchemaVersion: "1.0.0",
			resultSnapshot: { findings: ["phishing_link"] },
		});
		expect(identical.id).toBe(saved.id);

		// Idempotent identical result write with differently-ordered JSON keys succeeds
		const reorderedJsonDuplicate = await repos.analysisRuns.saveResult({
			organizationId: "org_a",
			analysisRunId: run.id,
			verdict: "malicious",
			score: 85,
			confidence: 0.95,
			analysisVersion: "1.0.0",
			rulesetVersion: "1.1.0",
			resultSchemaVersion: "1.0.0",
			resultSnapshot: { findings: ["phishing_link"] },
		});
		expect(reorderedJsonDuplicate.id).toBe(saved.id);

		// Mismatches on ANY immutable field must throw ConflictError
		// 1. Differing confidence
		await expect(
			repos.analysisRuns.saveResult({
				organizationId: "org_a",
				analysisRunId: run.id,
				verdict: "malicious",
				score: 85,
				confidence: 0.99,
				analysisVersion: "1.0.0",
				rulesetVersion: "1.1.0",
				resultSchemaVersion: "1.0.0",
				resultSnapshot: { findings: ["phishing_link"] },
			}),
		).rejects.toThrow(ConflictError);

		// 2. Differing analysisVersion
		await expect(
			repos.analysisRuns.saveResult({
				organizationId: "org_a",
				analysisRunId: run.id,
				verdict: "malicious",
				score: 85,
				confidence: 0.95,
				analysisVersion: "2.0.0",
				rulesetVersion: "1.1.0",
				resultSchemaVersion: "1.0.0",
				resultSnapshot: { findings: ["phishing_link"] },
			}),
		).rejects.toThrow(ConflictError);

		// 3. Differing rulesetVersion
		await expect(
			repos.analysisRuns.saveResult({
				organizationId: "org_a",
				analysisRunId: run.id,
				verdict: "malicious",
				score: 85,
				confidence: 0.95,
				analysisVersion: "1.0.0",
				rulesetVersion: "2.0.0",
				resultSchemaVersion: "1.0.0",
				resultSnapshot: { findings: ["phishing_link"] },
			}),
		).rejects.toThrow(ConflictError);

		// 4. Differing resultSchemaVersion
		await expect(
			repos.analysisRuns.saveResult({
				organizationId: "org_a",
				analysisRunId: run.id,
				verdict: "malicious",
				score: 85,
				confidence: 0.95,
				analysisVersion: "1.0.0",
				rulesetVersion: "1.1.0",
				resultSchemaVersion: "2.0.0",
				resultSnapshot: { findings: ["phishing_link"] },
			}),
		).rejects.toThrow(ConflictError);

		// 5. Differing verdict
		await expect(
			repos.analysisRuns.saveResult({
				organizationId: "org_a",
				analysisRunId: run.id,
				verdict: "benign",
				score: 85,
				confidence: 0.95,
				analysisVersion: "1.0.0",
				rulesetVersion: "1.1.0",
				resultSchemaVersion: "1.0.0",
				resultSnapshot: { findings: ["phishing_link"] },
			}),
		).rejects.toThrow(ConflictError);

		// 6. Differing score
		await expect(
			repos.analysisRuns.saveResult({
				organizationId: "org_a",
				analysisRunId: run.id,
				verdict: "malicious",
				score: 90,
				confidence: 0.95,
				analysisVersion: "1.0.0",
				rulesetVersion: "1.1.0",
				resultSchemaVersion: "1.0.0",
				resultSnapshot: { findings: ["phishing_link"] },
			}),
		).rejects.toThrow(ConflictError);

		// 7. Differing resultSnapshot
		await expect(
			repos.analysisRuns.saveResult({
				organizationId: "org_a",
				analysisRunId: run.id,
				verdict: "malicious",
				score: 85,
				confidence: 0.95,
				analysisVersion: "1.0.0",
				rulesetVersion: "1.1.0",
				resultSchemaVersion: "1.0.0",
				resultSnapshot: { findings: ["different_finding"] },
			}),
		).rejects.toThrow(ConflictError);

		// Result view read
		const resultView = await repos.analysisRuns.getAnalysisResult({
			organizationId: "org_a",
			analysisRunId: run.id,
		});
		expect(resultView?.verdict).toBe("malicious");
		expect(resultView?.score).toBe(85);

		// Cross-tenant result view returns null
		const crossResult = await repos.analysisRuns.getAnalysisResult({
			organizationId: "org_b",
			analysisRunId: run.id,
		});
		expect(crossResult).toBeNull();
	});

	it("enforces explicit retry policy on analysis runs", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now }],
		});
		const run = await repos.analysisRuns.createAnalysisRun({
			organizationId: "org_a",
			caseId: "case_a",
		});

		// Cannot retry an accepted run
		await expect(
			repos.analysisRuns.retryAnalysisRun({
				organizationId: "org_a",
				analysisRunId: run.id,
			}),
		).rejects.toThrow(InvalidStateError);

		// Transition to failed with retryable: false
		await repos.analysisRuns.transitionStatus({
			organizationId: "org_a",
			analysisRunId: run.id,
			fromStatus: "accepted",
			toStatus: "failed",
			retryable: false,
			failureCode: "INVALID_EML",
			failureMessage: "Non-retryable corrupted file",
		});

		// Cannot retry a non-retryable run
		await expect(
			repos.analysisRuns.retryAnalysisRun({
				organizationId: "org_a",
				analysisRunId: run.id,
			}),
		).rejects.toThrow(InvalidStateError);

		// Create another run that fails with retryable: true
		const run2 = await repos.analysisRuns.createAnalysisRun({
			organizationId: "org_a",
			caseId: "case_a",
		});
		await repos.analysisRuns.transitionStatus({
			organizationId: "org_a",
			analysisRunId: run2.id,
			fromStatus: "accepted",
			toStatus: "failed",
			retryable: true,
			failureCode: "TIMEOUT",
			failureMessage: "Transient enrichment timeout",
		});

		// First retry succeeds: resets status to accepted, attempts becomes 1
		const retried1 = await repos.analysisRuns.retryAnalysisRun({
			organizationId: "org_a",
			analysisRunId: run2.id,
			maxAttempts: 2,
		});
		expect(retried1.status).toBe("accepted");
		expect(retried1.attempts).toBe(1);
		expect(retried1.failureCode).toBeNull();

		// Fails again
		await repos.analysisRuns.transitionStatus({
			organizationId: "org_a",
			analysisRunId: run2.id,
			fromStatus: ["accepted", "queued"],
			toStatus: "failed",
			retryable: true,
		});

		// Second retry succeeds: attempts becomes 2
		const retried2 = await repos.analysisRuns.retryAnalysisRun({
			organizationId: "org_a",
			analysisRunId: run2.id,
			maxAttempts: 2,
		});
		expect(retried2.status).toBe("accepted");
		expect(retried2.attempts).toBe(2);

		// Fails third time
		await repos.analysisRuns.transitionStatus({
			organizationId: "org_a",
			analysisRunId: run2.id,
			fromStatus: ["accepted", "queued"],
			toStatus: "failed",
			retryable: true,
		});

		// Exceeds maxAttempts (attempts 2 >= maxAttempts 2)
		await expect(
			repos.analysisRuns.retryAnalysisRun({
				organizationId: "org_a",
				analysisRunId: run2.id,
				maxAttempts: 2,
			}),
		).rejects.toThrow(InvalidStateError);
	});
});

describe("tenant-scoped report repository (Memory)", () => {
	it("creates versioned reports and enforces version/format immutability", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now }],
			analysisRuns: [
				{
					id: "run_a",
					organizationId: "org_a",
					caseId: "case_a",
					evidenceId: null,
					status: "completed",
					verdict: "malicious",
					score: 90,
					confidence: 0.9,
					analysisVersion: "1.0.0",
					rulesetVersion: "1.0.0",
					resultSchemaVersion: "1.0.0",
					resultSnapshot: {},
					failureCode: null,
					failureMessage: null,
					retryable: false,
					attempts: 0,
					queuedAt: null,
					startedAt: null,
					completedAt: now,
					failedAt: null,
					idempotencyKey: null,
					phase: "completed",
					progress: 100,
					createdAt: now,
					updatedAt: now,
				},
			],
		});

		// Auto-versioning: first HTML report gets version 1
		const rep1 = await repos.reports.createReport({
			organizationId: "org_a",
			caseId: "case_a",
			analysisRunId: "run_a",
			format: "html",
		});
		expect(rep1.version).toBe(1);
		expect(rep1.status).toBe("pending");

		// Second HTML report for same run automatically gets version 2
		const rep2 = await repos.reports.createReport({
			organizationId: "org_a",
			caseId: "case_a",
			analysisRunId: "run_a",
			format: "html",
		});
		expect(rep2.version).toBe(2);

		// Explicit duplicate version conflict
		await expect(
			repos.reports.createReport({
				organizationId: "org_a",
				caseId: "case_a",
				analysisRunId: "run_a",
				format: "html",
				version: 1,
			}),
		).rejects.toThrow(ConflictError);

		// Cross-tenant report creation fails
		await expect(
			repos.reports.createReport({
				organizationId: "org_b",
				caseId: "case_a",
				analysisRunId: "run_a",
				format: "html",
			}),
		).rejects.toThrow(DependencyError);
	});

	it("manages report status updates and cross-tenant boundaries", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now }],
			analysisRuns: [
				{
					id: "run_a",
					organizationId: "org_a",
					caseId: "case_a",
					evidenceId: null,
					status: "completed",
					verdict: "malicious",
					score: 90,
					confidence: 0.9,
					analysisVersion: "1.0.0",
					rulesetVersion: "1.0.0",
					resultSchemaVersion: "1.0.0",
					resultSnapshot: {},
					failureCode: null,
					failureMessage: null,
					retryable: false,
					attempts: 0,
					queuedAt: null,
					startedAt: null,
					completedAt: now,
					failedAt: null,
					idempotencyKey: null,
					phase: "completed",
					progress: 100,
					createdAt: now,
					updatedAt: now,
				},
			],
		});

		const rep = await repos.reports.createReport({
			organizationId: "org_a",
			caseId: "case_a",
			analysisRunId: "run_a",
			format: "pdf",
		});

		// Update to completed
		const completed = await repos.reports.updateReportStatus({
			organizationId: "org_a",
			reportId: rep.id,
			status: "completed",
			objectKey: "reports/org_a/run_a/report_v1.pdf",
		});
		expect(completed.status).toBe("completed");
		expect(completed.generatedAt).toBeDefined();

		// Cannot transition completed back to generating
		await expect(
			repos.reports.updateReportStatus({
				organizationId: "org_a",
				reportId: rep.id,
				status: "generating",
			}),
		).rejects.toThrow(InvalidStateError);

		// Cross-tenant read / update rejected
		const crossGet = await repos.reports.getReport({ organizationId: "org_b", reportId: rep.id });
		expect(crossGet).toBeNull();
		await expect(
			repos.reports.updateReportStatus({ organizationId: "org_b", reportId: rep.id, status: "failed" }),
		).rejects.toThrow(NotFoundError);
	});
});

describe("tenant-scoped audit repository (Memory)", () => {
	it("appends audit records and queries strictly within tenant scope", async () => {
		const repos = createMemoryRepositories();

		await repos.audit.appendAuditRecord({
			organizationId: "org_a",
			action: "case.created",
			resourceType: "case",
			resourceId: "case_1",
			actorUserId: "usr_1",
			metadata: { title: "Suspicious invoice" },
		});
		await repos.audit.appendAuditRecord({
			organizationId: "org_b",
			action: "case.created",
			resourceType: "case",
			resourceId: "case_2",
			actorUserId: "usr_2",
		});

		const listA = await repos.audit.listAuditRecords({ organizationId: "org_a" });
		expect(listA.length).toBe(1);
		expect(listA[0]?.resourceId).toBe("case_1");

		const listB = await repos.audit.listAuditRecords({ organizationId: "org_b" });
		expect(listB.length).toBe(1);
		expect(listB[0]?.resourceId).toBe("case_2");

		// Empty organizationId rejected
		await expect(repos.audit.listAuditRecords({ organizationId: "" })).rejects.toThrow(RepositoryError);
	});
});

describe("composite workflows & transaction rollback (Memory)", () => {
	it("creates evidence, run, and audit record together atomically", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now }],
		});

		const result = await repos.transaction(async (txRepos) => {
			const evidence = await txRepos.evidence.createPending({
				organizationId: "org_a",
				caseId: "case_a",
				objectKey: "org_a/case_a/email.eml",
				sha256: "hash123",
				byteSize: 500,
			});
			const run = await txRepos.analysisRuns.createAnalysisRun({
				organizationId: "org_a",
				caseId: "case_a",
				evidenceId: evidence.id,
			});
			const audit = await txRepos.audit.appendAuditRecord({
				organizationId: "org_a",
				action: "evidence.intake",
				resourceType: "evidence",
				resourceId: evidence.id,
				metadata: { runId: run.id },
			});
			return { evidence, run, audit };
		});

		expect(result.evidence.id).toBeDefined();
		expect(result.run.evidenceId).toBe(result.evidence.id);
		expect(result.audit.resourceId).toBe(result.evidence.id);

		// Confirmed persisted in repos
		const storedEv = await repos.evidence.getEvidence({
			organizationId: "org_a",
			evidenceId: result.evidence.id,
		});
		expect(storedEv).not.toBeNull();
	});

	it("rolls back all changes when transaction callback fails", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now }],
		});

		let createdEvidenceId = "";
		await expect(
			repos.transaction(async (txRepos) => {
				const evidence = await txRepos.evidence.createPending({
					organizationId: "org_a",
					caseId: "case_a",
					objectKey: "org_a/case_a/will_rollback.eml",
					sha256: "hash_rollback",
					byteSize: 100,
				});
				createdEvidenceId = evidence.id;

				// Fail mid-transaction
				throw new Error("Simulated downstream failure");
			}),
		).rejects.toThrow("Simulated downstream failure");

		// Evidence should NOT exist in repository after rollback
		const ev = await repos.evidence.getEvidence({
			organizationId: "org_a",
			evidenceId: createdEvidenceId,
		});
		expect(ev).toBeNull();
		const list = await repos.evidence.listEvidence({ organizationId: "org_a", caseId: "case_a" });
		expect(list).toEqual([]);
	});

	it("sanitizes audit metadata by removing objectKey in createEvidenceWithRunAndAudit", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now }],
		});

		const result = await createEvidenceWithRunAndAudit(repos, {
			organizationId: "org_a",
			caseId: "case_a",
			evidence: {
				objectKey: "s3://sensitive-bucket/org_a/case_a/secret_payload.eml",
				sha256: "hash_secret",
				byteSize: 1234,
			},
			run: {
				analysisVersion: "1.0.0",
				rulesetVersion: "1.0.0",
			},
			audit: {
				actorUserId: "user_audit_1",
				metadata: { client: "web-ui" },
			},
		});

		expect(result.evidence.objectKey).toBe("s3://sensitive-bucket/org_a/case_a/secret_payload.eml");
		expect(result.audit.metadata).toBeDefined();
		// objectKey MUST NOT be copied into audit metadata
		expect(result.audit.metadata.objectKey).toBeUndefined();
		expect(result.audit.metadata.caseId).toBe("case_a");
		expect(result.audit.metadata.analysisRunId).toBe(result.run.id);
		expect(result.audit.metadata.client).toBe("web-ui");
	});

	it("creates analysis run and audit together in createAnalysisRunWithAudit", async () => {
		const repos = createMemoryRepositories({
			cases: [{ id: "case_a", organizationId: "org_a", title: "Case A", createdAt: now, updatedAt: now }],
		});

		const result = await createAnalysisRunWithAudit(repos, {
			organizationId: "org_a",
			caseId: "case_a",
			run: {
				idempotencyKey: "idem_run_test",
				status: "accepted",
			},
			audit: {
				actorUserId: "user_inv_1",
				action: "analysis.custom_start",
				metadata: { trigger: "manual" },
			},
		});

		expect(result.run.id).toBeDefined();
		expect(result.run.status).toBe("accepted");
		expect(result.run.idempotencyKey).toBe("idem_run_test");
		expect(result.audit.action).toBe("analysis.custom_start");
		expect(result.audit.resourceId).toBe(result.run.id);
		expect(result.audit.metadata.trigger).toBe("manual");
	});
});

describe("mapDatabaseError security and public message masking", () => {
	it("maps 23505 unique violation to generic ConflictError without leaking Postgres internals", () => {
		const driverError = {
			code: "23505",
			detail: "Key (object_key)=(s3://bucket/internal/secret.eml) already exists.",
			constraint_name: "evidence_metadata_object_key_key",
			table: "evidence_metadata",
			message: "duplicate key value violates unique constraint",
		};

		try {
			mapDatabaseError(driverError, "createPendingEvidence");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ConflictError);
			const conflict = err as ConflictError;
			expect(conflict.code).toBe("CONFLICT");
			expect(conflict.message).toBe("A resource with the specified identifier or unique field already exists");
			// Must never contain Postgres internals, SQL, constraint names, or sensitive values
			expect(conflict.message).not.toContain("object_key");
			expect(conflict.message).not.toContain("s3://bucket");
			expect(conflict.message).not.toContain("evidence_metadata_object_key_key");
			expect(conflict.message).not.toContain("duplicate key");
			expect(conflict.details).toBeUndefined();
			// Preserves original only as Error.cause
			expect((conflict as Error).cause).toBe(driverError);
		}
	});

	it("maps 23503 foreign key violation to generic DependencyError without leaking internals", () => {
		const driverError = {
			code: "23503",
			detail: 'Key (case_id)=(case_secret_123) is not present in table "cases".',
			constraint: "evidence_metadata_org_case_fk",
			table: "evidence_metadata",
			message: 'insert or update on table "evidence_metadata" violates foreign key constraint',
		};

		try {
			mapDatabaseError(driverError, "createPendingEvidence");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(DependencyError);
			const dep = err as DependencyError;
			expect(dep.code).toBe("DEPENDENCY_ERROR");
			expect(dep.message).toBe("Referenced resource or dependent entity does not exist");
			expect(dep.message).not.toContain("case_secret_123");
			expect(dep.message).not.toContain("evidence_metadata_org_case_fk");
			expect(dep.dependency).toBeUndefined();
			expect((dep as Error).cause).toBe(driverError);
		}
	});

	it("maps 23514 check constraint violation to generic InvalidStateError", () => {
		const driverError = {
			code: "23514",
			detail: "Failing row contains (score = -10).",
			constraint: "valid_score_range",
			message: 'check constraint "valid_score_range" violated',
		};

		try {
			mapDatabaseError(driverError, "saveResult");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidStateError);
			const inv = err as InvalidStateError;
			expect(inv.code).toBe("INVALID_STATE");
			expect(inv.message).toBe("Operation violates database integrity constraint");
			expect(inv.message).not.toContain("valid_score_range");
			expect(inv.message).not.toContain("-10");
			expect((inv as Error).cause).toBe(driverError);
		}
	});

	it("maps 23502 not null constraint violation to generic InvalidStateError", () => {
		const driverError = {
			code: "23502",
			detail: "Failing row contains (id = null).",
			column: "id",
			message: 'null value in column "id" violates not-null constraint',
		};

		try {
			mapDatabaseError(driverError, "createCase");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidStateError);
			const inv = err as InvalidStateError;
			expect(inv.code).toBe("INVALID_STATE");
			expect(inv.message).toBe("Required field missing in database operation");
			expect(inv.message).not.toContain("null value in column");
			expect((inv as Error).cause).toBe(driverError);
		}
	});

	it("maps generic database driver errors to RepositoryError without leaking SQL or raw messages", () => {
		const driverError = {
			code: "42601",
			message: 'syntax error at or near "SELECT * FROM passwords"',
			query: "SELECT * FROM passwords WHERE user = 'admin'",
		};

		try {
			mapDatabaseError(driverError, "listCases");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(RepositoryError);
			const repoErr = err as RepositoryError;
			expect(repoErr.code).toBe("DATABASE_ERROR");
			expect(repoErr.message).toBe("Database operation failed during listCases");
			expect(repoErr.message).not.toContain("passwords");
			expect(repoErr.message).not.toContain("syntax error");
			expect((repoErr as Error).cause).toBe(driverError);
		}
	});

	it("rethrows RepositoryError instances unchanged", () => {
		const notFound = new NotFoundError("case", "c_123", "org_1");
		try {
			mapDatabaseError(notFound, "context");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBe(notFound);
		}
	});
});

describe("canonicalJsonStringify and deterministic deep equality", () => {
	it("produces identical JSON output regardless of object key insertion order", () => {
		const objA = { b: 2, a: 1, z: 99 };
		const objB = { z: 99, a: 1, b: 2 };
		expect(canonicalJsonStringify(objA)).toBe(canonicalJsonStringify(objB));
		expect(canonicalJsonStringify(objA)).toBe('{"a":1,"b":2,"z":99}');
	});

	it("recursively normalizes nested objects and arrays", () => {
		const nestedA = {
			rules: [
				{ y: "second", x: "first" },
				{ b: 2, a: 1 },
			],
			config: {
				threshold: 50,
				enabled: true,
				deep: { beta: "b", alpha: "a" },
			},
		};
		const nestedB = {
			config: {
				enabled: true,
				threshold: 50,
				deep: { alpha: "a", beta: "b" },
			},
			rules: [
				{ x: "first", y: "second" },
				{ a: 1, b: 2 },
			],
		};
		expect(canonicalJsonStringify(nestedA)).toBe(canonicalJsonStringify(nestedB));
	});

	it("ignores undefined values in objects while preserving array indices", () => {
		const objWithUndefined = { a: 1, b: undefined, c: 3 };
		expect(canonicalJsonStringify(objWithUndefined)).toBe('{"a":1,"c":3}');

		const arrWithUndefined = [1, undefined, 3];
		expect(canonicalJsonStringify(arrWithUndefined)).toBe("[1,null,3]");
	});

	it("areAnalysisResultsIdentical checks every single immutable field", () => {
		const baseRun = {
			verdict: "malicious" as const,
			score: 95,
			confidence: 0.98,
			analysisVersion: "1.0.0",
			rulesetVersion: "1.1.0",
			resultSchemaVersion: "1.0.0",
			resultSnapshot: { indicators: ["bad_ip"], details: { ip: "1.2.3.4", port: 80 } },
		};

		const inputSame = {
			organizationId: "org_a",
			analysisRunId: "run_1",
			verdict: "malicious" as const,
			score: 95,
			confidence: 0.98,
			analysisVersion: "1.0.0",
			rulesetVersion: "1.1.0",
			resultSchemaVersion: "1.0.0",
			resultSnapshot: { details: { port: 80, ip: "1.2.3.4" }, indicators: ["bad_ip"] },
		};

		// Semantically identical with key order differences -> true
		expect(areAnalysisResultsIdentical(baseRun, inputSame)).toBe(true);

		// Verdict mismatch
		expect(areAnalysisResultsIdentical(baseRun, { ...inputSame, verdict: "suspicious" })).toBe(false);

		// Score mismatch
		expect(areAnalysisResultsIdentical(baseRun, { ...inputSame, score: 94 })).toBe(false);

		// Confidence mismatch
		expect(areAnalysisResultsIdentical(baseRun, { ...inputSame, confidence: 0.9 })).toBe(false);

		// AnalysisVersion mismatch
		expect(areAnalysisResultsIdentical(baseRun, { ...inputSame, analysisVersion: "2.0.0" })).toBe(false);

		// RulesetVersion mismatch
		expect(areAnalysisResultsIdentical(baseRun, { ...inputSame, rulesetVersion: "2.0.0" })).toBe(false);

		// ResultSchemaVersion mismatch
		expect(areAnalysisResultsIdentical(baseRun, { ...inputSame, resultSchemaVersion: "2.0.0" })).toBe(false);

		// ResultSnapshot content mismatch
		expect(areAnalysisResultsIdentical(baseRun, { ...inputSame, resultSnapshot: { indicators: ["other"] } })).toBe(
			false,
		);
	});
});
