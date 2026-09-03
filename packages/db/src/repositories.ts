import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
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

export function encodeCursor(createdAt: Date | string, id: string, sequence?: number | null): string {
	const iso = typeof createdAt === "string" ? createdAt : createdAt.toISOString();
	const payload: { createdAt: string; id: string; sequence?: number } = { createdAt: iso, id };
	if (sequence !== undefined && sequence !== null) {
		payload.sequence = sequence;
	}
	return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string; sequence?: number | null } | null {
	try {
		if (cursor.length === 0 || cursor.length > 1024) return null;
		const raw = Buffer.from(cursor, "base64url").toString("utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const value = parsed as Record<string, unknown>;
		if (
			typeof value.createdAt === "string" &&
			typeof value.id === "string" &&
			/^[A-Za-z0-9_-]{1,200}$/.test(value.id)
		) {
			const createdAt = new Date(value.createdAt);
			if (!Number.isNaN(createdAt.getTime())) {
				const sequence = typeof value.sequence === "number" && Number.isInteger(value.sequence) ? value.sequence : null;
				return { createdAt, id: value.id, sequence };
			}
		}
		return null;
	} catch {
		return null;
	}
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
export type IngestionBatchShell = typeof schema.ingestionBatches.$inferSelect;
export type MailboxConnectionShell = typeof schema.mailboxConnections.$inferSelect;

export type AnalysisRunStatus = (typeof schema.analysisRunStatus.enumValues)[number];
export type AnalysisVerdict = (typeof schema.analysisVerdict.enumValues)[number];
export type EvidenceStatus = (typeof schema.evidenceStatus.enumValues)[number];
export type ReportStatus = (typeof schema.reportStatus.enumValues)[number];
export type ReportFormat = (typeof schema.reportFormat.enumValues)[number];
export type IngestionBatchSource = (typeof schema.ingestionBatchSource.enumValues)[number];
export type IngestionBatchStatus = (typeof schema.ingestionBatchStatus.enumValues)[number];
export type MailboxProvider = (typeof schema.mailboxProvider.enumValues)[number];
export type MailboxConnectionStatus = (typeof schema.mailboxConnectionStatus.enumValues)[number];

export type CreateCaseInput = TenantContext & { title: string; id?: string };

export interface ListCasesInput extends TenantContext {
	limit?: number;
	offset?: number;
	cursor?: string | null;
}

export interface CreatePendingEvidenceInput extends TenantCaseKey {
	id?: string;
	objectKey: string;
	sha256: string;
	byteSize: number;
	contentType?: string;
	idempotencyKey?: string | null;
	batchId?: string | null;
	sequence?: number | null;
	sourceMessageId?: string | null;
}

export interface CreateVerifiedEvidenceInput extends TenantCaseKey {
	id?: string;
	objectKey: string;
	sha256: string;
	byteSize: number;
	contentType?: string;
	idempotencyKey?: string | null;
	batchId?: string | null;
	sequence?: number | null;
	sourceMessageId?: string | null;
}

export interface ListEvidenceByBatchInput extends TenantContext {
	batchId: string;
	caseId?: string;
	limit?: number;
	cursor?: string | null;
}

export interface CreateIngestionBatchInput extends TenantCaseKey {
	id?: string;
	source: IngestionBatchSource;
	status?: IngestionBatchStatus;
	containerEvidenceId?: string | null;
	messageCount?: number;
	readyCount?: number;
	failedCount?: number;
	metadata?: Record<string, unknown>;
	failureReason?: string | null;
}

export interface GetIngestionBatchInput extends TenantContext {
	batchId: string;
	caseId?: string;
}

export interface ListIngestionBatchesInput extends TenantCaseKey {
	status?: IngestionBatchStatus;
	limit?: number;
	offset?: number;
	cursor?: string | null;
}

export interface TransitionBatchStatusInput extends TenantContext {
	batchId: string;
	caseId?: string;
	status: IngestionBatchStatus;
	failureReason?: string | null;
	metadata?: Record<string, unknown>;
}

export interface IncrementBatchCountsInput extends TenantContext {
	batchId: string;
	caseId?: string;
	readyIncrement?: number;
	failedIncrement?: number;
}

export interface UpsertMailboxConnectionInput extends TenantContext {
	id?: string;
	provider: MailboxProvider;
	accountEmail: string;
	encryptedRefreshToken: string;
	tokenNonce: string;
	scopes?: string | null;
	syncCursor?: string | null;
	status?: MailboxConnectionStatus;
	createdByUserId?: string | null;
	lastSyncedAt?: Date | null;
	lastFailureReason?: string | null;
}

export interface GetMailboxConnectionInput extends TenantContext {
	connectionId?: string;
	accountEmail?: string;
	provider?: MailboxProvider;
}

export interface ListMailboxConnectionsInput extends TenantContext {
	limit?: number;
	offset?: number;
	cursor?: string | null;
}

export interface UpdateMailboxCursorAndStatusInput extends TenantContext {
	connectionId: string;
	syncCursor?: string | null;
	status?: MailboxConnectionStatus;
	lastSyncedAt?: Date | null;
	lastFailureReason?: string | null;
}

export interface DeleteMailboxConnectionInput extends TenantContext {
	connectionId: string;
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
	cursor?: string | null;
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
	cursor?: string | null;
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
	queuedAt?: Date;
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
	cursor?: string | null;
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
	listCases(input: ListCasesInput): Promise<CaseShell[]>;
	getCase(input: TenantCaseKey): Promise<CaseShell | null>;
	createCase(input: CreateCaseInput): Promise<CaseShell>;
}

export interface EvidenceRepository {
	createPending(input: CreatePendingEvidenceInput): Promise<EvidenceShell>;
	createVerified(input: CreateVerifiedEvidenceInput): Promise<EvidenceShell>;
	markStored(input: MarkEvidenceStoredInput): Promise<EvidenceShell>;
	markVerified(input: MarkEvidenceVerifiedInput): Promise<EvidenceShell>;
	markFailed(input: MarkEvidenceFailedInput): Promise<EvidenceShell>;
	getEvidence(input: GetEvidenceInput): Promise<EvidenceShell | null>;
	listEvidence(input: ListEvidenceInput): Promise<EvidenceShell[]>;
	listEvidenceByBatch(input: ListEvidenceByBatchInput): Promise<EvidenceShell[]>;
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

export interface IngestionBatchRepository {
	createBatch(input: CreateIngestionBatchInput): Promise<IngestionBatchShell>;
	getBatch(input: GetIngestionBatchInput): Promise<IngestionBatchShell | null>;
	listBatchesByCase(input: ListIngestionBatchesInput): Promise<IngestionBatchShell[]>;
	transitionStatus(input: TransitionBatchStatusInput): Promise<IngestionBatchShell>;
	incrementCounts(input: IncrementBatchCountsInput): Promise<IngestionBatchShell>;
}

export interface MailboxConnectionRepository {
	upsertConnection(input: UpsertMailboxConnectionInput): Promise<MailboxConnectionShell>;
	getConnection(input: GetMailboxConnectionInput): Promise<MailboxConnectionShell | null>;
	listConnections(input: ListMailboxConnectionsInput): Promise<MailboxConnectionShell[]>;
	updateCursorAndStatus(input: UpdateMailboxCursorAndStatusInput): Promise<MailboxConnectionShell>;
	deleteConnection(input: DeleteMailboxConnectionInput): Promise<boolean>;
}

export interface Repositories {
	cases: CaseRepository;
	evidence: EvidenceRepository;
	analysisRuns: AnalysisRunRepository;
	reports: ReportRepository;
	audit: AuditRepository;
	batches: IngestionBatchRepository;
	mailbox: MailboxConnectionRepository;
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

	async listCases(input: ListCasesInput): Promise<CaseShell[]> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [eq(schema.cases.organizationId, input.organizationId)];
			if (input.cursor) {
				const decoded = decodeCursor(input.cursor);
				if (decoded) {
					conditions.push(
						// biome-ignore lint/style/noNonNullAssertion: or() has two concrete predicates here
						or(
							lt(schema.cases.createdAt, decoded.createdAt),
							and(eq(schema.cases.createdAt, decoded.createdAt), lt(schema.cases.id, decoded.id)),
						)!,
					);
				}
			}

			let query = this.db
				.select()
				.from(schema.cases)
				.where(and(...conditions))
				.orderBy(desc(schema.cases.createdAt), desc(schema.cases.id));

			if (input.limit !== undefined) query = query.limit(input.limit) as typeof query;
			if (input.offset !== undefined) query = query.offset(input.offset) as typeof query;

			return await query;
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
					batchId: input.batchId ?? null,
					sequence: input.sequence ?? null,
					sourceMessageId: input.sourceMessageId ?? null,
				})
				.returning();
			if (!created) throw new RepositoryError("Evidence creation returned no record");
			return created;
		} catch (err) {
			mapDatabaseError(err, "createPendingEvidence");
		}
	}

	async createVerified(input: CreateVerifiedEvidenceInput): Promise<EvidenceShell> {
		assertOrganizationId(input.organizationId);
		try {
			const now = new Date();
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
					status: "verified",
					storedAt: now,
					verifiedAt: now,
					idempotencyKey: input.idempotencyKey ?? null,
					batchId: input.batchId ?? null,
					sequence: input.sequence ?? null,
					sourceMessageId: input.sourceMessageId ?? null,
				})
				.returning();
			if (!created) throw new RepositoryError("Evidence creation returned no record");
			return created;
		} catch (err) {
			mapDatabaseError(err, "createVerifiedEvidence");
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
			if (input.cursor) {
				const decoded = decodeCursor(input.cursor);
				if (decoded) {
					conditions.push(
						// biome-ignore lint/style/noNonNullAssertion: or() has two concrete predicates here
						or(
							lt(schema.evidenceMetadata.createdAt, decoded.createdAt),
							and(eq(schema.evidenceMetadata.createdAt, decoded.createdAt), lt(schema.evidenceMetadata.id, decoded.id)),
						)!,
					);
				}
			}
			let query = this.db
				.select()
				.from(schema.evidenceMetadata)
				.where(and(...conditions))
				.orderBy(desc(schema.evidenceMetadata.createdAt), desc(schema.evidenceMetadata.id));

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

	async listEvidenceByBatch(input: ListEvidenceByBatchInput): Promise<EvidenceShell[]> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [
				eq(schema.evidenceMetadata.organizationId, input.organizationId),
				eq(schema.evidenceMetadata.batchId, input.batchId),
			];
			if (input.caseId) {
				conditions.push(eq(schema.evidenceMetadata.caseId, input.caseId));
			}
			if (input.cursor) {
				const decoded = decodeCursor(input.cursor);
				if (decoded) {
					if (decoded.sequence !== null && decoded.sequence !== undefined) {
						conditions.push(
							// biome-ignore lint/style/noNonNullAssertion: or() has two concrete predicates here
							or(
								gt(schema.evidenceMetadata.sequence, decoded.sequence),
								and(
									eq(schema.evidenceMetadata.sequence, decoded.sequence),
									or(
										lt(schema.evidenceMetadata.createdAt, decoded.createdAt),
										and(
											eq(schema.evidenceMetadata.createdAt, decoded.createdAt),
											lt(schema.evidenceMetadata.id, decoded.id),
										),
									),
								),
							)!,
						);
					} else {
						conditions.push(
							// biome-ignore lint/style/noNonNullAssertion: or() has two concrete predicates here
							or(
								lt(schema.evidenceMetadata.createdAt, decoded.createdAt),
								and(
									eq(schema.evidenceMetadata.createdAt, decoded.createdAt),
									lt(schema.evidenceMetadata.id, decoded.id),
								),
							)!,
						);
					}
				}
			}
			let query = this.db
				.select()
				.from(schema.evidenceMetadata)
				.where(and(...conditions))
				.orderBy(
					asc(schema.evidenceMetadata.sequence),
					desc(schema.evidenceMetadata.createdAt),
					desc(schema.evidenceMetadata.id),
				);

			if (input.limit !== undefined) {
				query = query.limit(input.limit) as typeof query;
			}

			return await query;
		} catch (err) {
			mapDatabaseError(err, "listEvidenceByBatch");
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
			if (input.cursor) {
				const decoded = decodeCursor(input.cursor);
				if (decoded) {
					conditions.push(
						// biome-ignore lint/style/noNonNullAssertion: or() has two concrete predicates here
						or(
							lt(schema.analysisRuns.createdAt, decoded.createdAt),
							and(eq(schema.analysisRuns.createdAt, decoded.createdAt), lt(schema.analysisRuns.id, decoded.id)),
						)!,
					);
				}
			}

			let query = this.db
				.select()
				.from(schema.analysisRuns)
				.where(and(...conditions))
				.orderBy(desc(schema.analysisRuns.createdAt), desc(schema.analysisRuns.id));

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
			if (input.queuedAt !== undefined) {
				setPayload.queuedAt = input.queuedAt;
			} else if (input.toStatus === "queued") {
				setPayload.queuedAt = new Date();
			}

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
					"accepted",
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
					status: "accepted",
					attempts: existing.attempts + 1,
					failureCode: null,
					failureMessage: null,
					failedAt: null,
					queuedAt: null,
					phase: null,
					progress: null,
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
			if (input.cursor) {
				const decoded = decodeCursor(input.cursor);
				if (decoded) {
					conditions.push(
						// biome-ignore lint/style/noNonNullAssertion: or() has two concrete predicates here
						or(
							lt(schema.reports.createdAt, decoded.createdAt),
							and(eq(schema.reports.createdAt, decoded.createdAt), lt(schema.reports.id, decoded.id)),
						)!,
					);
				}
			}

			let query = this.db
				.select()
				.from(schema.reports)
				.where(and(...conditions))
				.orderBy(desc(schema.reports.createdAt), desc(schema.reports.id));

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

export class DrizzleIngestionBatchRepository implements IngestionBatchRepository {
	constructor(private readonly db: DrizzleClient) {}

	async createBatch(input: CreateIngestionBatchInput): Promise<IngestionBatchShell> {
		assertOrganizationId(input.organizationId);
		try {
			const [created] = await this.db
				.insert(schema.ingestionBatches)
				.values({
					id: input.id ?? `batch_${randomUUID()}`,
					organizationId: input.organizationId,
					caseId: input.caseId,
					source: input.source,
					status: input.status ?? "pending",
					containerEvidenceId: input.containerEvidenceId ?? null,
					messageCount: input.messageCount ?? 0,
					readyCount: input.readyCount ?? 0,
					failedCount: input.failedCount ?? 0,
					metadata: input.metadata ?? {},
					failureReason: input.failureReason ?? null,
				})
				.returning();
			if (!created) throw new RepositoryError("Batch creation returned no record");
			return created;
		} catch (err) {
			mapDatabaseError(err, "createBatch");
		}
	}

	async getBatch(input: GetIngestionBatchInput): Promise<IngestionBatchShell | null> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [
				eq(schema.ingestionBatches.organizationId, input.organizationId),
				eq(schema.ingestionBatches.id, input.batchId),
			];
			if (input.caseId) {
				conditions.push(eq(schema.ingestionBatches.caseId, input.caseId));
			}
			const [row] = await this.db
				.select()
				.from(schema.ingestionBatches)
				.where(and(...conditions))
				.limit(1);
			return row ?? null;
		} catch (err) {
			mapDatabaseError(err, "getBatch");
		}
	}

	async listBatchesByCase(input: ListIngestionBatchesInput): Promise<IngestionBatchShell[]> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [
				eq(schema.ingestionBatches.organizationId, input.organizationId),
				eq(schema.ingestionBatches.caseId, input.caseId),
			];
			if (input.status) {
				conditions.push(eq(schema.ingestionBatches.status, input.status));
			}
			if (input.cursor) {
				const decoded = decodeCursor(input.cursor);
				if (decoded) {
					conditions.push(
						// biome-ignore lint/style/noNonNullAssertion: or() has two concrete predicates here
						or(
							lt(schema.ingestionBatches.createdAt, decoded.createdAt),
							and(eq(schema.ingestionBatches.createdAt, decoded.createdAt), lt(schema.ingestionBatches.id, decoded.id)),
						)!,
					);
				}
			}

			let query = this.db
				.select()
				.from(schema.ingestionBatches)
				.where(and(...conditions))
				.orderBy(desc(schema.ingestionBatches.createdAt), desc(schema.ingestionBatches.id));

			if (input.limit !== undefined) {
				query = query.limit(input.limit) as typeof query;
			}
			if (input.offset !== undefined) {
				query = query.offset(input.offset) as typeof query;
			}

			return await query;
		} catch (err) {
			mapDatabaseError(err, "listBatchesByCase");
		}
	}

	async transitionStatus(input: TransitionBatchStatusInput): Promise<IngestionBatchShell> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [
				eq(schema.ingestionBatches.organizationId, input.organizationId),
				eq(schema.ingestionBatches.id, input.batchId),
			];
			if (input.caseId) {
				conditions.push(eq(schema.ingestionBatches.caseId, input.caseId));
			}

			const updateValues: Partial<typeof schema.ingestionBatches.$inferInsert> = {
				status: input.status,
				updatedAt: new Date(),
			};
			if (input.failureReason !== undefined) {
				updateValues.failureReason = input.failureReason;
			}
			if (input.metadata !== undefined) {
				updateValues.metadata = input.metadata;
			}

			const [updated] = await this.db
				.update(schema.ingestionBatches)
				.set(updateValues)
				.where(and(...conditions))
				.returning();

			if (!updated) {
				throw new NotFoundError("ingestion_batch", input.batchId, input.organizationId);
			}
			return updated;
		} catch (err) {
			mapDatabaseError(err, "transitionBatchStatus");
		}
	}

	async incrementCounts(input: IncrementBatchCountsInput): Promise<IngestionBatchShell> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [
				eq(schema.ingestionBatches.organizationId, input.organizationId),
				eq(schema.ingestionBatches.id, input.batchId),
			];
			if (input.caseId) {
				conditions.push(eq(schema.ingestionBatches.caseId, input.caseId));
			}

			const readyInc = input.readyIncrement ?? 0;
			const failedInc = input.failedIncrement ?? 0;

			const [updated] = await this.db
				.update(schema.ingestionBatches)
				.set({
					readyCount: sql`${schema.ingestionBatches.readyCount} + ${readyInc}`,
					failedCount: sql`${schema.ingestionBatches.failedCount} + ${failedInc}`,
					updatedAt: new Date(),
				})
				.where(and(...conditions))
				.returning();

			if (!updated) {
				throw new NotFoundError("ingestion_batch", input.batchId, input.organizationId);
			}
			return updated;
		} catch (err) {
			mapDatabaseError(err, "incrementBatchCounts");
		}
	}
}

