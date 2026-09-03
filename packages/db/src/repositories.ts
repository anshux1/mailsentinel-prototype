import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
	assertOrganizationId,
	ConflictError,
	DependencyError,
	InvalidStateError,
	isDatabaseError,
	mapDatabaseError,
	NotFoundError,
	RepositoryError,
} from "./errors";
import * as schema from "./schema";

export * from "./errors";

export function canonicalJsonStringify(value: unknown, seen = new WeakSet<object>()): string {
	if (value === undefined) {
		return "undefined";
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
		return canonicalJsonStringify((value as { toJSON: () => unknown }).toJSON(), seen);
	}
	if (seen.has(value)) {
		throw new TypeError("Converting circular structure to JSON in canonicalJsonStringify");
	}
	seen.add(value);

	if (Array.isArray(value)) {
		const items = value.map((item) => (item === undefined ? "null" : canonicalJsonStringify(item, seen)));
		seen.delete(value);
		return `[${items.join(",")}]`;
	}

	const obj = value as Record<string, unknown>;
	const sortedKeys = Object.keys(obj)
		.filter((key) => obj[key] !== undefined)
		.sort();
	const pairs = sortedKeys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(obj[key], seen)}`);
	seen.delete(value);
	return `{${pairs.join(",")}}`;
}

export function areNumbersEqual(a: number | null, b: number, tolerance = 1e-5): boolean {
	if (a === null) return false;
	if (Object.is(a, b)) return true;
	return Math.abs(a - b) < tolerance;
}

export function areAnalysisResultsIdentical(
	existing: {
		verdict: AnalysisVerdict | null;
		score: number | null;
		confidence: number | null;
		analysisVersion: string | null;
		rulesetVersion: string | null;
		resultSchemaVersion: string | null;
		resultSnapshot: unknown;
	},
	input: SaveAnalysisResultInput,
): boolean {
	if (existing.verdict !== input.verdict) return false;
	if (existing.score !== input.score) return false;
	if (!areNumbersEqual(existing.confidence, input.confidence)) return false;
	if (existing.analysisVersion !== input.analysisVersion) return false;
	if (existing.rulesetVersion !== input.rulesetVersion) return false;
	if (existing.resultSchemaVersion !== input.resultSchemaVersion) return false;

	return canonicalJsonStringify(existing.resultSnapshot) === canonicalJsonStringify(input.resultSnapshot);
}

// biome-ignore lint/suspicious/noExplicitAny: Drizzle supports both root database and transaction instances
export type DrizzleClient = PgDatabase<any, typeof schema, any> | PostgresJsDatabase<typeof schema>;

export type TenantContext = { organizationId: string };
export type TenantCaseKey = TenantContext & { caseId: string };

export type CaseShell = typeof schema.cases.$inferSelect;
export type EvidenceShell = typeof schema.evidenceMetadata.$inferSelect;
export type AnalysisRunShell = typeof schema.analysisRuns.$inferSelect;
export type ReportShell = typeof schema.reports.$inferSelect;
export type AuditRecordShell = typeof schema.auditRecords.$inferSelect;
export type OrganizationShell = typeof schema.organizations.$inferSelect;
export type MembershipShell = typeof schema.memberships.$inferSelect;

export type AnalysisRunStatus = (typeof schema.analysisRunStatus.enumValues)[number];
export type AnalysisVerdict = (typeof schema.analysisVerdict.enumValues)[number];
export type EvidenceStatus = (typeof schema.evidenceStatus.enumValues)[number];
export type ReportStatus = (typeof schema.reportStatus.enumValues)[number];
export type ReportFormat = (typeof schema.reportFormat.enumValues)[number];

export type CreateCaseInput = TenantContext & { title: string; id?: string };

export interface CreatePendingEvidenceInput extends TenantCaseKey {
	id?: string;
	objectKey: string;
	sha256: string;
	byteSize: number;
	contentType?: string;
	idempotencyKey?: string | null;
}

export interface MarkEvidenceStoredInput extends TenantContext {
	evidenceId: string;
	caseId?: string;
	storedAt?: Date;
}

export interface MarkEvidenceVerifiedInput extends TenantContext {
	evidenceId: string;
	caseId?: string;
	verifiedAt?: Date;
	sha256?: string;
	byteSize?: number;
}

export interface MarkEvidenceFailedInput extends TenantContext {
	evidenceId: string;
	caseId?: string;
	failureReason: string;
	failedAt?: Date;
}

export interface GetEvidenceInput extends TenantContext {
	evidenceId: string;
	caseId?: string;
}

export interface ListEvidenceInput extends TenantCaseKey {
	status?: EvidenceStatus;
	limit?: number;
	offset?: number;
}

export interface CreateAnalysisRunInput extends TenantCaseKey {
	id?: string;
	evidenceId?: string | null;
	status?: AnalysisRunStatus;
	idempotencyKey?: string | null;
	analysisVersion?: string | null;
	rulesetVersion?: string | null;
}

export interface GetAnalysisRunInput extends TenantContext {
	analysisRunId: string;
	caseId?: string;
}

export interface ListAnalysisRunsInput extends TenantContext {
	caseId?: string;
	evidenceId?: string;
	status?: AnalysisRunStatus;
	verdict?: AnalysisVerdict;
	limit?: number;
	offset?: number;
}

export interface GetAnalysisStatusInput extends TenantContext {
	analysisRunId: string;
}

export interface AnalysisStatusView {
	id: string;
	organizationId: string;
	caseId: string;
	status: AnalysisRunStatus;
	phase: string | null;
	progress: number | null;
	failureCode: string | null;
	failureMessage: string | null;
	retryable: boolean;
	attempts: number;
	queuedAt: Date | null;
	startedAt: Date | null;
	completedAt: Date | null;
	failedAt: Date | null;
	updatedAt: Date;
}

export interface GetAnalysisResultInput extends TenantContext {
	analysisRunId: string;
}

export interface AnalysisResultView {
	id: string;
	organizationId: string;
	caseId: string;
	status: AnalysisRunStatus;
	verdict: AnalysisVerdict | null;
	score: number | null;
	confidence: number | null;
	analysisVersion: string | null;
	rulesetVersion: string | null;
	resultSchemaVersion: string | null;
	resultSnapshot: unknown | null;
	completedAt: Date | null;
}

export interface TransitionAnalysisStatusInput extends TenantContext {
	analysisRunId: string;
	fromStatus: AnalysisRunStatus | readonly AnalysisRunStatus[];
	toStatus: AnalysisRunStatus;
	phase?: string | null;
	progress?: number | null;
	failureCode?: string | null;
	failureMessage?: string | null;
	retryable?: boolean;
	startedAt?: Date;
	completedAt?: Date;
	failedAt?: Date;
}

export interface SaveAnalysisResultInput extends TenantContext {
	analysisRunId: string;
	verdict: AnalysisVerdict;
	score: number;
	confidence: number;
	analysisVersion: string;
	rulesetVersion: string;
	resultSchemaVersion: string;
	resultSnapshot: unknown;
	completedAt?: Date;
}

export interface RetryAnalysisRunInput extends TenantContext {
	analysisRunId: string;
	maxAttempts?: number;
}

export interface CreateReportInput extends TenantCaseKey {
	id?: string;
	analysisRunId: string;
	format: ReportFormat;
	version?: number;
	status?: ReportStatus;
	objectKey?: string | null;
	metadata?: Record<string, unknown>;
}

export interface GetReportInput extends TenantContext {
	reportId: string;
	caseId?: string;
}

export interface ListReportsInput extends TenantContext {
	caseId?: string;
	analysisRunId?: string;
	format?: ReportFormat;
	status?: ReportStatus;
	limit?: number;
	offset?: number;
}

export interface UpdateReportStatusInput extends TenantContext {
	reportId: string;
	status: ReportStatus;
	objectKey?: string | null;
	failureReason?: string | null;
	metadata?: Record<string, unknown>;
	generatedAt?: Date;
}

export interface AppendAuditRecordInput extends TenantContext {
	id?: string;
	action: string;
	resourceType: string;
	resourceId?: string | null;
	actorUserId?: string | null;
	metadata?: Record<string, string>;
	createdAt?: Date;
}

export interface ListAuditRecordsInput extends TenantContext {
	resourceType?: string;
	resourceId?: string;
	limit?: number;
	offset?: number;
}

export interface OrganizationRepository {
	getOrganization(input: TenantContext): Promise<OrganizationShell | null>;
}

export interface MembershipRepository {
	listMemberships(input: TenantContext): Promise<MembershipShell[]>;
}

export interface CaseRepository {
	listCases(input: TenantContext): Promise<CaseShell[]>;
	getCase(input: TenantCaseKey): Promise<CaseShell | null>;
	createCase(input: CreateCaseInput): Promise<CaseShell>;
}

export interface EvidenceRepository {
	createPending(input: CreatePendingEvidenceInput): Promise<EvidenceShell>;
	markStored(input: MarkEvidenceStoredInput): Promise<EvidenceShell>;
	markVerified(input: MarkEvidenceVerifiedInput): Promise<EvidenceShell>;
	markFailed(input: MarkEvidenceFailedInput): Promise<EvidenceShell>;
	getEvidence(input: GetEvidenceInput): Promise<EvidenceShell | null>;
	listEvidence(input: ListEvidenceInput): Promise<EvidenceShell[]>;
}

export interface AnalysisRunRepository {
	createAnalysisRun(input: CreateAnalysisRunInput): Promise<AnalysisRunShell>;
	getAnalysisRun(input: GetAnalysisRunInput): Promise<AnalysisRunShell | null>;
	listAnalysisRuns(input: ListAnalysisRunsInput): Promise<AnalysisRunShell[]>;
	getAnalysisStatus(input: GetAnalysisStatusInput): Promise<AnalysisStatusView | null>;
	getAnalysisResult(input: GetAnalysisResultInput): Promise<AnalysisResultView | null>;
	transitionStatus(input: TransitionAnalysisStatusInput): Promise<AnalysisRunShell>;
	saveResult(input: SaveAnalysisResultInput): Promise<AnalysisRunShell>;
	retryAnalysisRun(input: RetryAnalysisRunInput): Promise<AnalysisRunShell>;
}

export interface ReportRepository {
	createReport(input: CreateReportInput): Promise<ReportShell>;
	getReport(input: GetReportInput): Promise<ReportShell | null>;
	listReports(input: ListReportsInput): Promise<ReportShell[]>;
	updateReportStatus(input: UpdateReportStatusInput): Promise<ReportShell>;
}

export interface AuditRepository {
	appendAuditRecord(input: AppendAuditRecordInput): Promise<AuditRecordShell>;
	listAuditRecords(input: ListAuditRecordsInput): Promise<AuditRecordShell[]>;
}

export interface Repositories {
	cases: CaseRepository;
	evidence: EvidenceRepository;
	analysisRuns: AnalysisRunRepository;
	reports: ReportRepository;
	audit: AuditRepository;
}

// ---------------------------------------------------------------------------
// Production Drizzle Repositories
// ---------------------------------------------------------------------------

export class DrizzleOrganizationRepository implements OrganizationRepository {
	constructor(private readonly db: DrizzleClient) {}

	async getOrganization({ organizationId }: TenantContext): Promise<OrganizationShell | null> {
		assertOrganizationId(organizationId);
		try {
			const [org] = await this.db
				.select()
				.from(schema.organizations)
				.where(eq(schema.organizations.id, organizationId))
				.limit(1);
			return org ?? null;
		} catch (err) {
			mapDatabaseError(err, "getOrganization");
		}
	}
}

export class DrizzleMembershipRepository implements MembershipRepository {
	constructor(private readonly db: DrizzleClient) {}

	async listMemberships({ organizationId }: TenantContext): Promise<MembershipShell[]> {
		assertOrganizationId(organizationId);
		try {
			return await this.db
				.select()
				.from(schema.memberships)
				.where(eq(schema.memberships.organizationId, organizationId));
		} catch (err) {
			mapDatabaseError(err, "listMemberships");
		}
	}
}

export class DrizzleCaseRepository implements CaseRepository {
	constructor(private readonly db: DrizzleClient) {}

	async listCases({ organizationId }: TenantContext): Promise<CaseShell[]> {
		assertOrganizationId(organizationId);
		try {
			return await this.db
				.select()
				.from(schema.cases)
				.where(eq(schema.cases.organizationId, organizationId))
				.orderBy(desc(schema.cases.createdAt));
		} catch (err) {
			mapDatabaseError(err, "listCases");
		}
	}

	async getCase({ organizationId, caseId }: TenantCaseKey): Promise<CaseShell | null> {
		assertOrganizationId(organizationId);
		try {
			const [result] = await this.db
				.select()
				.from(schema.cases)
				.where(and(eq(schema.cases.organizationId, organizationId), eq(schema.cases.id, caseId)))
				.limit(1);
			return result ?? null;
		} catch (err) {
			mapDatabaseError(err, "getCase");
		}
	}

	async createCase({ organizationId, title, id }: CreateCaseInput): Promise<CaseShell> {
		assertOrganizationId(organizationId);
		try {
			const [created] = await this.db
				.insert(schema.cases)
				.values({ id: id ?? `case_${randomUUID()}`, organizationId, title })
				.returning();
			if (!created) throw new RepositoryError("Case creation returned no record");
			return created;
		} catch (err) {
			mapDatabaseError(err, "createCase");
		}
	}
}

export class DrizzleEvidenceRepository implements EvidenceRepository {
	constructor(private readonly db: DrizzleClient) {}

	async createPending(input: CreatePendingEvidenceInput): Promise<EvidenceShell> {
		assertOrganizationId(input.organizationId);
		try {
			const [created] = await this.db
				.insert(schema.evidenceMetadata)
				.values({
					id: input.id ?? `ev_${randomUUID()}`,
					organizationId: input.organizationId,
					caseId: input.caseId,
					objectKey: input.objectKey,
					sha256: input.sha256,
					byteSize: input.byteSize,
					contentType: input.contentType ?? "message/rfc822",
					status: "pending",
					idempotencyKey: input.idempotencyKey ?? null,
				})
				.returning();
			if (!created) throw new RepositoryError("Evidence creation returned no record");
			return created;
		} catch (err) {
			mapDatabaseError(err, "createPendingEvidence");
		}
	}

	async markStored(input: MarkEvidenceStoredInput): Promise<EvidenceShell> {
		assertOrganizationId(input.organizationId);
		try {
			const existing = await this.getEvidence({
				organizationId: input.organizationId,
				evidenceId: input.evidenceId,
				caseId: input.caseId,
			});
			if (!existing) {
				throw new NotFoundError("evidence", input.evidenceId, input.organizationId);
			}

			if (existing.status === "failed" || existing.status === "verified") {
				throw new InvalidStateError(
					`Cannot mark evidence '${input.evidenceId}' as stored; current status is '${existing.status}'`,
					existing.status,
					"stored",
				);
			}

			if (existing.status === "stored") {
				return existing;
			}

			const conditions = [
				eq(schema.evidenceMetadata.organizationId, input.organizationId),
				eq(schema.evidenceMetadata.id, input.evidenceId),
				eq(schema.evidenceMetadata.status, "pending"),
			];
			if (input.caseId) {
				conditions.push(eq(schema.evidenceMetadata.caseId, input.caseId));
			}

			const [updated] = await this.db
				.update(schema.evidenceMetadata)
				.set({
					status: "stored",
					storedAt: input.storedAt ?? new Date(),
					updatedAt: new Date(),
				})
				.where(and(...conditions))
				.returning();

			if (!updated) {
				const recheck = await this.getEvidence({
					organizationId: input.organizationId,
					evidenceId: input.evidenceId,
					caseId: input.caseId,
				});
				if (!recheck) {
					throw new NotFoundError("evidence", input.evidenceId, input.organizationId);
				}
				if (recheck.status === "stored") {
					return recheck;
				}
				if (recheck.status === "failed" || recheck.status === "verified") {
					throw new InvalidStateError(
						`Cannot mark evidence '${input.evidenceId}' as stored; current status is '${recheck.status}'`,
						recheck.status,
						"stored",
					);
				}
				throw new InvalidStateError(
					`Failed to mark evidence '${input.evidenceId}' as stored; state changed concurrently`,
				);
			}
			return updated;
		} catch (err) {
			mapDatabaseError(err, "markEvidenceStored");
		}
	}

	async markVerified(input: MarkEvidenceVerifiedInput): Promise<EvidenceShell> {
		assertOrganizationId(input.organizationId);
		try {
			const existing = await this.getEvidence({
				organizationId: input.organizationId,
				evidenceId: input.evidenceId,
				caseId: input.caseId,
			});
			if (!existing) {
				throw new NotFoundError("evidence", input.evidenceId, input.organizationId);
			}

			if (existing.status === "failed") {
				throw new InvalidStateError(
					`Cannot mark evidence '${input.evidenceId}' as verified; current status is 'failed'`,
					existing.status,
					"verified",
				);
			}

			if (existing.status === "verified") {
				const matchesSha = input.sha256 === undefined || input.sha256 === existing.sha256;
				const matchesSize = input.byteSize === undefined || input.byteSize === existing.byteSize;
				if (matchesSha && matchesSize) {
					return existing;
				}
				throw new ConflictError(
					`Evidence '${input.evidenceId}' is already verified with differing digest or size metadata`,
				);
			}

			if (
				(input.sha256 !== undefined && input.sha256 !== existing.sha256) ||
				(input.byteSize !== undefined && input.byteSize !== existing.byteSize)
			) {
				throw new ConflictError(
					`Cannot verify evidence '${input.evidenceId}': supplied digest or size conflicts with registered metadata`,
				);
			}

			const conditions = [
				eq(schema.evidenceMetadata.organizationId, input.organizationId),
				eq(schema.evidenceMetadata.id, input.evidenceId),
				inArray(schema.evidenceMetadata.status, ["pending", "stored"]),
			];
			if (input.caseId) {
				conditions.push(eq(schema.evidenceMetadata.caseId, input.caseId));
			}

			const [updated] = await this.db
				.update(schema.evidenceMetadata)
				.set({
					status: "verified",
					verifiedAt: input.verifiedAt ?? new Date(),
					sha256: input.sha256 ?? existing.sha256,
					byteSize: input.byteSize ?? existing.byteSize,
					updatedAt: new Date(),
				})
				.where(and(...conditions))
				.returning();

			if (!updated) {
				const recheck = await this.getEvidence({
					organizationId: input.organizationId,
					evidenceId: input.evidenceId,
					caseId: input.caseId,
				});
				if (!recheck) {
					throw new NotFoundError("evidence", input.evidenceId, input.organizationId);
				}
				if (recheck.status === "verified") {
					const matchesSha = input.sha256 === undefined || input.sha256 === recheck.sha256;
					const matchesSize = input.byteSize === undefined || input.byteSize === recheck.byteSize;
					if (matchesSha && matchesSize) {
						return recheck;
					}
					throw new ConflictError(
						`Evidence '${input.evidenceId}' is already verified with differing digest or size metadata`,
					);
				}
				if (recheck.status === "failed") {
					throw new InvalidStateError(
						`Cannot mark evidence '${input.evidenceId}' as verified; current status is 'failed'`,
						recheck.status,
						"verified",
					);
				}
				throw new InvalidStateError(
					`Failed to mark evidence '${input.evidenceId}' as verified; state changed concurrently`,
				);
			}
			return updated;
		} catch (err) {
			mapDatabaseError(err, "markEvidenceVerified");
		}
	}

	async markFailed(input: MarkEvidenceFailedInput): Promise<EvidenceShell> {
		assertOrganizationId(input.organizationId);
		try {
			const existing = await this.getEvidence({
				organizationId: input.organizationId,
				evidenceId: input.evidenceId,
				caseId: input.caseId,
			});
			if (!existing) {
				throw new NotFoundError("evidence", input.evidenceId, input.organizationId);
			}

			if (existing.status === "verified") {
				throw new InvalidStateError(
					`Cannot mark evidence '${input.evidenceId}' as failed; evidence is already verified`,
					existing.status,
					"failed",
				);
			}

			if (existing.status === "failed") {
				return existing;
			}

			const conditions = [
				eq(schema.evidenceMetadata.organizationId, input.organizationId),
				eq(schema.evidenceMetadata.id, input.evidenceId),
				inArray(schema.evidenceMetadata.status, ["pending", "stored"]),
			];
			if (input.caseId) {
				conditions.push(eq(schema.evidenceMetadata.caseId, input.caseId));
			}

			const [updated] = await this.db
				.update(schema.evidenceMetadata)
				.set({
					status: "failed",
					failureReason: input.failureReason,
					failedAt: input.failedAt ?? new Date(),
					updatedAt: new Date(),
				})
				.where(and(...conditions))
				.returning();

			if (!updated) {
				const recheck = await this.getEvidence({
					organizationId: input.organizationId,
					evidenceId: input.evidenceId,
					caseId: input.caseId,
				});
				if (!recheck) {
					throw new NotFoundError("evidence", input.evidenceId, input.organizationId);
				}
				if (recheck.status === "verified") {
					throw new InvalidStateError(
						`Cannot mark evidence '${input.evidenceId}' as failed; evidence is already verified`,
						recheck.status,
						"failed",
					);
				}
				if (recheck.status === "failed") {
					return recheck;
				}
				throw new InvalidStateError(
					`Failed to mark evidence '${input.evidenceId}' as failed; state changed concurrently`,
				);
			}
			return updated;
		} catch (err) {
			mapDatabaseError(err, "markEvidenceFailed");
		}
	}

	async getEvidence({ organizationId, evidenceId, caseId }: GetEvidenceInput): Promise<EvidenceShell | null> {
		assertOrganizationId(organizationId);
		try {
			const conditions = [
				eq(schema.evidenceMetadata.organizationId, organizationId),
				eq(schema.evidenceMetadata.id, evidenceId),
			];
			if (caseId) {
				conditions.push(eq(schema.evidenceMetadata.caseId, caseId));
			}
			const [result] = await this.db
				.select()
				.from(schema.evidenceMetadata)
				.where(and(...conditions))
				.limit(1);
			return result ?? null;
		} catch (err) {
			mapDatabaseError(err, "getEvidence");
		}
	}

	async listEvidence(input: ListEvidenceInput): Promise<EvidenceShell[]> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [
				eq(schema.evidenceMetadata.organizationId, input.organizationId),
				eq(schema.evidenceMetadata.caseId, input.caseId),
			];
			if (input.status) {
				conditions.push(eq(schema.evidenceMetadata.status, input.status));
			}
			let query = this.db
				.select()
				.from(schema.evidenceMetadata)
				.where(and(...conditions))
				.orderBy(desc(schema.evidenceMetadata.createdAt));

			if (input.limit !== undefined) {
				query = query.limit(input.limit) as typeof query;
			}
			if (input.offset !== undefined) {
				query = query.offset(input.offset) as typeof query;
			}

			return await query;
		} catch (err) {
			mapDatabaseError(err, "listEvidence");
		}
	}
}

export class DrizzleAnalysisRunRepository implements AnalysisRunRepository {
	constructor(private readonly db: DrizzleClient) {}

	async createAnalysisRun(input: CreateAnalysisRunInput): Promise<AnalysisRunShell> {
		assertOrganizationId(input.organizationId);
		try {
			const status = input.status ?? "accepted";
			const queuedAt = status === "queued" ? new Date() : null;

			const [created] = await this.db
				.insert(schema.analysisRuns)
				.values({
					id: input.id ?? `run_${randomUUID()}`,
					organizationId: input.organizationId,
					caseId: input.caseId,
					evidenceId: input.evidenceId ?? null,
					status,
					queuedAt,
					idempotencyKey: input.idempotencyKey ?? null,
					analysisVersion: input.analysisVersion ?? null,
					rulesetVersion: input.rulesetVersion ?? null,
					attempts: 0,
					retryable: false,
				})
				.returning();

			if (!created) throw new RepositoryError("Analysis run creation returned no record");
			return created;
		} catch (err) {
			mapDatabaseError(err, "createAnalysisRun");
		}
	}

	async getAnalysisRun(input: GetAnalysisRunInput): Promise<AnalysisRunShell | null> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [
				eq(schema.analysisRuns.organizationId, input.organizationId),
				eq(schema.analysisRuns.id, input.analysisRunId),
			];
			if (input.caseId) {
				conditions.push(eq(schema.analysisRuns.caseId, input.caseId));
			}

			const [result] = await this.db
				.select()
				.from(schema.analysisRuns)
				.where(and(...conditions))
				.limit(1);

			return result ?? null;
		} catch (err) {
			mapDatabaseError(err, "getAnalysisRun");
		}
	}

	async listAnalysisRuns(input: ListAnalysisRunsInput): Promise<AnalysisRunShell[]> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [eq(schema.analysisRuns.organizationId, input.organizationId)];
			if (input.caseId) conditions.push(eq(schema.analysisRuns.caseId, input.caseId));
			if (input.evidenceId) conditions.push(eq(schema.analysisRuns.evidenceId, input.evidenceId));
			if (input.status) conditions.push(eq(schema.analysisRuns.status, input.status));
			if (input.verdict) conditions.push(eq(schema.analysisRuns.verdict, input.verdict));

			let query = this.db
				.select()
				.from(schema.analysisRuns)
				.where(and(...conditions))
				.orderBy(desc(schema.analysisRuns.createdAt));

			if (input.limit !== undefined) query = query.limit(input.limit) as typeof query;
			if (input.offset !== undefined) query = query.offset(input.offset) as typeof query;

			return await query;
		} catch (err) {
			mapDatabaseError(err, "listAnalysisRuns");
		}
	}

	async getAnalysisStatus(input: GetAnalysisStatusInput): Promise<AnalysisStatusView | null> {
		assertOrganizationId(input.organizationId);
		const run = await this.getAnalysisRun({
			organizationId: input.organizationId,
			analysisRunId: input.analysisRunId,
		});
		if (!run) return null;

		return {
			id: run.id,
			organizationId: run.organizationId,
			caseId: run.caseId,
			status: run.status,
			phase: run.phase,
			progress: run.progress,
			failureCode: run.failureCode,
			failureMessage: run.failureMessage,
			retryable: run.retryable,
			attempts: run.attempts,
			queuedAt: run.queuedAt,
			startedAt: run.startedAt,
			completedAt: run.completedAt,
			failedAt: run.failedAt,
			updatedAt: run.updatedAt,
		};
	}

	async getAnalysisResult(input: GetAnalysisResultInput): Promise<AnalysisResultView | null> {
		assertOrganizationId(input.organizationId);
		const run = await this.getAnalysisRun({
			organizationId: input.organizationId,
			analysisRunId: input.analysisRunId,
		});
		if (!run) return null;

		return {
			id: run.id,
			organizationId: run.organizationId,
			caseId: run.caseId,
			status: run.status,
			verdict: run.verdict,
			score: run.score,
			confidence: run.confidence,
			analysisVersion: run.analysisVersion,
			rulesetVersion: run.rulesetVersion,
			resultSchemaVersion: run.resultSchemaVersion,
			resultSnapshot: run.resultSnapshot,
			completedAt: run.completedAt,
		};
	}

	async transitionStatus(input: TransitionAnalysisStatusInput): Promise<AnalysisRunShell> {
		assertOrganizationId(input.organizationId);
		try {
			const fromStatuses = Array.isArray(input.fromStatus) ? [...input.fromStatus] : [input.fromStatus];

			const setPayload: Partial<typeof schema.analysisRuns.$inferInsert> = {
				status: input.toStatus,
				updatedAt: new Date(),
			};
			if (input.phase !== undefined) setPayload.phase = input.phase;
			if (input.progress !== undefined) setPayload.progress = input.progress;
			if (input.failureCode !== undefined) setPayload.failureCode = input.failureCode;
			if (input.failureMessage !== undefined) setPayload.failureMessage = input.failureMessage;
			if (input.retryable !== undefined) setPayload.retryable = input.retryable;
			if (input.startedAt !== undefined) setPayload.startedAt = input.startedAt;
			if (input.completedAt !== undefined) setPayload.completedAt = input.completedAt;
			if (input.failedAt !== undefined) setPayload.failedAt = input.failedAt;

			const [updated] = await this.db
				.update(schema.analysisRuns)
				.set(setPayload)
				.where(
					and(
						eq(schema.analysisRuns.organizationId, input.organizationId),
						eq(schema.analysisRuns.id, input.analysisRunId),
						inArray(schema.analysisRuns.status, fromStatuses),
					),
				)
				.returning();

			if (updated) return updated;

			const existing = await this.getAnalysisRun({
				organizationId: input.organizationId,
				analysisRunId: input.analysisRunId,
			});
			if (!existing) {
				throw new NotFoundError("analysis_run", input.analysisRunId, input.organizationId);
			}

			throw new InvalidStateError(
				`Cannot transition analysis run '${input.analysisRunId}' from status '${existing.status}' to '${input.toStatus}'; allowed source status is [${fromStatuses.join(", ")}]`,
				existing.status,
				input.toStatus,
			);
		} catch (err) {
			mapDatabaseError(err, "transitionStatus");
		}
	}

	async saveResult(input: SaveAnalysisResultInput): Promise<AnalysisRunShell> {
		assertOrganizationId(input.organizationId);
		try {
			const existing = await this.getAnalysisRun({
				organizationId: input.organizationId,
				analysisRunId: input.analysisRunId,
			});
			if (!existing) {
				throw new NotFoundError("analysis_run", input.analysisRunId, input.organizationId);
			}

			if (existing.status === "completed") {
				if (areAnalysisResultsIdentical(existing, input)) {
					return existing;
				}
				throw new ConflictError(
					`Analysis result for run '${input.analysisRunId}' is immutable and has already been saved with differing content`,
				);
			}

			if (existing.status !== "processing") {
				throw new InvalidStateError(
					`Cannot save result for analysis run '${input.analysisRunId}' in status '${existing.status}'; run must be in 'processing' status`,
					existing.status,
					"completed",
				);
			}

			const [updated] = await this.db
				.update(schema.analysisRuns)
				.set({
					status: "completed",
					verdict: input.verdict,
					score: input.score,
					confidence: input.confidence,
					analysisVersion: input.analysisVersion,
					rulesetVersion: input.rulesetVersion,
					resultSchemaVersion: input.resultSchemaVersion,
					resultSnapshot: input.resultSnapshot,
					phase: "completed",
					progress: 100,
					completedAt: input.completedAt ?? new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(schema.analysisRuns.organizationId, input.organizationId),
						eq(schema.analysisRuns.id, input.analysisRunId),
						eq(schema.analysisRuns.status, "processing"),
					),
				)
				.returning();

			if (!updated) {
				const recheck = await this.getAnalysisRun({
					organizationId: input.organizationId,
					analysisRunId: input.analysisRunId,
				});
				if (!recheck) {
					throw new NotFoundError("analysis_run", input.analysisRunId, input.organizationId);
				}
				if (recheck.status === "completed") {
					if (areAnalysisResultsIdentical(recheck, input)) {
						return recheck;
					}
					throw new ConflictError(
						`Analysis result for run '${input.analysisRunId}' is immutable and has already been saved with differing content`,
					);
				}
				throw new InvalidStateError(
					`Failed to save result for analysis run '${input.analysisRunId}'; run status changed concurrently`,
				);
			}

			return updated;
		} catch (err) {
			mapDatabaseError(err, "saveResult");
		}
	}

	async retryAnalysisRun(input: RetryAnalysisRunInput): Promise<AnalysisRunShell> {
		assertOrganizationId(input.organizationId);
		try {
			const existing = await this.getAnalysisRun({
				organizationId: input.organizationId,
				analysisRunId: input.analysisRunId,
			});
			if (!existing) {
				throw new NotFoundError("analysis_run", input.analysisRunId, input.organizationId);
			}

			if (existing.status !== "failed" && existing.status !== "deferred") {
				throw new InvalidStateError(
					`Cannot retry analysis run '${input.analysisRunId}' with status '${existing.status}'; only 'failed' or 'deferred' runs can be retried`,
					existing.status,
					"queued",
				);
			}

			if (!existing.retryable) {
				throw new InvalidStateError(`Analysis run '${input.analysisRunId}' is not marked as retryable`);
			}

			const maxAttempts = input.maxAttempts ?? 3;
			if (existing.attempts >= maxAttempts) {
				throw new InvalidStateError(
					`Maximum retry attempts (${maxAttempts}) exceeded for analysis run '${input.analysisRunId}' (current: ${existing.attempts})`,
				);
			}

			const [updated] = await this.db
				.update(schema.analysisRuns)
				.set({
					status: "queued",
					attempts: existing.attempts + 1,
					failureCode: null,
					failureMessage: null,
					failedAt: null,
					queuedAt: new Date(),
					phase: "queued",
					progress: 0,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(schema.analysisRuns.organizationId, input.organizationId),
						eq(schema.analysisRuns.id, input.analysisRunId),
						inArray(schema.analysisRuns.status, ["failed", "deferred"]),
					),
				)
				.returning();

			if (!updated) {
				throw new InvalidStateError(
					`Failed to retry analysis run '${input.analysisRunId}'; state changed concurrently`,
				);
			}

			return updated;
		} catch (err) {
			mapDatabaseError(err, "retryAnalysisRun");
		}
	}
}

export class DrizzleReportRepository implements ReportRepository {
	constructor(private readonly db: DrizzleClient) {}

	async createReport(input: CreateReportInput): Promise<ReportShell> {
		assertOrganizationId(input.organizationId);
		try {
			let version = input.version;
			if (version === undefined) {
				const existing = await this.db
					.select({ version: schema.reports.version })
					.from(schema.reports)
					.where(
						and(
							eq(schema.reports.organizationId, input.organizationId),
							eq(schema.reports.analysisRunId, input.analysisRunId),
							eq(schema.reports.format, input.format),
						),
					)
					.orderBy(desc(schema.reports.version))
					.limit(1);

				version = (existing[0]?.version ?? 0) + 1;
			}

			const [created] = await this.db
				.insert(schema.reports)
				.values({
					id: input.id ?? `report_${randomUUID()}`,
					organizationId: input.organizationId,
					caseId: input.caseId,
					analysisRunId: input.analysisRunId,
					version,
					status: input.status ?? "pending",
					format: input.format,
					objectKey: input.objectKey ?? null,
					metadata: input.metadata ?? {},
				})
				.returning();

			if (!created) throw new RepositoryError("Report creation returned no record");
			return created;
		} catch (err) {
			mapDatabaseError(err, "createReport");
		}
	}

	async getReport(input: GetReportInput): Promise<ReportShell | null> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [
				eq(schema.reports.organizationId, input.organizationId),
				eq(schema.reports.id, input.reportId),
			];
			if (input.caseId) {
				conditions.push(eq(schema.reports.caseId, input.caseId));
			}

			const [result] = await this.db
				.select()
				.from(schema.reports)
				.where(and(...conditions))
				.limit(1);

			return result ?? null;
		} catch (err) {
			mapDatabaseError(err, "getReport");
		}
	}

	async listReports(input: ListReportsInput): Promise<ReportShell[]> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [eq(schema.reports.organizationId, input.organizationId)];
			if (input.caseId) conditions.push(eq(schema.reports.caseId, input.caseId));
			if (input.analysisRunId) conditions.push(eq(schema.reports.analysisRunId, input.analysisRunId));
			if (input.format) conditions.push(eq(schema.reports.format, input.format));
			if (input.status) conditions.push(eq(schema.reports.status, input.status));

			let query = this.db
				.select()
				.from(schema.reports)
				.where(and(...conditions))
				.orderBy(desc(schema.reports.createdAt));

			if (input.limit !== undefined) query = query.limit(input.limit) as typeof query;
			if (input.offset !== undefined) query = query.offset(input.offset) as typeof query;

			return await query;
		} catch (err) {
			mapDatabaseError(err, "listReports");
		}
	}

	async updateReportStatus(input: UpdateReportStatusInput): Promise<ReportShell> {
		assertOrganizationId(input.organizationId);
		try {
			const existing = await this.getReport({
				organizationId: input.organizationId,
				reportId: input.reportId,
			});
			if (!existing) {
				throw new NotFoundError("report", input.reportId, input.organizationId);
			}

			if (existing.status === "completed" && (input.status === "pending" || input.status === "generating")) {
				throw new InvalidStateError(
					`Cannot update completed report '${input.reportId}' back to '${input.status}'`,
					existing.status,
					input.status,
				);
			}

			const setPayload: Partial<typeof schema.reports.$inferInsert> = {
				status: input.status,
				updatedAt: new Date(),
			};
			if (input.objectKey !== undefined) setPayload.objectKey = input.objectKey;
			if (input.failureReason !== undefined) setPayload.failureReason = input.failureReason;
			if (input.metadata !== undefined) setPayload.metadata = { ...existing.metadata, ...input.metadata };
			if (input.generatedAt !== undefined) {
				setPayload.generatedAt = input.generatedAt;
			} else if (input.status === "completed" && !existing.generatedAt) {
				setPayload.generatedAt = new Date();
			}

			const [updated] = await this.db
				.update(schema.reports)
				.set(setPayload)
				.where(and(eq(schema.reports.organizationId, input.organizationId), eq(schema.reports.id, input.reportId)))
				.returning();

			if (!updated) {
				throw new InvalidStateError(`Failed to update report '${input.reportId}' status`);
			}

			return updated;
		} catch (err) {
			mapDatabaseError(err, "updateReportStatus");
		}
	}
}

export class DrizzleAuditRepository implements AuditRepository {
	constructor(private readonly db: DrizzleClient) {}

	async appendAuditRecord(input: AppendAuditRecordInput): Promise<AuditRecordShell> {
		assertOrganizationId(input.organizationId);
		try {
			const [created] = await this.db
				.insert(schema.auditRecords)
				.values({
					id: input.id ?? `audit_${randomUUID()}`,
					organizationId: input.organizationId,
					action: input.action,
					resourceType: input.resourceType,
					resourceId: input.resourceId ?? null,
					actorUserId: input.actorUserId ?? null,
					metadata: input.metadata ?? {},
					createdAt: input.createdAt ?? new Date(),
				})
				.returning();

			if (!created) throw new RepositoryError("Audit record creation returned no record");
			return created;
		} catch (err) {
			mapDatabaseError(err, "appendAuditRecord");
		}
	}

	async listAuditRecords(input: ListAuditRecordsInput): Promise<AuditRecordShell[]> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [eq(schema.auditRecords.organizationId, input.organizationId)];
			if (input.resourceType) conditions.push(eq(schema.auditRecords.resourceType, input.resourceType));
			if (input.resourceId) conditions.push(eq(schema.auditRecords.resourceId, input.resourceId));

			let query = this.db
				.select()
				.from(schema.auditRecords)
				.where(and(...conditions))
				.orderBy(desc(schema.auditRecords.createdAt));

			if (input.limit !== undefined) query = query.limit(input.limit) as typeof query;
			if (input.offset !== undefined) query = query.offset(input.offset) as typeof query;

			return await query;
		} catch (err) {
			mapDatabaseError(err, "listAuditRecords");
		}
	}
}

// ---------------------------------------------------------------------------
// Deterministic Memory Repositories
// ---------------------------------------------------------------------------

export class MemoryOrganizationRepository implements OrganizationRepository {
	constructor(private readonly records: OrganizationShell[]) {}

	async getOrganization({ organizationId }: TenantContext): Promise<OrganizationShell | null> {
		assertOrganizationId(organizationId);
		return this.records.find((r) => r.id === organizationId) ?? null;
	}
}

export class MemoryMembershipRepository implements MembershipRepository {
	constructor(private readonly records: MembershipShell[]) {}

	async listMemberships({ organizationId }: TenantContext): Promise<MembershipShell[]> {
		assertOrganizationId(organizationId);
		return this.records.filter((r) => r.organizationId === organizationId);
	}
}

export class MemoryCaseRepository implements CaseRepository {
	constructor(private readonly records: CaseShell[]) {}

	async listCases({ organizationId }: TenantContext): Promise<CaseShell[]> {
		assertOrganizationId(organizationId);
		return this.records
			.filter((record) => record.organizationId === organizationId)
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
	}

	async getCase({ organizationId, caseId }: TenantCaseKey): Promise<CaseShell | null> {
		assertOrganizationId(organizationId);
		return this.records.find((record) => record.organizationId === organizationId && record.id === caseId) ?? null;
	}

	async createCase({ organizationId, title, id }: CreateCaseInput): Promise<CaseShell> {
		assertOrganizationId(organizationId);
		const now = new Date();
		const record: CaseShell = {
			id: id ?? `case_${randomUUID()}`,
			organizationId,
			title,
			createdAt: now,
			updatedAt: now,
		};
		this.records.push(record);
		return record;
	}
}

export class MemoryEvidenceRepository implements EvidenceRepository {
	constructor(
		private readonly records: EvidenceShell[],
		private readonly cases?: CaseShell[],
	) {}

	async createPending(input: CreatePendingEvidenceInput): Promise<EvidenceShell> {
		assertOrganizationId(input.organizationId);

		if (this.cases) {
			const caseExists = this.cases.some((c) => c.organizationId === input.organizationId && c.id === input.caseId);
			if (!caseExists) {
				throw new DependencyError(
					`Case '${input.caseId}' does not exist for organization '${input.organizationId}'`,
					"cases",
				);
			}
		}

		if (this.records.some((e) => e.objectKey === input.objectKey)) {
			throw new ConflictError(`Evidence with objectKey '${input.objectKey}' already exists`);
		}

		if (input.idempotencyKey) {
			const duplicateIdem = this.records.some(
				(e) => e.organizationId === input.organizationId && e.idempotencyKey === input.idempotencyKey,
			);
			if (duplicateIdem) {
				throw new ConflictError(
					`Evidence with idempotencyKey '${input.idempotencyKey}' already exists in organization '${input.organizationId}'`,
				);
			}
		}

		const now = new Date();
		const record: EvidenceShell = {
			id: input.id ?? `ev_${randomUUID()}`,
			organizationId: input.organizationId,
			caseId: input.caseId,
			objectKey: input.objectKey,
			sha256: input.sha256,
			byteSize: input.byteSize,
			contentType: input.contentType ?? "message/rfc822",
			status: "pending",
			idempotencyKey: input.idempotencyKey ?? null,
			storedAt: null,
			verifiedAt: null,
			failedAt: null,
			failureReason: null,
			createdAt: now,
			updatedAt: now,
		};
		this.records.push(record);
		return { ...record };
	}

	async markStored(input: MarkEvidenceStoredInput): Promise<EvidenceShell> {
		assertOrganizationId(input.organizationId);
		const existing = this.records.find(
			(e) =>
				e.organizationId === input.organizationId &&
				e.id === input.evidenceId &&
				(input.caseId ? e.caseId === input.caseId : true),
		);
		if (!existing) {
			throw new NotFoundError("evidence", input.evidenceId, input.organizationId);
		}

		if (existing.status === "failed" || existing.status === "verified") {
			throw new InvalidStateError(
				`Cannot mark evidence '${input.evidenceId}' as stored; current status is '${existing.status}'`,
				existing.status,
				"stored",
			);
		}

		if (existing.status === "stored") {
			return { ...existing };
		}

		existing.status = "stored";
		existing.storedAt = input.storedAt ?? new Date();
		existing.updatedAt = new Date();
		return { ...existing };
	}

	async markVerified(input: MarkEvidenceVerifiedInput): Promise<EvidenceShell> {
		assertOrganizationId(input.organizationId);
		const existing = this.records.find(
			(e) =>
				e.organizationId === input.organizationId &&
				e.id === input.evidenceId &&
				(input.caseId ? e.caseId === input.caseId : true),
		);
		if (!existing) {
			throw new NotFoundError("evidence", input.evidenceId, input.organizationId);
		}

		if (existing.status === "failed") {
			throw new InvalidStateError(
				`Cannot mark evidence '${input.evidenceId}' as verified; current status is 'failed'`,
				existing.status,
				"verified",
			);
		}

		if (existing.status === "verified") {
			const matchesSha = input.sha256 === undefined || input.sha256 === existing.sha256;
			const matchesSize = input.byteSize === undefined || input.byteSize === existing.byteSize;
			if (matchesSha && matchesSize) {
				return { ...existing };
			}
			throw new ConflictError(
				`Evidence '${input.evidenceId}' is already verified with differing digest or size metadata`,
			);
		}

		if (
			(input.sha256 !== undefined && input.sha256 !== existing.sha256) ||
			(input.byteSize !== undefined && input.byteSize !== existing.byteSize)
		) {
			throw new ConflictError(
				`Cannot verify evidence '${input.evidenceId}': supplied digest or size conflicts with registered metadata`,
			);
		}

		existing.status = "verified";
		existing.verifiedAt = input.verifiedAt ?? new Date();
		if (input.sha256 !== undefined) existing.sha256 = input.sha256;
		if (input.byteSize !== undefined) existing.byteSize = input.byteSize;
		existing.updatedAt = new Date();
		return { ...existing };
	}

	async markFailed(input: MarkEvidenceFailedInput): Promise<EvidenceShell> {
		assertOrganizationId(input.organizationId);
		const existing = this.records.find(
			(e) =>
				e.organizationId === input.organizationId &&
				e.id === input.evidenceId &&
				(input.caseId ? e.caseId === input.caseId : true),
		);
		if (!existing) {
			throw new NotFoundError("evidence", input.evidenceId, input.organizationId);
		}

		if (existing.status === "verified") {
			throw new InvalidStateError(
				`Cannot mark evidence '${input.evidenceId}' as failed; evidence is already verified`,
				existing.status,
				"failed",
			);
		}

		if (existing.status === "failed") {
			return { ...existing };
		}

		existing.status = "failed";
		existing.failureReason = input.failureReason;
		existing.failedAt = input.failedAt ?? new Date();
		existing.updatedAt = new Date();
		return { ...existing };
	}

	async getEvidence(input: GetEvidenceInput): Promise<EvidenceShell | null> {
		assertOrganizationId(input.organizationId);
		const found = this.records.find(
			(e) =>
				e.organizationId === input.organizationId &&
				e.id === input.evidenceId &&
				(input.caseId ? e.caseId === input.caseId : true),
		);
		return found ? { ...found } : null;
	}

	async listEvidence(input: ListEvidenceInput): Promise<EvidenceShell[]> {
		assertOrganizationId(input.organizationId);
		let list = this.records
			.filter(
				(e) =>
					e.organizationId === input.organizationId &&
					e.caseId === input.caseId &&
					(!input.status || e.status === input.status),
			)
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

		if (input.offset !== undefined) list = list.slice(input.offset);
		if (input.limit !== undefined) list = list.slice(0, input.limit);
		return list.map((e) => ({ ...e }));
	}
}

export class MemoryAnalysisRunRepository implements AnalysisRunRepository {
	constructor(
		private readonly records: AnalysisRunShell[],
		private readonly cases?: CaseShell[],
		private readonly evidence?: EvidenceShell[],
	) {}

	async createAnalysisRun(input: CreateAnalysisRunInput): Promise<AnalysisRunShell> {
		assertOrganizationId(input.organizationId);

		if (this.cases) {
			const caseExists = this.cases.some((c) => c.organizationId === input.organizationId && c.id === input.caseId);
			if (!caseExists) {
				throw new DependencyError(
					`Case '${input.caseId}' does not exist for organization '${input.organizationId}'`,
					"cases",
				);
			}
		}

		if (input.evidenceId && this.evidence) {
			const evidenceExists = this.evidence.some(
				(e) => e.organizationId === input.organizationId && e.caseId === input.caseId && e.id === input.evidenceId,
			);
			if (!evidenceExists) {
				throw new DependencyError(
					`Evidence '${input.evidenceId}' does not exist for organization '${input.organizationId}' and case '${input.caseId}'`,
					"evidence",
				);
			}
		}

		if (input.idempotencyKey) {
			const duplicateIdem = this.records.some(
				(r) => r.organizationId === input.organizationId && r.idempotencyKey === input.idempotencyKey,
			);
			if (duplicateIdem) {
				throw new ConflictError(
					`Analysis run with idempotencyKey '${input.idempotencyKey}' already exists in organization '${input.organizationId}'`,
				);
			}
		}

		const now = new Date();
		const status = input.status ?? "accepted";
		const record: AnalysisRunShell = {
			id: input.id ?? `run_${randomUUID()}`,
			organizationId: input.organizationId,
			caseId: input.caseId,
			evidenceId: input.evidenceId ?? null,
			status,
			verdict: null,
			score: null,
			confidence: null,
			analysisVersion: input.analysisVersion ?? null,
			rulesetVersion: input.rulesetVersion ?? null,
			resultSchemaVersion: null,
			resultSnapshot: null,
			failureCode: null,
			failureMessage: null,
			retryable: false,
			attempts: 0,
			queuedAt: status === "queued" ? now : null,
			startedAt: null,
			completedAt: null,
			failedAt: null,
			idempotencyKey: input.idempotencyKey ?? null,
			phase: null,
			progress: null,
			createdAt: now,
			updatedAt: now,
		};
		this.records.push(record);
		return { ...record };
	}

	async getAnalysisRun(input: GetAnalysisRunInput): Promise<AnalysisRunShell | null> {
		assertOrganizationId(input.organizationId);
		const found = this.records.find(
			(r) =>
				r.organizationId === input.organizationId &&
				r.id === input.analysisRunId &&
				(input.caseId ? r.caseId === input.caseId : true),
		);
		return found ? { ...found } : null;
	}

	async listAnalysisRuns(input: ListAnalysisRunsInput): Promise<AnalysisRunShell[]> {
		assertOrganizationId(input.organizationId);
		let list = this.records
			.filter((r) => {
				if (r.organizationId !== input.organizationId) return false;
				if (input.caseId && r.caseId !== input.caseId) return false;
				if (input.evidenceId && r.evidenceId !== input.evidenceId) return false;
				if (input.status && r.status !== input.status) return false;
				if (input.verdict && r.verdict !== input.verdict) return false;
				return true;
			})
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

		if (input.offset !== undefined) list = list.slice(input.offset);
		if (input.limit !== undefined) list = list.slice(0, input.limit);
		return list.map((r) => ({ ...r }));
	}

	async getAnalysisStatus(input: GetAnalysisStatusInput): Promise<AnalysisStatusView | null> {
		assertOrganizationId(input.organizationId);
		const run = await this.getAnalysisRun({
			organizationId: input.organizationId,
			analysisRunId: input.analysisRunId,
		});
		if (!run) return null;

		return {
			id: run.id,
			organizationId: run.organizationId,
			caseId: run.caseId,
			status: run.status,
			phase: run.phase,
			progress: run.progress,
			failureCode: run.failureCode,
			failureMessage: run.failureMessage,
			retryable: run.retryable,
			attempts: run.attempts,
			queuedAt: run.queuedAt,
			startedAt: run.startedAt,
			completedAt: run.completedAt,
			failedAt: run.failedAt,
			updatedAt: run.updatedAt,
		};
	}

	async getAnalysisResult(input: GetAnalysisResultInput): Promise<AnalysisResultView | null> {
		assertOrganizationId(input.organizationId);
		const run = await this.getAnalysisRun({
			organizationId: input.organizationId,
			analysisRunId: input.analysisRunId,
		});
		if (!run) return null;

		return {
			id: run.id,
			organizationId: run.organizationId,
			caseId: run.caseId,
			status: run.status,
			verdict: run.verdict,
			score: run.score,
			confidence: run.confidence,
			analysisVersion: run.analysisVersion,
			rulesetVersion: run.rulesetVersion,
			resultSchemaVersion: run.resultSchemaVersion,
			resultSnapshot: run.resultSnapshot,
			completedAt: run.completedAt,
		};
	}

	async transitionStatus(input: TransitionAnalysisStatusInput): Promise<AnalysisRunShell> {
		assertOrganizationId(input.organizationId);
		const existing = this.records.find(
			(r) => r.organizationId === input.organizationId && r.id === input.analysisRunId,
		);
		if (!existing) {
			throw new NotFoundError("analysis_run", input.analysisRunId, input.organizationId);
		}

		const fromStatuses = Array.isArray(input.fromStatus) ? [...input.fromStatus] : [input.fromStatus];
		if (!fromStatuses.includes(existing.status)) {
			throw new InvalidStateError(
				`Cannot transition analysis run '${input.analysisRunId}' from status '${existing.status}' to '${input.toStatus}'; allowed source status is [${fromStatuses.join(", ")}]`,
				existing.status,
				input.toStatus,
			);
		}

		existing.status = input.toStatus;
		if (input.phase !== undefined) existing.phase = input.phase;
		if (input.progress !== undefined) existing.progress = input.progress;
		if (input.failureCode !== undefined) existing.failureCode = input.failureCode;
		if (input.failureMessage !== undefined) existing.failureMessage = input.failureMessage;
		if (input.retryable !== undefined) existing.retryable = input.retryable;
		if (input.startedAt !== undefined) existing.startedAt = input.startedAt;
		if (input.completedAt !== undefined) existing.completedAt = input.completedAt;
		if (input.failedAt !== undefined) existing.failedAt = input.failedAt;
		existing.updatedAt = new Date();

		return { ...existing };
	}

	async saveResult(input: SaveAnalysisResultInput): Promise<AnalysisRunShell> {
		assertOrganizationId(input.organizationId);
		const existing = this.records.find(
			(r) => r.organizationId === input.organizationId && r.id === input.analysisRunId,
		);
		if (!existing) {
			throw new NotFoundError("analysis_run", input.analysisRunId, input.organizationId);
		}

		if (existing.status === "completed") {
			if (areAnalysisResultsIdentical(existing, input)) {
				return { ...existing };
			}
			throw new ConflictError(
				`Analysis result for run '${input.analysisRunId}' is immutable and has already been saved with differing content`,
			);
		}

		if (existing.status !== "processing") {
			throw new InvalidStateError(
				`Cannot save result for analysis run '${input.analysisRunId}' in status '${existing.status}'; run must be in 'processing' status`,
				existing.status,
				"completed",
			);
		}

		existing.status = "completed";
		existing.verdict = input.verdict;
		existing.score = input.score;
		existing.confidence = input.confidence;
		existing.analysisVersion = input.analysisVersion;
		existing.rulesetVersion = input.rulesetVersion;
		existing.resultSchemaVersion = input.resultSchemaVersion;
		existing.resultSnapshot = input.resultSnapshot;
		existing.phase = "completed";
		existing.progress = 100;
		existing.completedAt = input.completedAt ?? new Date();
		existing.updatedAt = new Date();

		return { ...existing };
	}

	async retryAnalysisRun(input: RetryAnalysisRunInput): Promise<AnalysisRunShell> {
		assertOrganizationId(input.organizationId);
		const existing = this.records.find(
			(r) => r.organizationId === input.organizationId && r.id === input.analysisRunId,
		);
		if (!existing) {
			throw new NotFoundError("analysis_run", input.analysisRunId, input.organizationId);
		}

		if (existing.status !== "failed" && existing.status !== "deferred") {
			throw new InvalidStateError(
				`Cannot retry analysis run '${input.analysisRunId}' with status '${existing.status}'; only 'failed' or 'deferred' runs can be retried`,
				existing.status,
				"queued",
			);
		}

		if (!existing.retryable) {
			throw new InvalidStateError(`Analysis run '${input.analysisRunId}' is not marked as retryable`);
		}

		const maxAttempts = input.maxAttempts ?? 3;
		if (existing.attempts >= maxAttempts) {
			throw new InvalidStateError(
				`Maximum retry attempts (${maxAttempts}) exceeded for analysis run '${input.analysisRunId}' (current: ${existing.attempts})`,
			);
		}

		existing.status = "queued";
		existing.attempts += 1;
		existing.failureCode = null;
		existing.failureMessage = null;
		existing.failedAt = null;
		existing.queuedAt = new Date();
		existing.phase = "queued";
		existing.progress = 0;
		existing.updatedAt = new Date();

		return { ...existing };
	}
}

export class MemoryReportRepository implements ReportRepository {
	constructor(
		private readonly records: ReportShell[],
		private readonly cases?: CaseShell[],
		private readonly analysisRuns?: AnalysisRunShell[],
	) {}

	async createReport(input: CreateReportInput): Promise<ReportShell> {
		assertOrganizationId(input.organizationId);

		if (this.cases) {
			const caseExists = this.cases.some((c) => c.organizationId === input.organizationId && c.id === input.caseId);
			if (!caseExists) {
				throw new DependencyError(
					`Case '${input.caseId}' does not exist for organization '${input.organizationId}'`,
					"cases",
				);
			}
		}

		if (this.analysisRuns) {
			const runExists = this.analysisRuns.some(
				(r) => r.organizationId === input.organizationId && r.caseId === input.caseId && r.id === input.analysisRunId,
			);
			if (!runExists) {
				throw new DependencyError(
					`Analysis run '${input.analysisRunId}' does not exist for organization '${input.organizationId}' and case '${input.caseId}'`,
					"analysisRuns",
				);
			}
		}

		let version = input.version;
		if (version === undefined) {
			const existingForRun = this.records.filter(
				(r) =>
					r.organizationId === input.organizationId &&
					r.analysisRunId === input.analysisRunId &&
					r.format === input.format,
			);
			version = existingForRun.reduce((max, r) => Math.max(max, r.version), 0) + 1;
		} else {
			const duplicateVersion = this.records.some(
				(r) =>
					r.organizationId === input.organizationId &&
					r.analysisRunId === input.analysisRunId &&
					r.format === input.format &&
					r.version === version,
			);
			if (duplicateVersion) {
				throw new ConflictError(
					`Report with version ${version} and format '${input.format}' already exists for analysis run '${input.analysisRunId}'`,
				);
			}
		}

		if (input.objectKey) {
			const duplicateKey = this.records.some((r) => r.objectKey === input.objectKey);
			if (duplicateKey) {
				throw new ConflictError(`Report with objectKey '${input.objectKey}' already exists`);
			}
		}

		const now = new Date();
		const record: ReportShell = {
			id: input.id ?? `report_${randomUUID()}`,
			organizationId: input.organizationId,
			caseId: input.caseId,
			analysisRunId: input.analysisRunId,
			version,
			status: input.status ?? "pending",
			format: input.format,
			objectKey: input.objectKey ?? null,
			metadata: input.metadata ?? {},
			failureReason: null,
			generatedAt: null,
			createdAt: now,
			updatedAt: now,
		};
		this.records.push(record);
		return { ...record };
	}

	async getReport(input: GetReportInput): Promise<ReportShell | null> {
		assertOrganizationId(input.organizationId);
		const found = this.records.find(
			(r) =>
				r.organizationId === input.organizationId &&
				r.id === input.reportId &&
				(input.caseId ? r.caseId === input.caseId : true),
		);
		return found ? { ...found } : null;
	}

	async listReports(input: ListReportsInput): Promise<ReportShell[]> {
		assertOrganizationId(input.organizationId);
		let list = this.records
			.filter((r) => {
				if (r.organizationId !== input.organizationId) return false;
				if (input.caseId && r.caseId !== input.caseId) return false;
				if (input.analysisRunId && r.analysisRunId !== input.analysisRunId) return false;
				if (input.format && r.format !== input.format) return false;
				if (input.status && r.status !== input.status) return false;
				return true;
			})
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

		if (input.offset !== undefined) list = list.slice(input.offset);
		if (input.limit !== undefined) list = list.slice(0, input.limit);
		return list.map((r) => ({ ...r }));
	}

	async updateReportStatus(input: UpdateReportStatusInput): Promise<ReportShell> {
		assertOrganizationId(input.organizationId);
		const existing = this.records.find((r) => r.organizationId === input.organizationId && r.id === input.reportId);
		if (!existing) {
			throw new NotFoundError("report", input.reportId, input.organizationId);
		}

		if (existing.status === "completed" && (input.status === "pending" || input.status === "generating")) {
			throw new InvalidStateError(
				`Cannot update completed report '${input.reportId}' back to '${input.status}'`,
				existing.status,
				input.status,
			);
		}

		existing.status = input.status;
		if (input.objectKey !== undefined) existing.objectKey = input.objectKey;
		if (input.failureReason !== undefined) existing.failureReason = input.failureReason;
		if (input.metadata !== undefined) existing.metadata = { ...existing.metadata, ...input.metadata };
		if (input.generatedAt !== undefined) {
			existing.generatedAt = input.generatedAt;
		} else if (input.status === "completed" && !existing.generatedAt) {
			existing.generatedAt = new Date();
		}
		existing.updatedAt = new Date();

		return { ...existing };
	}
}

export class MemoryAuditRepository implements AuditRepository {
	constructor(private readonly records: AuditRecordShell[]) {}

	async appendAuditRecord(input: AppendAuditRecordInput): Promise<AuditRecordShell> {
		assertOrganizationId(input.organizationId);
		const record: AuditRecordShell = {
			id: input.id ?? `audit_${randomUUID()}`,
			organizationId: input.organizationId,
			action: input.action,
			resourceType: input.resourceType,
			resourceId: input.resourceId ?? null,
			actorUserId: input.actorUserId ?? null,
			metadata: input.metadata ?? {},
			createdAt: input.createdAt ?? new Date(),
		};
		this.records.push(record);
		return { ...record };
	}

	async listAuditRecords(input: ListAuditRecordsInput): Promise<AuditRecordShell[]> {
		assertOrganizationId(input.organizationId);
		let list = this.records
			.filter((a) => {
				if (a.organizationId !== input.organizationId) return false;
				if (input.resourceType && a.resourceType !== input.resourceType) return false;
				if (input.resourceId && a.resourceId !== input.resourceId) return false;
				return true;
			})
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

		if (input.offset !== undefined) list = list.slice(input.offset);
		if (input.limit !== undefined) list = list.slice(0, input.limit);
		return list.map((a) => ({ ...a }));
	}
}

// ---------------------------------------------------------------------------
// Memory Repositories Aggregator & Transaction Simulator
// ---------------------------------------------------------------------------

export interface MemoryState {
	organizations?: OrganizationShell[];
	memberships?: MembershipShell[];
	cases?: CaseShell[];
	evidence?: EvidenceShell[];
	analysisRuns?: AnalysisRunShell[];
	reports?: ReportShell[];
	auditRecords?: AuditRecordShell[];
}

export class MemoryRepositories implements Repositories {
	readonly organizationsList: OrganizationShell[];
	readonly membershipsList: MembershipShell[];
	readonly casesList: CaseShell[];
	readonly evidenceList: EvidenceShell[];
	readonly analysisRunsList: AnalysisRunShell[];
	readonly reportsList: ReportShell[];
	readonly auditRecordsList: AuditRecordShell[];

	readonly organizations: MemoryOrganizationRepository;
	readonly memberships: MemoryMembershipRepository;
	readonly cases: MemoryCaseRepository;
	readonly evidence: MemoryEvidenceRepository;
	readonly analysisRuns: MemoryAnalysisRunRepository;
	readonly reports: MemoryReportRepository;
	readonly audit: MemoryAuditRepository;

	constructor(initialState?: MemoryState) {
		this.organizationsList = [...(initialState?.organizations ?? [])];
		this.membershipsList = [...(initialState?.memberships ?? [])];
		this.casesList = [...(initialState?.cases ?? [])];
		this.evidenceList = [...(initialState?.evidence ?? [])];
		this.analysisRunsList = [...(initialState?.analysisRuns ?? [])];
		this.reportsList = [...(initialState?.reports ?? [])];
		this.auditRecordsList = [...(initialState?.auditRecords ?? [])];

		this.organizations = new MemoryOrganizationRepository(this.organizationsList);
		this.memberships = new MemoryMembershipRepository(this.membershipsList);
		this.cases = new MemoryCaseRepository(this.casesList);
		this.evidence = new MemoryEvidenceRepository(this.evidenceList, this.casesList);
		this.analysisRuns = new MemoryAnalysisRunRepository(this.analysisRunsList, this.casesList, this.evidenceList);
		this.reports = new MemoryReportRepository(this.reportsList, this.casesList, this.analysisRunsList);
		this.audit = new MemoryAuditRepository(this.auditRecordsList);
	}

	snapshot(): MemoryState {
		return {
			organizations: this.organizationsList.map((x) => ({ ...x })),
			memberships: this.membershipsList.map((x) => ({ ...x })),
			cases: this.casesList.map((x) => ({ ...x })),
			evidence: this.evidenceList.map((x) => ({ ...x })),
			analysisRuns: this.analysisRunsList.map((x) => ({
				...x,
				resultSnapshot: x.resultSnapshot ? JSON.parse(JSON.stringify(x.resultSnapshot)) : null,
			})),
			reports: this.reportsList.map((x) => ({ ...x, metadata: { ...x.metadata } })),
			auditRecords: this.auditRecordsList.map((x) => ({ ...x, metadata: { ...x.metadata } })),
		};
	}

	restore(snapshot: MemoryState) {
		this.organizationsList.length = 0;
		this.organizationsList.push(...(snapshot.organizations ?? []));
		this.membershipsList.length = 0;
		this.membershipsList.push(...(snapshot.memberships ?? []));
		this.casesList.length = 0;
		this.casesList.push(...(snapshot.cases ?? []));
		this.evidenceList.length = 0;
		this.evidenceList.push(...(snapshot.evidence ?? []));
		this.analysisRunsList.length = 0;
		this.analysisRunsList.push(...(snapshot.analysisRuns ?? []));
		this.reportsList.length = 0;
		this.reportsList.push(...(snapshot.reports ?? []));
		this.auditRecordsList.length = 0;
		this.auditRecordsList.push(...(snapshot.auditRecords ?? []));
	}

	async transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
		const saved = this.snapshot();
		try {
			return await fn(this);
		} catch (error) {
			this.restore(saved);
			throw error;
		}
	}
}

// ---------------------------------------------------------------------------
// Transaction Helpers & Composite Workflows
// ---------------------------------------------------------------------------

export function createDrizzleRepositories(db: DrizzleClient): Repositories {
	return {
		cases: new DrizzleCaseRepository(db),
		evidence: new DrizzleEvidenceRepository(db),
		analysisRuns: new DrizzleAnalysisRunRepository(db),
		reports: new DrizzleReportRepository(db),
		audit: new DrizzleAuditRepository(db),
	};
}

export function createMemoryRepositories(initialState?: MemoryState): MemoryRepositories {
	return new MemoryRepositories(initialState);
}

export async function executeTransaction<T>(
	db: PostgresJsDatabase<typeof schema>,
	fn: (repos: Repositories) => Promise<T>,
): Promise<T> {
	try {
		return await db.transaction(async (tx) => {
			const repos = createDrizzleRepositories(tx);
			return await fn(repos);
		});
	} catch (err) {
		if (err instanceof RepositoryError) {
			throw err;
		}
		if (isDatabaseError(err)) {
			mapDatabaseError(err, "executeTransaction");
		}
		throw err;
	}
}

export interface CreateEvidenceWithRunAndAuditInput extends TenantCaseKey {
	evidence: {
		id?: string;
		objectKey: string;
		sha256: string;
		byteSize: number;
		contentType?: string;
		idempotencyKey?: string | null;
		status?: EvidenceStatus;
	};
	run?: {
		id?: string;
		idempotencyKey?: string | null;
		analysisVersion?: string | null;
		rulesetVersion?: string | null;
		status?: AnalysisRunStatus;
	};
	audit?: {
		actorUserId?: string | null;
		metadata?: Record<string, string>;
	};
}

export interface CreateEvidenceWithRunAndAuditResult {
	evidence: EvidenceShell;
	run: AnalysisRunShell;
	audit: AuditRecordShell;
}

export async function createEvidenceWithRunAndAudit(
	repos: Repositories,
	input: CreateEvidenceWithRunAndAuditInput,
): Promise<CreateEvidenceWithRunAndAuditResult> {
	assertOrganizationId(input.organizationId);

	let evidence = await repos.evidence.createPending({
		organizationId: input.organizationId,
		caseId: input.caseId,
		id: input.evidence.id,
		objectKey: input.evidence.objectKey,
		sha256: input.evidence.sha256,
		byteSize: input.evidence.byteSize,
		contentType: input.evidence.contentType,
		idempotencyKey: input.evidence.idempotencyKey,
	});

	if (input.evidence.status === "stored") {
		evidence = await repos.evidence.markStored({
			organizationId: input.organizationId,
			evidenceId: evidence.id,
			caseId: input.caseId,
		});
	} else if (input.evidence.status === "verified") {
		evidence = await repos.evidence.markVerified({
			organizationId: input.organizationId,
			evidenceId: evidence.id,
			caseId: input.caseId,
		});
	}

	const run = await repos.analysisRuns.createAnalysisRun({
		organizationId: input.organizationId,
		caseId: input.caseId,
		evidenceId: evidence.id,
		id: input.run?.id,
		idempotencyKey: input.run?.idempotencyKey,
		analysisVersion: input.run?.analysisVersion,
		rulesetVersion: input.run?.rulesetVersion,
		status: input.run?.status ?? "accepted",
	});

	const audit = await repos.audit.appendAuditRecord({
		organizationId: input.organizationId,
		action: "evidence.intake_created",
		resourceType: "evidence",
		resourceId: evidence.id,
		actorUserId: input.audit?.actorUserId,
		metadata: {
			caseId: input.caseId,
			analysisRunId: run.id,
			...(input.audit?.metadata ?? {}),
		},
	});

	return { evidence, run, audit };
}

export interface CreateAnalysisRunWithAuditInput extends TenantCaseKey {
	evidenceId?: string | null;
	run?: {
		id?: string;
		idempotencyKey?: string | null;
		analysisVersion?: string | null;
		rulesetVersion?: string | null;
		status?: AnalysisRunStatus;
	};
	audit?: {
		actorUserId?: string | null;
		metadata?: Record<string, string>;
	};
}

export async function createAnalysisRunWithAudit(
	repos: Repositories,
	input: CreateAnalysisRunWithAuditInput,
): Promise<{ run: AnalysisRunShell; audit: AuditRecordShell }> {
	assertOrganizationId(input.organizationId);

	const run = await repos.analysisRuns.createAnalysisRun({
		organizationId: input.organizationId,
		caseId: input.caseId,
		evidenceId: input.evidenceId,
		id: input.run?.id,
		idempotencyKey: input.run?.idempotencyKey,
		analysisVersion: input.run?.analysisVersion,
		rulesetVersion: input.run?.rulesetVersion,
		status: input.run?.status ?? "accepted",
	});

	const audit = await repos.audit.appendAuditRecord({
		organizationId: input.organizationId,
		action: "analysis.created",
		resourceType: "analysis_run",
		resourceId: run.id,
		actorUserId: input.audit?.actorUserId,
		metadata: {
			caseId: input.caseId,
			evidenceId: input.evidenceId ?? "",
			...(input.audit?.metadata ?? {}),
		},
	});

	return { run, audit };
}

export interface SaveResultWithAuditInput extends SaveAnalysisResultInput {
	audit?: {
		actorUserId?: string | null;
		metadata?: Record<string, string>;
	};
}

export async function saveResultWithAudit(
	repos: Repositories,
	input: SaveResultWithAuditInput,
): Promise<{ run: AnalysisRunShell; audit: AuditRecordShell }> {
	assertOrganizationId(input.organizationId);

	const run = await repos.analysisRuns.saveResult(input);

	const audit = await repos.audit.appendAuditRecord({
		organizationId: input.organizationId,
		action: "analysis.completed",
		resourceType: "analysis_run",
		resourceId: run.id,
		actorUserId: input.audit?.actorUserId,
		metadata: {
			caseId: run.caseId,
			verdict: run.verdict ?? "",
			score: run.score !== null ? String(run.score) : "",
			...(input.audit?.metadata ?? {}),
		},
	});

	return { run, audit };
}
