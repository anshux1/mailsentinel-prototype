import "server-only";

import { memberships } from "@mailsentinel/db";
import { ORPCError, os } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import {
	hasPermission,
	hasRole,
	type MembershipRole,
	type Permission,
} from "@/server/auth/permissions";
import { db } from "@/server/db";
import type { RpcContext, RpcMembership } from "./context";
import { toSafeORPCError } from "./errors";

const base = os.$context<RpcContext>();

/**
 * Root safe base procedure that wraps all procedure execution in safe error mapping.
 * Ensures consistent safe error responses, structured server logs, and requestId metadata.
 */
export const publicProcedure = base.use(async ({ context, next }) => {
	try {
		return await next();
	} catch (error) {
		throw toSafeORPCError(error, context.requestId);
	}
});

export type AuthedRpcContext = RpcContext & {
	userId: string;
};

/**
 * Middleware ensuring the request has an authenticated session.
 * Rejects anonymous requests with UNAUTHORIZED (401).
 */
export const authedProcedure = publicProcedure.use(({ context, next }) => {
	if (!context.userId) {
		throw new ORPCError("UNAUTHORIZED", {
			message: "Authentication required",
			data: { requestId: context.requestId, code: "UNAUTHORIZED" },
		});
	}

	return next({
		context: {
			userId: context.userId,
		},
	});
});

export type TenantRpcContext = AuthedRpcContext & {
	organizationId: string;
	role: MembershipRole;
	membership?: RpcMembership | null;
};

/**
 * Middleware ensuring an explicit active organization was supplied and validated.
 *
 * Rules:
 * - Missing organization header -> FORBIDDEN (MISSING_ACTIVE_ORGANIZATION)
 * - Non-member of organization -> FORBIDDEN
 * - Resolves active role and membership
 */
export const tenantProcedure = authedProcedure.use(
	async ({ context, next }) => {
		if (context.membershipError === "invalid_org_format") {
			throw new ORPCError("FORBIDDEN", {
				message: "Invalid organization ID header format",
				data: {
					requestId: context.requestId,
					code: "INVALID_ORGANIZATION_HEADER",
				},
			});
		}

		if (context.membershipError === "not_member") {
			throw new ORPCError("FORBIDDEN", {
				message: "User is not a member of the active organization",
				data: { requestId: context.requestId, code: "FORBIDDEN" },
			});
		}

		if (
			context.membershipError === "missing_active_org" ||
			!context.organizationId
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Active organization context required. Provide x-organization-id header.",
				data: {
					requestId: context.requestId,
					code: "MISSING_ACTIVE_ORGANIZATION",
				},
			});
		}

		let role = context.role;
		let membership = context.membership;

		if (!role) {
			const member = await db.query.memberships.findFirst({
				where: and(
					eq(memberships.organizationId, context.organizationId),
					eq(memberships.userId, context.userId),
				),
			});

			if (!member) {
				throw new ORPCError("FORBIDDEN", {
					message: "User is not a member of the active organization",
					data: { requestId: context.requestId, code: "FORBIDDEN" },
				});
			}

			role = member.role as MembershipRole;
			membership = {
				id: member.id,
				organizationId: member.organizationId,
				userId: member.userId,
				role,
			};
		}

		return next({
			context: {
				userId: context.userId,
				organizationId: context.organizationId,
				role,
				membership: membership ?? null,
			},
		});
	},
);

/**
 * Procedure builder for Viewer-level actions (read cases, results, reports).
 * Accessible to: viewer, investigator, owner.
 */
export const viewerProcedure = tenantProcedure.use(({ context, next }) => {
	if (!hasRole(context.role, "viewer")) {
		throw new ORPCError("FORBIDDEN", {
			message: "Role 'viewer' or higher is required for this action",
			data: {
				requestId: context.requestId,
				code: "FORBIDDEN",
				role: context.role,
				requiredRole: "viewer",
			},
		});
	}
	return next();
});

/**
 * Procedure builder for Investigator-level actions (create cases, upload evidence, start analysis).
 * Accessible to: investigator, owner.
 * Rejects viewers with FORBIDDEN (403).
 */
export const investigatorProcedure = tenantProcedure.use(
	({ context, next }) => {
		if (!hasRole(context.role, "investigator")) {
			throw new ORPCError("FORBIDDEN", {
				message: "Role 'investigator' or higher is required for this action",
				data: {
					requestId: context.requestId,
					code: "FORBIDDEN",
					role: context.role,
					requiredRole: "investigator",
				},
			});
		}
		return next();
	},
);

/**
 * Procedure builder for Owner-level actions (admin, retry, retention).
 * Accessible to: owner only.
 * Rejects viewers and investigators with FORBIDDEN (403).
 */
export const ownerProcedure = tenantProcedure.use(({ context, next }) => {
	if (!hasRole(context.role, "owner")) {
		throw new ORPCError("FORBIDDEN", {
			message: "Role 'owner' is required for this action",
			data: {
				requestId: context.requestId,
				code: "FORBIDDEN",
				role: context.role,
				requiredRole: "owner",
			},
		});
	}
	return next();
});

/**
 * Backwards compatibility alias for existing protected procedure references.
 */
export const protectedProcedure = viewerProcedure;

/**
 * Helper to build custom role-gated middleware for specific procedures.
 */
export function requireRole(minimumRole: MembershipRole) {
	return ({
		context,
		next,
	}: {
		context: TenantRpcContext;
		next: () => unknown;
	}) => {
		if (!hasRole(context.role, minimumRole)) {
			throw new ORPCError("FORBIDDEN", {
				message: `Role '${minimumRole}' or higher is required for this action`,
				data: {
					requestId: context.requestId,
					code: "FORBIDDEN",
					role: context.role,
					requiredRole: minimumRole,
				},
			});
		}
		return next();
	};
}

/**
 * Helper to build custom permission-gated middleware for specific procedures.
 */
export function requirePermission(permission: Permission) {
	return ({
		context,
		next,
	}: {
		context: TenantRpcContext;
		next: () => unknown;
	}) => {
		if (!hasPermission(context.role, permission)) {
			throw new ORPCError("FORBIDDEN", {
				message: `Permission '${permission}' is required for this action`,
				data: {
					requestId: context.requestId,
					code: "FORBIDDEN",
					role: context.role,
					requiredPermission: permission,
				},
			});
		}
		return next();
	};
}
