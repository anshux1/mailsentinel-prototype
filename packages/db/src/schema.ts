import { relations } from "drizzle-orm";
import {
	boolean,
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	real,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const role = pgEnum("membership_role", ["owner", "investigator", "viewer"]);
export const analysisRunStatus = pgEnum("analysis_run_status", [
	"accepted",
	"queued",
	"processing",
	"completed",
	"deferred",
	"failed",
]);
export const analysisVerdict = pgEnum("analysis_verdict", ["unknown", "benign", "suspicious", "malicious"]);
export const evidenceStatus = pgEnum("evidence_status", ["pending", "stored", "verified", "failed"]);
export const reportStatus = pgEnum("report_status", ["pending", "generating", "completed", "failed"]);
export const reportFormat = pgEnum("report_format", ["json", "html", "pdf", "markdown", "text"]);

// Better Auth tables follow the installed adapter's required field names.
export const user = pgTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	...timestamps,
});

export const session = pgTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		token: text("token").notNull().unique(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		...timestamps,
	},
	(table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
	"account",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		issuer: text("issuer"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
		scope: text("scope"),
		password: text("password"),
		...timestamps,
	},
	(table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = pgTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		...timestamps,
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organizations = pgTable("organizations", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	...timestamps,
});

export const memberships = pgTable(
	"memberships",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: role("role").default("investigator").notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("memberships_org_user_uidx").on(table.organizationId, table.userId),
		index("memberships_user_idx").on(table.userId),
	],
);

export const cases = pgTable(
	"cases",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("cases_organization_id_uidx").on(table.organizationId, table.id),
		index("cases_organization_idx").on(table.organizationId),
		index("cases_org_created_idx").on(table.organizationId, table.createdAt),
	],
);

export const evidenceMetadata = pgTable(
	"evidence_metadata",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		caseId: text("case_id")
			.notNull()
			.references(() => cases.id, { onDelete: "cascade" }),
		objectKey: text("object_key").notNull().unique(),
		sha256: text("sha256").notNull(),
		byteSize: integer("byte_size").notNull(),
		contentType: text("content_type").default("message/rfc822").notNull(),
		status: evidenceStatus("status").default("verified").notNull(),
		idempotencyKey: text("idempotency_key"),
		storedAt: timestamp("stored_at", { withTimezone: true }),
		verifiedAt: timestamp("verified_at", { withTimezone: true }),
		failedAt: timestamp("failed_at", { withTimezone: true }),
		failureReason: text("failure_reason"),
		...timestamps,
	},
	(table) => [
		foreignKey({
			columns: [table.organizationId, table.caseId],
			foreignColumns: [cases.organizationId, cases.id],
			name: "evidence_metadata_org_case_fk",
		}),
		uniqueIndex("evidence_org_case_id_uidx").on(table.organizationId, table.caseId, table.id),
		uniqueIndex("evidence_org_id_uidx").on(table.organizationId, table.id),
		uniqueIndex("evidence_org_idempotency_key_uidx").on(table.organizationId, table.idempotencyKey),
		index("evidence_org_case_idx").on(table.organizationId, table.caseId),
		index("evidence_org_status_idx").on(table.organizationId, table.status),
		index("evidence_org_created_idx").on(table.organizationId, table.createdAt),
	],
);

export const analysisRuns = pgTable(
	"analysis_runs",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		caseId: text("case_id")
			.notNull()
			.references(() => cases.id, { onDelete: "cascade" }),
		evidenceId: text("evidence_id").references(() => evidenceMetadata.id, { onDelete: "restrict" }),
		status: analysisRunStatus("status").default("accepted").notNull(),
		verdict: analysisVerdict("verdict"),
		score: integer("score"),
		confidence: real("confidence"),
		analysisVersion: text("analysis_version"),
		rulesetVersion: text("ruleset_version"),
		resultSchemaVersion: text("result_schema_version"),
		resultSnapshot: jsonb("result_snapshot"),
		failureCode: text("failure_code"),
		failureMessage: text("failure_message"),
		retryable: boolean("retryable").default(false).notNull(),
		attempts: integer("attempts").default(0).notNull(),
		queuedAt: timestamp("queued_at", { withTimezone: true }),
		startedAt: timestamp("started_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		failedAt: timestamp("failed_at", { withTimezone: true }),
		idempotencyKey: text("idempotency_key"),
		phase: text("phase"),
		progress: integer("progress"),
		...timestamps,
	},
	(table) => [
		foreignKey({
			columns: [table.organizationId, table.caseId],
			foreignColumns: [cases.organizationId, cases.id],
			name: "analysis_runs_org_case_fk",
		}),
		foreignKey({
			columns: [table.organizationId, table.caseId, table.evidenceId],
			foreignColumns: [evidenceMetadata.organizationId, evidenceMetadata.caseId, evidenceMetadata.id],
			name: "analysis_runs_org_case_evidence_fk",
		}),
		uniqueIndex("analysis_runs_org_case_id_uidx").on(table.organizationId, table.caseId, table.id),
		uniqueIndex("analysis_runs_org_id_uidx").on(table.organizationId, table.id),
		uniqueIndex("analysis_runs_idempotency_key_uidx").on(table.organizationId, table.idempotencyKey),
		index("analysis_runs_org_case_idx").on(table.organizationId, table.caseId),
		index("analysis_runs_status_idx").on(table.organizationId, table.status),
		index("analysis_runs_verdict_idx").on(table.organizationId, table.verdict),
		index("analysis_runs_evidence_idx").on(table.organizationId, table.evidenceId),
		index("analysis_runs_org_created_idx").on(table.organizationId, table.createdAt),
	],
);

