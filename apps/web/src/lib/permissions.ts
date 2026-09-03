/**
 * The role model, shared by the server (which enforces it) and the browser
 * (which uses it to avoid offering actions that would be rejected). Pure data
 * and pure functions only — safe on both sides of the boundary.
 */

export type MembershipRole = "owner" | "investigator" | "viewer";

export type Permission =
	| "cases:read"
	| "cases:create"
	| "evidence:read"
	| "evidence:upload"
	| "analysis:read"
	| "analysis:start"
	| "analysis:retry"
	| "reports:read"
	| "reports:generate"
	| "retention:manage"
	| "admin:manage";

export const ROLE_HIERARCHY: Record<MembershipRole, number> = {
	viewer: 1,
	investigator: 2,
	owner: 3,
};

export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
	viewer: ["cases:read", "evidence:read", "analysis:read", "reports:read"],
	investigator: [
		"cases:read",
		"evidence:read",
		"analysis:read",
		"reports:read",
		"cases:create",
		"evidence:upload",
		"analysis:start",
		"reports:generate",
	],
	owner: [
		"cases:read",
		"evidence:read",
		"analysis:read",
		"reports:read",
		"cases:create",
		"evidence:upload",
		"analysis:start",
		"reports:generate",
		"analysis:retry",
		"retention:manage",
		"admin:manage",
	],
};

export function hasPermission(
	role: MembershipRole | null | undefined,
	permission: Permission,
): boolean {
	if (!role) return false;
	const permissions = ROLE_PERMISSIONS[role];
	return permissions ? permissions.includes(permission) : false;
}

export function hasRole(
	currentRole: MembershipRole | null | undefined,
	minimumRole: MembershipRole,
): boolean {
	if (!currentRole) return false;
	const currentLevel = ROLE_HIERARCHY[currentRole] ?? 0;
	const requiredLevel = ROLE_HIERARCHY[minimumRole] ?? 0;
	return currentLevel >= requiredLevel;
}
