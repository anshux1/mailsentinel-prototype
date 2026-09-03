import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel";

describe("schema structural integrity", () => {
	it("exposes all required analysis_runs application fields", () => {
		const cols = schema.analysisRuns;
		expect(cols.id).toBeDefined();
		expect(cols.organizationId).toBeDefined();
		expect(cols.caseId).toBeDefined();
		expect(cols.evidenceId).toBeDefined();
		expect(cols.status).toBeDefined();
		expect(cols.verdict).toBeDefined();
		expect(cols.score).toBeDefined();
		expect(cols.confidence).toBeDefined();
		expect(cols.analysisVersion).toBeDefined();
		expect(cols.rulesetVersion).toBeDefined();
		expect(cols.resultSchemaVersion).toBeDefined();
		expect(cols.resultSnapshot).toBeDefined();
		expect(cols.failureCode).toBeDefined();
		expect(cols.failureMessage).toBeDefined();
		expect(cols.retryable).toBeDefined();
		expect(cols.attempts).toBeDefined();
		expect(cols.queuedAt).toBeDefined();
		expect(cols.startedAt).toBeDefined();
		expect(cols.completedAt).toBeDefined();
		expect(cols.failedAt).toBeDefined();
		expect(cols.idempotencyKey).toBeDefined();
		expect(cols.phase).toBeDefined();
		expect(cols.progress).toBeDefined();
	});

	it("exposes evidence lifecycle and upload idempotency fields", () => {
		const cols = schema.evidenceMetadata;
		expect(cols.status).toBeDefined();
		expect(cols.idempotencyKey).toBeDefined();
		expect(cols.storedAt).toBeDefined();
		expect(cols.verifiedAt).toBeDefined();
		expect(cols.failedAt).toBeDefined();
		expect(cols.failureReason).toBeDefined();
		expect(cols.batchId).toBeDefined();
		expect(cols.sequence).toBeDefined();
		expect(cols.sourceMessageId).toBeDefined();
	});

	it("exposes ingestion_batches fields", () => {
		const cols = schema.ingestionBatches;
		expect(cols.id).toBeDefined();
		expect(cols.organizationId).toBeDefined();
		expect(cols.caseId).toBeDefined();
		expect(cols.source).toBeDefined();
		expect(cols.status).toBeDefined();
		expect(cols.containerEvidenceId).toBeDefined();
		expect(cols.messageCount).toBeDefined();
		expect(cols.readyCount).toBeDefined();
		expect(cols.failedCount).toBeDefined();
		expect(cols.metadata).toBeDefined();
		expect(cols.failureReason).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.updatedAt).toBeDefined();
	});

	it("exposes mailbox_connections fields", () => {
		const cols = schema.mailboxConnections;
		expect(cols.id).toBeDefined();
		expect(cols.organizationId).toBeDefined();
		expect(cols.provider).toBeDefined();
		expect(cols.accountEmail).toBeDefined();
		expect(cols.encryptedRefreshToken).toBeDefined();
		expect(cols.tokenNonce).toBeDefined();
		expect(cols.scopes).toBeDefined();
		expect(cols.syncCursor).toBeDefined();
		expect(cols.status).toBeDefined();
		expect(cols.lastSyncedAt).toBeDefined();
		expect(cols.lastFailureReason).toBeDefined();
		expect(cols.createdByUserId).toBeDefined();
		expect(cols.createdAt).toBeDefined();
		expect(cols.updatedAt).toBeDefined();
	});

	it("exposes reports table with tenant/case/run scope and versioning", () => {
		const cols = schema.reports;
		expect(cols.id).toBeDefined();
		expect(cols.organizationId).toBeDefined();
		expect(cols.caseId).toBeDefined();
		expect(cols.analysisRunId).toBeDefined();
		expect(cols.version).toBeDefined();
		expect(cols.status).toBeDefined();
		expect(cols.format).toBeDefined();
		expect(cols.objectKey).toBeDefined();
		expect(cols.metadata).toBeDefined();
		expect(cols.failureReason).toBeDefined();
		expect(cols.generatedAt).toBeDefined();
	});

	it("preserves append-only audit semantics without updatedAt column", () => {
		const cols = schema.auditRecords;
		expect(cols.createdAt).toBeDefined();
		expect((cols as unknown as Record<string, unknown>).updatedAt).toBeUndefined();
	});
});

