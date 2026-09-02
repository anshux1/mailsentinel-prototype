import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type TenantContext = { organizationId: string };
export type TenantCaseKey = TenantContext & { caseId: string };
export type CreateCaseInput = TenantContext & { title: string };
export type CaseShell = typeof schema.cases.$inferSelect;

export interface OrganizationRepository {
	getOrganization(input: TenantContext): Promise<typeof schema.organizations.$inferSelect | null>;
}
export interface MembershipRepository {
	listMemberships(input: TenantContext): Promise<(typeof schema.memberships.$inferSelect)[]>;
}
export interface CaseRepository {
	listCases(input: TenantContext): Promise<CaseShell[]>;
	getCase(input: TenantCaseKey): Promise<CaseShell | null>;
	createCase(input: CreateCaseInput): Promise<CaseShell>;
}
export interface EvidenceRepository {
	listEvidence(input: TenantCaseKey): Promise<(typeof schema.evidenceMetadata.$inferSelect)[]>;
}
export interface AnalysisRunRepository {
	getAnalysisRun(
		input: TenantContext & { analysisRunId: string },
	): Promise<typeof schema.analysisRuns.$inferSelect | null>;
}
export interface AuditRepository {
	listAuditRecords(input: TenantContext): Promise<(typeof schema.auditRecords.$inferSelect)[]>;
}

export class DrizzleCaseRepository implements CaseRepository {
	constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

	listCases({ organizationId }: TenantContext): Promise<CaseShell[]> {
		return this.db.select().from(schema.cases).where(eq(schema.cases.organizationId, organizationId));
	}

	async getCase({ organizationId, caseId }: TenantCaseKey): Promise<CaseShell | null> {
		const [result] = await this.db
			.select()
			.from(schema.cases)
			.where(and(eq(schema.cases.organizationId, organizationId), eq(schema.cases.id, caseId)))
			.limit(1);
		return result ?? null;
	}

	async createCase({ organizationId, title }: CreateCaseInput): Promise<CaseShell> {
		const [created] = await this.db
			.insert(schema.cases)
			.values({ id: `case_${randomUUID()}`, organizationId, title })
			.returning();
		if (!created) throw new Error("case creation returned no record");
		return created;
	}
}

/** Deterministic test adapter that enforces the same tenant boundary as production. */
export class MemoryCaseRepository implements CaseRepository {
	constructor(private readonly records: CaseShell[]) {}
	async listCases({ organizationId }: TenantContext): Promise<CaseShell[]> {
		return this.records.filter((record) => record.organizationId === organizationId);
	}
	async getCase({ organizationId, caseId }: TenantCaseKey): Promise<CaseShell | null> {
		return this.records.find((record) => record.organizationId === organizationId && record.id === caseId) ?? null;
	}
	async createCase({ organizationId, title }: CreateCaseInput): Promise<CaseShell> {
		const now = new Date();
		const record: CaseShell = {
			id: `case_${randomUUID()}`,
			organizationId,
			title,
			createdAt: now,
			updatedAt: now,
		};
		this.records.push(record);
		return record;
	}
}
