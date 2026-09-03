import "server-only";

import {
	type MembershipRepository,
	memberships,
	type Repositories,
} from "@mailsentinel/db";
import { and, eq } from "drizzle-orm";
import { auth } from "@/server/auth";
import type { MembershipRole } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { logger } from "@/server/logger";

export type RpcMembership = {
	id?: string;
	organizationId: string;
	userId: string;
	role: MembershipRole;
};

export type MembershipErrorType =
	| "missing_active_org"
	| "not_member"
	| "invalid_org_format";

export type RpcRepositories = Partial<Repositories> & {
	memberships?: MembershipRepository;
};

export type RpcContext = {
	requestId: string;
	userId: string | null;
	organizationId: string | null;
	role?: MembershipRole | null;
	membership?: RpcMembership | null;
	user?: { id: string; email?: string; name?: string } | null;
	membershipError?: MembershipErrorType | null;
	repos?: RpcRepositories;
};

export type AuthClientLike = {
	api: {
		getSession: (options: { headers: Headers }) => Promise<{
			user: { id: string; email?: string; name?: string };
			session?: unknown;
		} | null>;
	};
};

export const ACTIVE_ORG_HEADER = "x-organization-id";
export const ACTIVE_ORG_HEADER_ALIAS = "x-org-id";
const VALID_ORG_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validates the raw organization identifier extracted from the request headers.
 * Rejects empty strings, whitespace-only, overly long values, and illegal characters.
 */
export function validateOrganizationHeader(
	rawHeader: string | null | undefined,
):
	| { valid: true; orgId: string }
	| { valid: false; reason: "missing" | "invalid" } {
	if (!rawHeader) {
		return { valid: false, reason: "missing" };
	}
	const trimmed = rawHeader.trim();
	if (trimmed.length === 0) {
		return { valid: false, reason: "missing" };
	}
	if (!VALID_ORG_ID_PATTERN.test(trimmed)) {
		return { valid: false, reason: "invalid" };
	}
	return { valid: true, orgId: trimmed };
}

/**
 * Creates session-aware oRPC context for each incoming request.
 *
 * Strict multi-tenant security rules:
 * 1. An explicit active organization MUST be supplied by the request via `x-organization-id`
 *    (or `x-org-id`).
 * 2. NO first-membership fallback is permitted: if the active organization header is omitted,
 *    `organizationId` remains null and tenant operations will be rejected with FORBIDDEN.
 * 3. The requested organization is strictly validated against the authenticated user's active
 *    memberships in the database. If the user is not a member of the requested organization,
 *    `organizationId` remains null with `membershipError: "not_member"`.
 */
export async function createRpcContext(
	request: Request,
	dependencies?: {
		authClient?: AuthClientLike;
		dbClient?: typeof db;
		repos?: RpcRepositories;
	},
): Promise<RpcContext> {
	const requestId =
		request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
	const authClient = dependencies?.authClient ?? auth;
	const dbClient = dependencies?.dbClient ?? db;

	const session = await authClient.api.getSession({ headers: request.headers });
	if (!session) {
		return {
			requestId,
			userId: null,
			organizationId: null,
			role: null,
			membership: null,
			user: null,
			repos: dependencies?.repos,
		};
	}

	const rawOrgHeader =
		request.headers.get(ACTIVE_ORG_HEADER) ??
		request.headers.get(ACTIVE_ORG_HEADER_ALIAS);

	const orgValidation = validateOrganizationHeader(rawOrgHeader);

	if (!orgValidation.valid) {
		const membershipError: MembershipErrorType =
			orgValidation.reason === "missing"
				? "missing_active_org"
				: "invalid_org_format";

		logger.debug("auth.active_org_unspecified", {
			requestId,
			userId: session.user.id,
			membershipError,
		});

		return {
			requestId,
			userId: session.user.id,
			organizationId: null,
			role: null,
			membership: null,
			user: session.user,
			membershipError,
			repos: dependencies?.repos,
		};
	}

	const requestedOrgId = orgValidation.orgId;

	// Validate membership in DB or repository
	let membershipRecord: RpcMembership | null = null;

	if (dependencies?.repos?.memberships) {
		const list = await dependencies.repos.memberships.listMemberships({
			organizationId: requestedOrgId,
		});
		const found = list.find((m) => m.userId === session.user.id);
		if (found) {
			membershipRecord = {
				id: found.id,
				organizationId: found.organizationId,
				userId: found.userId,
				role: found.role as MembershipRole,
			};
		}
	} else {
		const member = await dbClient.query.memberships.findFirst({
			where: and(
				eq(memberships.organizationId, requestedOrgId),
				eq(memberships.userId, session.user.id),
			),
		});
		if (member) {
			membershipRecord = {
				id: member.id,
				organizationId: member.organizationId,
				userId: member.userId,
				role: member.role as MembershipRole,
			};
		}
	}

	if (!membershipRecord) {
		logger.warn("auth.active_org_membership_denied", {
			requestId,
			userId: session.user.id,
			organizationId: requestedOrgId,
		});

		return {
			requestId,
			userId: session.user.id,
			organizationId: null,
			role: null,
			membership: null,
			user: session.user,
			membershipError: "not_member",
			repos: dependencies?.repos,
		};
	}

	return {
		requestId,
		userId: session.user.id,
		organizationId: membershipRecord.organizationId,
		role: membershipRecord.role,
		membership: membershipRecord,
		user: session.user,
		membershipError: null,
		repos: dependencies?.repos,
	};
}