export class DrizzleMailboxConnectionRepository implements MailboxConnectionRepository {
	constructor(private readonly db: DrizzleClient) {}

	async upsertConnection(input: UpsertMailboxConnectionInput): Promise<MailboxConnectionShell> {
		assertOrganizationId(input.organizationId);
		try {
			const id = input.id ?? `conn_${randomUUID()}`;
			const updateSet: Partial<typeof schema.mailboxConnections.$inferInsert> = {
				encryptedRefreshToken: input.encryptedRefreshToken,
				tokenNonce: input.tokenNonce,
				updatedAt: new Date(),
			};
			if (input.scopes !== undefined) updateSet.scopes = input.scopes ?? null;
			if (input.syncCursor !== undefined) updateSet.syncCursor = input.syncCursor ?? null;
			if (input.status !== undefined) updateSet.status = input.status;
			if (input.lastSyncedAt !== undefined) updateSet.lastSyncedAt = input.lastSyncedAt ?? null;
			if (input.lastFailureReason !== undefined) updateSet.lastFailureReason = input.lastFailureReason ?? null;

			const [upserted] = await this.db
				.insert(schema.mailboxConnections)
				.values({
					id,
					organizationId: input.organizationId,
					provider: input.provider,
					accountEmail: input.accountEmail,
					encryptedRefreshToken: input.encryptedRefreshToken,
					tokenNonce: input.tokenNonce,
					scopes: input.scopes ?? null,
					syncCursor: input.syncCursor ?? null,
					status: input.status ?? "connected",
					createdByUserId: input.createdByUserId ?? null,
					lastSyncedAt: input.lastSyncedAt ?? null,
					lastFailureReason: input.lastFailureReason ?? null,
				})
				.onConflictDoUpdate({
					target: [
						schema.mailboxConnections.organizationId,
						schema.mailboxConnections.provider,
						schema.mailboxConnections.accountEmail,
					],
					set: updateSet,
				})
				.returning();
			if (!upserted) throw new RepositoryError("Mailbox connection upsert returned no record");
			return upserted;
		} catch (err) {
			mapDatabaseError(err, "upsertMailboxConnection");
		}
	}