describe("database constraints and migration verification", () => {
	let sql: postgres.Sql;

	beforeAll(async () => {
		sql = postgres(databaseUrl, { max: 2 });
	});

	afterAll(async () => {
		await sql.end();
	});

	it("verifies existing seeded demo records remain valid", async () => {
		const [org] = await sql`SELECT id, name FROM organizations WHERE id = 'org_demo'`;
		expect(org).toBeDefined();
		expect(org?.id).toBe("org_demo");
	});

	it("rejects cross-tenant composite FK violations between cases and evidence", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgA = `org_a_${uid}`;
		const orgB = `org_b_${uid}`;
		const caseA = `case_a_${uid}`;
		const evId = `ev_${uid}`;

		await sql`INSERT INTO organizations (id, name) VALUES (${orgA}, 'Org A'), (${orgB}, 'Org B')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseA}, ${orgA}, 'Case A')`;

		// Attempting to attach evidence to orgB while referencing caseA (owned by orgA)
		await expect(
			sql`
				INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size, status)
				VALUES (${evId}, ${orgB}, ${caseA}, ${`key_${uid}`}, 'abc123', 100, 'verified')
			`,
		).rejects.toThrow();

		// Cleanup
		await sql`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
	});

	it("rejects cross-tenant composite FK violations between runs and reports", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgA = `org_a_${uid}`;
		const orgB = `org_b_${uid}`;
		const caseA = `case_a_${uid}`;
		const evA = `ev_a_${uid}`;
		const runA = `run_a_${uid}`;
		const reportId = `report_${uid}`;

		await sql`INSERT INTO organizations (id, name) VALUES (${orgA}, 'Org A'), (${orgB}, 'Org B')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseA}, ${orgA}, 'Case A')`;
		await sql`
			INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size, status)
			VALUES (${evA}, ${orgA}, ${caseA}, ${`key_${uid}`}, 'abc123', 100, 'verified')
		`;
		await sql`
			INSERT INTO analysis_runs (id, organization_id, case_id, evidence_id, status)
			VALUES (${runA}, ${orgA}, ${caseA}, ${evA}, 'completed')
		`;

		// Attempting to insert a report under orgB referencing caseA and runA from orgA
		await expect(
			sql`
				INSERT INTO reports (id, organization_id, case_id, analysis_run_id, version, status, format)
				VALUES (${reportId}, ${orgB}, ${caseA}, ${runA}, 1, 'completed', 'html')
			`,
		).rejects.toThrow();

		// Cleanup
		await sql`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
	});

	it("enforces analysis_runs idempotency key uniqueness per organization", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgId = `org_${uid}`;
		const caseId = `case_${uid}`;
		const evId = `ev_${uid}`;
		const run1 = `run1_${uid}`;
		const run2 = `run2_${uid}`;
		const idempotencyKey = `idem_${uid}`;

		await sql`INSERT INTO organizations (id, name) VALUES (${orgId}, 'Test Org')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseId}, ${orgId}, 'Case')`;
		await sql`
			INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size, status)
			VALUES (${evId}, ${orgId}, ${caseId}, ${`key_${uid}`}, 'hash123', 50, 'verified')
		`;

		await sql`
			INSERT INTO analysis_runs (id, organization_id, case_id, evidence_id, status, idempotency_key)
			VALUES (${run1}, ${orgId}, ${caseId}, ${evId}, 'accepted', ${idempotencyKey})
		`;

		// Duplicate idempotencyKey in the same organization must fail
		await expect(
			sql`
				INSERT INTO analysis_runs (id, organization_id, case_id, evidence_id, status, idempotency_key)
				VALUES (${run2}, ${orgId}, ${caseId}, ${evId}, 'accepted', ${idempotencyKey})
			`,
		).rejects.toThrow();

		// Cleanup
		await sql`DELETE FROM organizations WHERE id = ${orgId}`;
	});

	it("enforces evidence upload idempotency key uniqueness per organization", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgId = `org_${uid}`;
		const caseId = `case_${uid}`;
		const ev1 = `ev1_${uid}`;
		const ev2 = `ev2_${uid}`;
		const idempotencyKey = `ev_idem_${uid}`;

		await sql`INSERT INTO organizations (id, name) VALUES (${orgId}, 'Test Org')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseId}, ${orgId}, 'Case')`;

		await sql`
			INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size, status, idempotency_key)
			VALUES (${ev1}, ${orgId}, ${caseId}, ${`key1_${uid}`}, 'hash1', 50, 'pending', ${idempotencyKey})
		`;

		// Duplicate evidence upload idempotencyKey in the same organization must fail
		await expect(
			sql`
				INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size, status, idempotency_key)
				VALUES (${ev2}, ${orgId}, ${caseId}, ${`key2_${uid}`}, 'hash2', 50, 'pending', ${idempotencyKey})
			`,
		).rejects.toThrow();

		// Cleanup
		await sql`DELETE FROM organizations WHERE id = ${orgId}`;
	});

	it("enforces report version immutability per run and format", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgId = `org_${uid}`;
		const caseId = `case_${uid}`;
		const evId = `ev_${uid}`;
		const runId = `run_${uid}`;
		const rep1 = `rep1_${uid}`;
		const rep2 = `rep2_${uid}`;

		await sql`INSERT INTO organizations (id, name) VALUES (${orgId}, 'Test Org')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseId}, ${orgId}, 'Case')`;
		await sql`
			INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size, status)
			VALUES (${evId}, ${orgId}, ${caseId}, ${`key_${uid}`}, 'hash123', 50, 'verified')
		`;
		await sql`
			INSERT INTO analysis_runs (id, organization_id, case_id, evidence_id, status)
			VALUES (${runId}, ${orgId}, ${caseId}, ${evId}, 'completed')
		`;

		await sql`
			INSERT INTO reports (id, organization_id, case_id, analysis_run_id, version, status, format, object_key)
			VALUES (${rep1}, ${orgId}, ${caseId}, ${runId}, 1, 'completed', 'html', ${`rep_key1_${uid}`})
		`;

		// Inserting duplicate report with same (org, run, version=1, format='html') must fail
		await expect(
			sql`
				INSERT INTO reports (id, organization_id, case_id, analysis_run_id, version, status, format, object_key)
				VALUES (${rep2}, ${orgId}, ${caseId}, ${runId}, 1, 'completed', 'html', ${`rep_key2_${uid}`})
			`,
		).rejects.toThrow();

		// Different version (version=2) succeeds
		const [v2] = await sql`
			INSERT INTO reports (id, organization_id, case_id, analysis_run_id, version, status, format, object_key)
			VALUES (${rep2}, ${orgId}, ${caseId}, ${runId}, 2, 'completed', 'html', ${`rep_key2_${uid}`})
			RETURNING id, version
		`;
		expect(v2).toBeDefined();
		expect(v2?.version).toBe(2);

		// Cleanup
		await sql`DELETE FROM organizations WHERE id = ${orgId}`;
	});

	it("confirms required query indexes exist in PostgreSQL catalog", async () => {
		const indexes = await sql<{ indexname: string }[]>`
			SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
		`;
		const indexNames = new Set(indexes.map((r) => r.indexname));

		// Case list index
		expect(indexNames.has("cases_org_created_idx")).toBe(true);

		// Status polling & verdict filter indexes
		expect(indexNames.has("analysis_runs_status_idx")).toBe(true);
		expect(indexNames.has("analysis_runs_verdict_idx")).toBe(true);
		expect(indexNames.has("analysis_runs_idempotency_key_uidx")).toBe(true);
		expect(indexNames.has("analysis_runs_org_case_id_uidx")).toBe(true);

		// Evidence lifecycle & idempotency indexes
		expect(indexNames.has("evidence_org_status_idx")).toBe(true);
		expect(indexNames.has("evidence_org_idempotency_key_uidx")).toBe(true);

		// Report lookup & version indexes
		expect(indexNames.has("reports_org_case_idx")).toBe(true);
		expect(indexNames.has("reports_org_run_idx")).toBe(true);
		expect(indexNames.has("reports_org_status_idx")).toBe(true);
		expect(indexNames.has("reports_org_run_version_format_uidx")).toBe(true);

		// Batch & mailbox indexes
		expect(indexNames.has("ingestion_batches_org_case_created_idx")).toBe(true);
		expect(indexNames.has("ingestion_batches_org_case_idx")).toBe(true);
		expect(indexNames.has("mailbox_connections_org_provider_email_uidx")).toBe(true);
		expect(indexNames.has("mailbox_connections_org_idx")).toBe(true);
		expect(indexNames.has("evidence_org_batch_seq_uidx")).toBe(true);
	});

	it("enforces tenant-scoped container references and unique child sequences", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgA = `org_ca_${uid}`;
		const orgB = `org_cb_${uid}`;
		const caseA = `case_ca_${uid}`;
		const caseB = `case_cb_${uid}`;
		const evidenceA = `ev_ca_${uid}`;
		const batchB = `batch_cb_${uid}`;
		await sql`INSERT INTO organizations (id, name) VALUES (${orgA}, 'A'), (${orgB}, 'B')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseA}, ${orgA}, 'A'), (${caseB}, ${orgB}, 'B')`;
		await sql`INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size, status)
			VALUES (${evidenceA}, ${orgA}, ${caseA}, ${`container_${uid}`}, 'hash', 10, 'verified')`;
		await expect(sql`INSERT INTO ingestion_batches
			(id, organization_id, case_id, source, status, container_evidence_id)
			VALUES (${batchB}, ${orgB}, ${caseB}, 'upload_container', 'segmenting', ${evidenceA})`).rejects.toThrow();
		await sql`INSERT INTO ingestion_batches (id, organization_id, case_id, source, status, message_count)
			VALUES (${batchB}, ${orgB}, ${caseB}, 'upload_container', 'segmenting', 2)`;
		await sql`INSERT INTO evidence_metadata
			(id, organization_id, case_id, batch_id, sequence, object_key, sha256, byte_size, status)
			VALUES (${`child1_${uid}`}, ${orgB}, ${caseB}, ${batchB}, 0, ${`child1_${uid}`}, 'hash', 5, 'verified')`;
		await expect(sql`INSERT INTO evidence_metadata
			(id, organization_id, case_id, batch_id, sequence, object_key, sha256, byte_size, status)
			VALUES (${`child2_${uid}`}, ${orgB}, ${caseB}, ${batchB}, 0, ${`child2_${uid}`}, 'hash', 5, 'verified')`).rejects.toThrow();
		await sql`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
	});

	it("rejects cross-tenant composite FK violations between cases and ingestion_batches", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgA = `org_a_${uid}`;
		const orgB = `org_b_${uid}`;
		const caseA = `case_a_${uid}`;
		const batchId = `batch_${uid}`;

		await sql`INSERT INTO organizations (id, name) VALUES (${orgA}, 'Org A'), (${orgB}, 'Org B')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseA}, ${orgA}, 'Case A')`;

		// Attempting to attach batch to orgB while referencing caseA (owned by orgA)
		await expect(
			sql`
				INSERT INTO ingestion_batches (id, organization_id, case_id, source, status)
				VALUES (${batchId}, ${orgB}, ${caseA}, 'upload_single', 'ready')
			`,
		).rejects.toThrow();

		await sql`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
	});

	it("rejects cross-tenant composite FK violations between batches and evidence_metadata", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgA = `org_a_${uid}`;
		const orgB = `org_b_${uid}`;
		const caseA = `case_a_${uid}`;
		const caseB = `case_b_${uid}`;
		const batchA = `batch_a_${uid}`;
		const evB = `ev_b_${uid}`;

		await sql`INSERT INTO organizations (id, name) VALUES (${orgA}, 'Org A'), (${orgB}, 'Org B')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseA}, ${orgA}, 'Case A'), (${caseB}, ${orgB}, 'Case B')`;
		await sql`
			INSERT INTO ingestion_batches (id, organization_id, case_id, source, status)
			VALUES (${batchA}, ${orgA}, ${caseA}, 'upload_single', 'ready')
		`;

		// Attempting to attach evidence under orgB/caseB with batchA owned by orgA/caseA
		await expect(
			sql`
				INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size, status, batch_id)
				VALUES (${evB}, ${orgB}, ${caseB}, ${`key_${uid}`}, 'abc123', 100, 'verified', ${batchA})
			`,
		).rejects.toThrow();

		await sql`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
	});

	it("rejects duplicate mailbox accounts per organization", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgId = `org_${uid}`;
		const conn1 = `conn1_${uid}`;
		const conn2 = `conn2_${uid}`;
		const email = `security-${uid}@example.com`;

		await sql`INSERT INTO organizations (id, name) VALUES (${orgId}, 'Test Org')`;
		await sql`
			INSERT INTO mailbox_connections (id, organization_id, provider, account_email, encrypted_refresh_token, token_nonce)
			VALUES (${conn1}, ${orgId}, 'gmail', ${email}, 'enc_token_1', 'nonce_1')
		`;

		// Duplicate provider + account_email for the same organization must fail
		await expect(
			sql`
				INSERT INTO mailbox_connections (id, organization_id, provider, account_email, encrypted_refresh_token, token_nonce)
				VALUES (${conn2}, ${orgId}, 'gmail', ${email}, 'enc_token_2', 'nonce_2')
			`,
		).rejects.toThrow();

		await sql`DELETE FROM organizations WHERE id = ${orgId}`;
	});

	it("allows rows with batch_id = null to be read and listed without error", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgId = `org_${uid}`;
		const caseId = `case_${uid}`;
		const evId = `ev_${uid}`;

		await sql`INSERT INTO organizations (id, name) VALUES (${orgId}, 'Test Org')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseId}, ${orgId}, 'Case')`;
		await sql`
			INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size, status, batch_id)
			VALUES (${evId}, ${orgId}, ${caseId}, ${`key_${uid}`}, 'abc123', 100, 'verified', NULL)
		`;

		const rows = await sql<{ id: string; batch_id: string | null }[]>`
			SELECT id, batch_id FROM evidence_metadata WHERE organization_id = ${orgId} AND case_id = ${caseId}
		`;
		expect(rows.length).toBe(1);
		expect(rows[0]?.id).toBe(evId);
		expect(rows[0]?.batch_id).toBeNull();

		await sql`DELETE FROM organizations WHERE id = ${orgId}`;
	});

	it("allows pre-existing evidence inserted without batch columns to be read cleanly", async () => {
		const uid = randomUUID().replace(/-/g, "").slice(0, 8);
		const orgId = `org_${uid}`;
		const caseId = `case_${uid}`;
		const evId = `ev_legacy_${uid}`;

		await sql`INSERT INTO organizations (id, name) VALUES (${orgId}, 'Legacy Org')`;
		await sql`INSERT INTO cases (id, organization_id, title) VALUES (${caseId}, ${orgId}, 'Legacy Case')`;
		// Legacy insert omitting batch_id, sequence, source_message_id entirely
		await sql`
			INSERT INTO evidence_metadata (id, organization_id, case_id, object_key, sha256, byte_size, status)
			VALUES (${evId}, ${orgId}, ${caseId}, ${`key_legacy_${uid}`}, 'legacy123', 50, 'verified')
		`;

		const rows = await sql<
			{
				id: string;
				batch_id: string | null;
				sequence: number | null;
				source_message_id: string | null;
			}[]
		>`
			SELECT id, batch_id, sequence, source_message_id FROM evidence_metadata WHERE id = ${evId}
		`;
		expect(rows.length).toBe(1);
		expect(rows[0]?.id).toBe(evId);
		expect(rows[0]?.batch_id).toBeNull();
		expect(rows[0]?.sequence).toBeNull();
		expect(rows[0]?.source_message_id).toBeNull();

		await sql`DELETE FROM organizations WHERE id = ${orgId}`;
	});
});
