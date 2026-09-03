import "server-only";

/**
 * Server-side entry point for the role model. The model itself lives in
 * `@/lib/permissions` so the browser can read the same table to decide which
 * actions to offer — enforcement still happens here, behind oRPC middleware.
 */
export {
	hasPermission,
	hasRole,
	type MembershipRole,
	type Permission,
	ROLE_HIERARCHY,
	ROLE_PERMISSIONS,
} from "@/lib/permissions";