	async getConnection(input: GetMailboxConnectionInput): Promise<MailboxConnectionShell | null> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [eq(schema.mailboxConnections.organizationId, input.organizationId)];
			if (input.connectionId) {
				conditions.push(eq(schema.mailboxConnections.id, input.connectionId));
			}
			if (input.accountEmail) {
				conditions.push(eq(schema.mailboxConnections.accountEmail, input.accountEmail));
			}
			if (input.provider) {
				conditions.push(eq(schema.mailboxConnections.provider, input.provider));
			}
			const [row] = await this.db
				.select()
				.from(schema.mailboxConnections)
				.where(and(...conditions))
				.limit(1);
			return row ?? null;
		} catch (err) {
			mapDatabaseError(err, "getMailboxConnection");
		}
	}

	async listConnections(input: ListMailboxConnectionsInput): Promise<MailboxConnectionShell[]> {
		assertOrganizationId(input.organizationId);
		try {
			const conditions = [eq(schema.mailboxConnections.organizationId, input.organizationId)];
			if (input.cursor) {
				const decoded = decodeCursor(input.cursor);
				if (decoded) {
					conditions.push(
						// biome-ignore lint/style/noNonNullAssertion: or() has two concrete predicates here
						or(
							lt(schema.mailboxConnections.createdAt, decoded.createdAt),
							and(
								eq(schema.mailboxConnections.createdAt, decoded.createdAt),
								lt(schema.mailboxConnections.id, decoded.id),
							),
						)!,
					);
				}
			}
			let query = this.db
				.select()
				.from(schema.mailboxConnections)
				.where(and(...conditions))
				.orderBy(desc(schema.mailboxConnections.createdAt), desc(schema.mailboxConnections.id));

			if (input.limit !== undefined) {
				query = query.limit(input.limit) as typeof query;
			}
			if (input.offset !== undefined) {
				query = query.offset(input.offset) as typeof query;
			}
			return await query;
		} catch (err) {
			mapDatabaseError(err, "listMailboxConnections");
		}
	}

	async updateCursorAndStatus(input: UpdateMailboxCursorAndStatusInput): Promise<MailboxConnectionShell> {
		assertOrganizationId(input.organizationId);
		try {
			const updateValues: Partial<typeof schema.mailboxConnections.$inferInsert> = {
				updatedAt: new Date(),
			};
			if (input.syncCursor !== undefined) updateValues.syncCursor = input.syncCursor;
			if (input.status !== undefined) updateValues.status = input.status;
			if (input.lastSyncedAt !== undefined) updateValues.lastSyncedAt = input.lastSyncedAt;
			if (input.lastFailureReason !== undefined) updateValues.lastFailureReason = input.lastFailureReason;

			const [updated] = await this.db
				.update(schema.mailboxConnections)
				.set(updateValues)
				.where(
					and(
						eq(schema.mailboxConnections.organizationId, input.organizationId),
						eq(schema.mailboxConnections.id, input.connectionId),
					),
				)
				.returning();

			if (!updated) {
				throw new NotFoundError("mailbox_connection", input.connectionId, input.organizationId);
			}
			return updated;
		} catch (err) {
			mapDatabaseError(err, "updateMailboxCursorAndStatus");
		}
	}

	async deleteConnection(input: DeleteMailboxConnectionInput): Promise<boolean> {
		assertOrganizationId(input.organizationId);
		try {
			const deleted = await this.db
				.delete(schema.mailboxConnections)
				.where(
					and(
						eq(schema.mailboxConnections.organizationId, input.organizationId),
						eq(schema.mailboxConnections.id, input.connectionId),
					),
				)
				.returning();
			return deleted.length > 0;
		} catch (err) {
			mapDatabaseError(err, "deleteMailboxConnection");
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

	async listCases(input: ListCasesInput): Promise<CaseShell[]> {
		assertOrganizationId(input.organizationId);
		let list = this.records.filter((record) => record.organizationId === input.organizationId);
		if (input.cursor) {
			const decoded = decodeCursor(input.cursor);
			if (decoded) {
				list = list.filter((r) => {
					const rTime = r.createdAt.getTime();
					const cTime = decoded.createdAt.getTime();
					if (rTime < cTime) return true;
					if (rTime === cTime && r.id < decoded.id) return true;
					return false;
				});
			}
		}
		list.sort((a, b) => {
			const diff = b.createdAt.getTime() - a.createdAt.getTime();
			if (diff !== 0) return diff;
			return b.id.localeCompare(a.id);
		});
		if (input.offset !== undefined) list = list.slice(input.offset);
		if (input.limit !== undefined) list = list.slice(0, input.limit);
		return list.map((record) => ({ ...record }));
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
		private readonly batches?: IngestionBatchShell[],
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

		if (this.batches && input.batchId) {
			const batchExists = this.batches.some(
				(b) => b.organizationId === input.organizationId && b.caseId === input.caseId && b.id === input.batchId,
			);
			if (!batchExists) {
				throw new DependencyError(
					`Batch '${input.batchId}' does not exist for case '${input.caseId}' in organization '${input.organizationId}'`,
					"ingestion_batches",
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
			batchId: input.batchId ?? null,
			sequence: input.sequence ?? null,
			sourceMessageId: input.sourceMessageId ?? null,
			createdAt: now,
			updatedAt: now,
		};
		this.records.push(record);
		return { ...record };
	}

	async createVerified(input: CreateVerifiedEvidenceInput): Promise<EvidenceShell> {
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

		if (this.batches && input.batchId) {
			const batchExists = this.batches.some(
				(b) => b.organizationId === input.organizationId && b.caseId === input.caseId && b.id === input.batchId,
			);
			if (!batchExists) {
				throw new DependencyError(
					`Batch '${input.batchId}' does not exist for case '${input.caseId}' in organization '${input.organizationId}'`,
					"ingestion_batches",
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
			status: "verified",
			idempotencyKey: input.idempotencyKey ?? null,
			storedAt: now,
			verifiedAt: now,
			failedAt: null,
			failureReason: null,
			batchId: input.batchId ?? null,
			sequence: input.sequence ?? null,
			sourceMessageId: input.sourceMessageId ?? null,
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
		let list = this.records.filter(
			(e) =>
				e.organizationId === input.organizationId &&
				e.caseId === input.caseId &&
				(!input.status || e.status === input.status),
		);

		if (input.cursor) {
			const decoded = decodeCursor(input.cursor);
			if (decoded) {
				list = list.filter((e) => {
					const eTime = e.createdAt.getTime();
					const cTime = decoded.createdAt.getTime();
					if (eTime < cTime) return true;
					if (eTime === cTime && e.id < decoded.id) return true;
					return false;
				});
			}
		}

		list.sort((a, b) => {
			const diff = b.createdAt.getTime() - a.createdAt.getTime();
			if (diff !== 0) return diff;
			return b.id.localeCompare(a.id);
		});

		if (input.offset !== undefined) list = list.slice(input.offset);
		if (input.limit !== undefined) list = list.slice(0, input.limit);
		return list.map((e) => ({ ...e }));
	}

	async listEvidenceByBatch(input: ListEvidenceByBatchInput): Promise<EvidenceShell[]> {
		assertOrganizationId(input.organizationId);
		let list = this.records.filter(
			(e) =>
				e.organizationId === input.organizationId &&
				e.batchId === input.batchId &&
				(input.caseId ? e.caseId === input.caseId : true),
		);

		if (input.cursor) {
			const decoded = decodeCursor(input.cursor);
			if (decoded) {
				list = list.filter((e) => {
					if (decoded.sequence !== null && decoded.sequence !== undefined) {
						const eSeq = e.sequence ?? 0;
						if (eSeq > decoded.sequence) return true;
						if (eSeq < decoded.sequence) return false;
					}
					const eTime = e.createdAt.getTime();
					const cTime = decoded.createdAt.getTime();
					if (eTime < cTime) return true;
					if (eTime === cTime && e.id < decoded.id) return true;
					return false;
				});
			}
		}

		list.sort((a, b) => {
			const seqA = a.sequence ?? 0;
			const seqB = b.sequence ?? 0;
			if (seqA !== seqB) return seqA - seqB;
			const diff = b.createdAt.getTime() - a.createdAt.getTime();
			if (diff !== 0) return diff;
			return b.id.localeCompare(a.id);
		});

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
		let list = this.records.filter((r) => {
			if (r.organizationId !== input.organizationId) return false;
			if (input.caseId && r.caseId !== input.caseId) return false;
			if (input.evidenceId && r.evidenceId !== input.evidenceId) return false;
			if (input.status && r.status !== input.status) return false;
			if (input.verdict && r.verdict !== input.verdict) return false;
			return true;
		});

		if (input.cursor) {
			const decoded = decodeCursor(input.cursor);
			if (decoded) {
				list = list.filter((r) => {
					const rTime = r.createdAt.getTime();
					const cTime = decoded.createdAt.getTime();
					if (rTime < cTime) return true;
					if (rTime === cTime && r.id < decoded.id) return true;
					return false;
				});
			}
		}

		list.sort((a, b) => {
			const diff = b.createdAt.getTime() - a.createdAt.getTime();
			if (diff !== 0) return diff;
			return b.id.localeCompare(a.id);
		});

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
		if (input.queuedAt !== undefined) {
			existing.queuedAt = input.queuedAt;
		} else if (input.toStatus === "queued" && !existing.queuedAt) {
			existing.queuedAt = new Date();
		}
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
				"accepted",
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

		existing.status = "accepted";
		existing.attempts += 1;
		existing.failureCode = null;
		existing.failureMessage = null;
		existing.failedAt = null;
		existing.queuedAt = null;
		existing.phase = null;
		existing.progress = null;
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
		let list = this.records.filter((r) => {
			if (r.organizationId !== input.organizationId) return false;
			if (input.caseId && r.caseId !== input.caseId) return false;
			if (input.analysisRunId && r.analysisRunId !== input.analysisRunId) return false;
			if (input.format && r.format !== input.format) return false;
			if (input.status && r.status !== input.status) return false;
			return true;
		});

		if (input.cursor) {
			const decoded = decodeCursor(input.cursor);
			if (decoded) {
				list = list.filter((r) => {
					const rTime = r.createdAt.getTime();
					const cTime = decoded.createdAt.getTime();
					if (rTime < cTime) return true;
					if (rTime === cTime && r.id < decoded.id) return true;
					return false;
				});
			}
		}

		list.sort((a, b) => {
			const diff = b.createdAt.getTime() - a.createdAt.getTime();
			if (diff !== 0) return diff;
			return b.id.localeCompare(a.id);
		});

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

export class MemoryIngestionBatchRepository implements IngestionBatchRepository {
	constructor(
		private readonly records: IngestionBatchShell[],
		private readonly cases?: CaseShell[],
		private readonly evidence?: EvidenceShell[],
	) {}

	async createBatch(input: CreateIngestionBatchInput): Promise<IngestionBatchShell> {
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

		if (this.evidence && input.containerEvidenceId) {
			const evidenceExists = this.evidence.some(
				(e) => e.organizationId === input.organizationId && e.id === input.containerEvidenceId,
			);
			if (!evidenceExists) {
				throw new DependencyError(
					`Container evidence '${input.containerEvidenceId}' does not exist for organization '${input.organizationId}'`,
					"evidence_metadata",
				);
			}
		}

		const now = new Date();
		const record: IngestionBatchShell = {
			id: input.id ?? `batch_${randomUUID()}`,
			organizationId: input.organizationId,
			caseId: input.caseId,
			source: input.source,
			status: input.status ?? "pending",
			containerEvidenceId: input.containerEvidenceId ?? null,
			messageCount: input.messageCount ?? 0,
			readyCount: input.readyCount ?? 0,
			failedCount: input.failedCount ?? 0,
			metadata: input.metadata ?? {},
			failureReason: input.failureReason ?? null,
			createdAt: now,
			updatedAt: now,
		};
		this.records.push(record);
		return { ...record };
	}

	async getBatch(input: GetIngestionBatchInput): Promise<IngestionBatchShell | null> {
		assertOrganizationId(input.organizationId);
		const found = this.records.find(
			(b) =>
				b.organizationId === input.organizationId &&
				b.id === input.batchId &&
				(input.caseId ? b.caseId === input.caseId : true),
		);
		return found ? { ...found } : null;
	}

	async listBatchesByCase(input: ListIngestionBatchesInput): Promise<IngestionBatchShell[]> {
		assertOrganizationId(input.organizationId);
		let list = this.records.filter(
			(b) =>
				b.organizationId === input.organizationId &&
				b.caseId === input.caseId &&
				(!input.status || b.status === input.status),
		);

		if (input.cursor) {
			const decoded = decodeCursor(input.cursor);
			if (decoded) {
				list = list.filter((b) => {
					const bTime = b.createdAt.getTime();
					const cTime = decoded.createdAt.getTime();
					if (bTime < cTime) return true;
					if (bTime === cTime && b.id < decoded.id) return true;
					return false;
				});
			}
		}

		list.sort((a, b) => {
			const diff = b.createdAt.getTime() - a.createdAt.getTime();
			if (diff !== 0) return diff;
			return b.id.localeCompare(a.id);
		});

		if (input.offset !== undefined) list = list.slice(input.offset);
		if (input.limit !== undefined) list = list.slice(0, input.limit);
		return list.map((b) => ({ ...b }));
	}

	async transitionStatus(input: TransitionBatchStatusInput): Promise<IngestionBatchShell> {
		assertOrganizationId(input.organizationId);
		const existing = this.records.find(
			(b) =>
				b.organizationId === input.organizationId &&
				b.id === input.batchId &&
				(input.caseId ? b.caseId === input.caseId : true),
		);
		if (!existing) {
			throw new NotFoundError("ingestion_batch", input.batchId, input.organizationId);
		}

		existing.status = input.status;
		if (input.failureReason !== undefined) existing.failureReason = input.failureReason;
		if (input.metadata !== undefined) existing.metadata = input.metadata;
		existing.updatedAt = new Date();
		return { ...existing };
	}

	async incrementCounts(input: IncrementBatchCountsInput): Promise<IngestionBatchShell> {
		assertOrganizationId(input.organizationId);
		const existing = this.records.find(
			(b) =>
				b.organizationId === input.organizationId &&
				b.id === input.batchId &&
				(input.caseId ? b.caseId === input.caseId : true),
		);
		if (!existing) {
			throw new NotFoundError("ingestion_batch", input.batchId, input.organizationId);
		}

		existing.readyCount += input.readyIncrement ?? 0;
		existing.failedCount += input.failedIncrement ?? 0;
		existing.updatedAt = new Date();
		return { ...existing };
	}
}

export class MemoryMailboxConnectionRepository implements MailboxConnectionRepository {
	constructor(private readonly records: MailboxConnectionShell[]) {}

	async upsertConnection(input: UpsertMailboxConnectionInput): Promise<MailboxConnectionShell> {
		assertOrganizationId(input.organizationId);
		const existingIndex = this.records.findIndex(
			(c) =>
				c.organizationId === input.organizationId &&
				c.provider === input.provider &&
				c.accountEmail === input.accountEmail,
		);

		const now = new Date();
		if (existingIndex >= 0) {
			const existing = this.records[existingIndex];
			if (!existing) {
				throw new RepositoryError("Mailbox connection record not found");
			}
			existing.encryptedRefreshToken = input.encryptedRefreshToken;
			existing.tokenNonce = input.tokenNonce;
			if (input.scopes !== undefined) existing.scopes = input.scopes ?? null;
			if (input.syncCursor !== undefined) existing.syncCursor = input.syncCursor ?? null;
			if (input.status !== undefined) existing.status = input.status;
			if (input.lastSyncedAt !== undefined) existing.lastSyncedAt = input.lastSyncedAt ?? null;
			if (input.lastFailureReason !== undefined) existing.lastFailureReason = input.lastFailureReason ?? null;
			existing.updatedAt = now;
			return { ...existing };
		}

		const record: MailboxConnectionShell = {
			id: input.id ?? `conn_${randomUUID()}`,
			organizationId: input.organizationId,
			provider: input.provider,
			accountEmail: input.accountEmail,
			encryptedRefreshToken: input.encryptedRefreshToken,
			tokenNonce: input.tokenNonce,
			scopes: input.scopes ?? null,
			syncCursor: input.syncCursor ?? null,
			status: input.status ?? "connected",
			createdByUserId: input.createdByUserId ?? null,
			lastSyncedAt: input.lastSyncedAt ?? null,
			lastFailureReason: input.lastFailureReason ?? null,
			createdAt: now,
			updatedAt: now,
		};
		this.records.push(record);
		return { ...record };
	}

	async getConnection(input: GetMailboxConnectionInput): Promise<MailboxConnectionShell | null> {
		assertOrganizationId(input.organizationId);
		const found = this.records.find(
			(c) =>
				c.organizationId === input.organizationId &&
				(!input.connectionId || c.id === input.connectionId) &&
				(!input.accountEmail || c.accountEmail === input.accountEmail) &&
				(!input.provider || c.provider === input.provider),
		);
		return found ? { ...found } : null;
	}

	async listConnections(input: ListMailboxConnectionsInput): Promise<MailboxConnectionShell[]> {
		assertOrganizationId(input.organizationId);
		let list = this.records.filter((c) => c.organizationId === input.organizationId);

		if (input.cursor) {
			const decoded = decodeCursor(input.cursor);
			if (decoded) {
				list = list.filter((c) => {
					const cTime = c.createdAt.getTime();
					const curTime = decoded.createdAt.getTime();
					if (cTime < curTime) return true;
					if (cTime === curTime && c.id < decoded.id) return true;
					return false;
				});
			}
		}

		list.sort((a, b) => {
			const diff = b.createdAt.getTime() - a.createdAt.getTime();
			if (diff !== 0) return diff;
			return b.id.localeCompare(a.id);
		});

		if (input.offset !== undefined) list = list.slice(input.offset);
		if (input.limit !== undefined) list = list.slice(0, input.limit);
		return list.map((c) => ({ ...c }));
	}

	async updateCursorAndStatus(input: UpdateMailboxCursorAndStatusInput): Promise<MailboxConnectionShell> {
		assertOrganizationId(input.organizationId);
		const existing = this.records.find((c) => c.organizationId === input.organizationId && c.id === input.connectionId);
		if (!existing) {
			throw new NotFoundError("mailbox_connection", input.connectionId, input.organizationId);
		}

		if (input.syncCursor !== undefined) existing.syncCursor = input.syncCursor;
		if (input.status !== undefined) existing.status = input.status;
		if (input.lastSyncedAt !== undefined) existing.lastSyncedAt = input.lastSyncedAt;
		if (input.lastFailureReason !== undefined) existing.lastFailureReason = input.lastFailureReason;
		existing.updatedAt = new Date();
		return { ...existing };
	}

	async deleteConnection(input: DeleteMailboxConnectionInput): Promise<boolean> {
		assertOrganizationId(input.organizationId);
		const index = this.records.findIndex(
			(c) => c.organizationId === input.organizationId && c.id === input.connectionId,
		);
		if (index === -1) return false;
		this.records.splice(index, 1);
		return true;
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
	batches?: IngestionBatchShell[];
	mailboxConnections?: MailboxConnectionShell[];
}

export class MemoryRepositories implements Repositories {
	readonly organizationsList: OrganizationShell[];
	readonly membershipsList: MembershipShell[];
	readonly casesList: CaseShell[];
	readonly evidenceList: EvidenceShell[];
	readonly analysisRunsList: AnalysisRunShell[];
	readonly reportsList: ReportShell[];
	readonly auditRecordsList: AuditRecordShell[];
	readonly ingestionBatchesList: IngestionBatchShell[];
	readonly mailboxConnectionsList: MailboxConnectionShell[];

	readonly organizations: MemoryOrganizationRepository;
	readonly memberships: MemoryMembershipRepository;
	readonly cases: MemoryCaseRepository;
	readonly evidence: MemoryEvidenceRepository;
	readonly analysisRuns: MemoryAnalysisRunRepository;
	readonly reports: MemoryReportRepository;
	readonly audit: MemoryAuditRepository;
	readonly batches: MemoryIngestionBatchRepository;
	readonly mailbox: MemoryMailboxConnectionRepository;

	constructor(initialState?: MemoryState) {
		this.organizationsList = [...(initialState?.organizations ?? [])];
		this.membershipsList = [...(initialState?.memberships ?? [])];
		this.casesList = [...(initialState?.cases ?? [])];
		this.evidenceList = [...(initialState?.evidence ?? [])];
		this.analysisRunsList = [...(initialState?.analysisRuns ?? [])];
		this.reportsList = [...(initialState?.reports ?? [])];
		this.auditRecordsList = [...(initialState?.auditRecords ?? [])];
		this.ingestionBatchesList = [...(initialState?.batches ?? [])];
		this.mailboxConnectionsList = [...(initialState?.mailboxConnections ?? [])];

		this.organizations = new MemoryOrganizationRepository(this.organizationsList);
		this.memberships = new MemoryMembershipRepository(this.membershipsList);
		this.cases = new MemoryCaseRepository(this.casesList);
		this.evidence = new MemoryEvidenceRepository(this.evidenceList, this.casesList, this.ingestionBatchesList);
		this.analysisRuns = new MemoryAnalysisRunRepository(this.analysisRunsList, this.casesList, this.evidenceList);
		this.reports = new MemoryReportRepository(this.reportsList, this.casesList, this.analysisRunsList);
		this.audit = new MemoryAuditRepository(this.auditRecordsList);
		this.batches = new MemoryIngestionBatchRepository(this.ingestionBatchesList, this.casesList, this.evidenceList);
		this.mailbox = new MemoryMailboxConnectionRepository(this.mailboxConnectionsList);
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
			batches: this.ingestionBatchesList.map((x) => ({ ...x, metadata: { ...x.metadata } })),
			mailboxConnections: this.mailboxConnectionsList.map((x) => ({ ...x })),
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
		this.ingestionBatchesList.length = 0;
		this.ingestionBatchesList.push(...(snapshot.batches ?? []));
		this.mailboxConnectionsList.length = 0;
		this.mailboxConnectionsList.push(...(snapshot.mailboxConnections ?? []));
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
		batches: new DrizzleIngestionBatchRepository(db),
		mailbox: new DrizzleMailboxConnectionRepository(db),
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
		batchId?: string | null;
		sequence?: number | null;
		sourceMessageId?: string | null;
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
		batchId: input.evidence.batchId,
		sequence: input.evidence.sequence,
		sourceMessageId: input.evidence.sourceMessageId,
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
		action?: string;
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
		action: input.audit?.action ?? "analysis.created",
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
