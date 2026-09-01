import { relations } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const timestamps = {
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const role = pgEnum("membership_role", ["owner", "investigator", "viewer"]);
export const analysisRunStatus = pgEnum("analysis_run_status", ["accepted", "queued", "deferred", "failed"]);

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
	(table) => [index("cases_organization_idx").on(table.organizationId)],
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
		...timestamps,
	},
	(table) => [index("evidence_org_case_idx").on(table.organizationId, table.caseId)],
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
		status: analysisRunStatus("status").default("accepted").notNull(),
		failureCode: text("failure_code"),
		...timestamps,
	},
	(table) => [index("analysis_runs_org_case_idx").on(table.organizationId, table.caseId)],
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
	(table) => [index("audit_records_organization_idx").on(table.organizationId)],
);

export const organizationRelations = relations(organizations, ({ many }) => ({
	memberships: many(memberships),
	cases: many(cases),
}));
export const caseRelations = relations(cases, ({ one, many }) => ({
	organization: one(organizations, { fields: [cases.organizationId], references: [organizations.id] }),
	evidence: many(evidenceMetadata),
	analysisRuns: many(analysisRuns),
}));
