"use client";

import { useMemo } from "react";

import { useOrganizations } from "@/features/organization/use-organizations";
import { hasPermission, type Permission } from "@/lib/permissions";

/**
 * Mirrors the server's role model so the UI can hide actions the caller cannot
 * perform. The server remains the enforcement point — this only avoids
 * offering a button that would be rejected.
 */
export function usePermissions() {
	const { role } = useOrganizations();

	return useMemo(
		() => ({
			role,
			can: (permission: Permission) => hasPermission(role, permission),
			isViewer: role === "viewer",
			isOwner: role === "owner",
		}),
		[role],
	);
}