export const reports = pgTable(
	"reports",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		caseId: text("case_id")
			.notNull()
			.references(() => cases.id, { onDelete: "cascade" }),
		analysisRunId: text("analysis_run_id")
			.notNull()
			.references(() => analysisRuns.id, { onDelete: "cascade" }),
		version: integer("version").default(1).notNull(),
		status: reportStatus("status").default("pending").notNull(),
		format: reportFormat("format").default("html").notNull(),
		objectKey: text("object_key"),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
		failureReason: text("failure_reason"),
		generatedAt: timestamp("generated_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		foreignKey({
			columns: [table.organizationId, table.caseId],
			foreignColumns: [cases.organizationId, cases.id],
			name: "reports_org_case_fk",
		}),
		foreignKey({
			columns: [table.organizationId, table.caseId, table.analysisRunId],
			foreignColumns: [analysisRuns.organizationId, analysisRuns.caseId, analysisRuns.id],
			name: "reports_org_case_run_fk",
		}),
		uniqueIndex("reports_org_case_id_uidx").on(table.organizationId, table.caseId, table.id),
		uniqueIndex("reports_org_id_uidx").on(table.organizationId, table.id),
		uniqueIndex("reports_org_run_version_format_uidx").on(
			table.organizationId,
			table.analysisRunId,
			table.version,
			table.format,
		),
		uniqueIndex("reports_object_key_uidx").on(table.objectKey),
		index("reports_org_case_idx").on(table.organizationId, table.caseId),
		index("reports_org_run_idx").on(table.organizationId, table.analysisRunId),
		index("reports_org_status_idx").on(table.organizationId, table.status),
		index("reports_org_created_idx").on(table.organizationId, table.createdAt),
	],
);

export const auditRecords = pgTable(
	"audit_records",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
		action: text("action").notNull(),
		resourceType: text("resource_type").notNull(),
		resourceId: text("resource_id"),
		metadata: jsonb("metadata").$type<Record<string, string>>().default({}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("audit_records_organization_idx").on(table.organizationId),
		index("audit_records_resource_idx").on(table.organizationId, table.resourceType, table.resourceId),
		index("audit_records_created_idx").on(table.organizationId, table.createdAt),
	],
);

export const organizationRelations = relations(organizations, ({ many }) => ({
	memberships: many(memberships),
	cases: many(cases),
	evidence: many(evidenceMetadata),
	analysisRuns: many(analysisRuns),
	reports: many(reports),
	auditRecords: many(auditRecords),
}));

export const caseRelations = relations(cases, ({ one, many }) => ({
	organization: one(organizations, { fields: [cases.organizationId], references: [organizations.id] }),
	evidence: many(evidenceMetadata),
	analysisRuns: many(analysisRuns),
	reports: many(reports),
}));

export const evidenceMetadataRelations = relations(evidenceMetadata, ({ one, many }) => ({
	organization: one(organizations, { fields: [evidenceMetadata.organizationId], references: [organizations.id] }),
	case: one(cases, { fields: [evidenceMetadata.caseId], references: [cases.id] }),
	analysisRuns: many(analysisRuns),
}));

export const analysisRunRelations = relations(analysisRuns, ({ one, many }) => ({
	organization: one(organizations, { fields: [analysisRuns.organizationId], references: [organizations.id] }),
	case: one(cases, { fields: [analysisRuns.caseId], references: [cases.id] }),
	evidence: one(evidenceMetadata, { fields: [analysisRuns.evidenceId], references: [evidenceMetadata.id] }),
	reports: many(reports),
}));

export const reportRelations = relations(reports, ({ one }) => ({
	organization: one(organizations, { fields: [reports.organizationId], references: [organizations.id] }),
	case: one(cases, { fields: [reports.caseId], references: [cases.id] }),
	analysisRun: one(analysisRuns, { fields: [reports.analysisRunId], references: [analysisRuns.id] }),
}));

export const auditRecordRelations = relations(auditRecords, ({ one }) => ({
	organization: one(organizations, { fields: [auditRecords.organizationId], references: [organizations.id] }),
	actor: one(user, { fields: [auditRecords.actorUserId], references: [user.id] }),
}));
