"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
	getActiveOrganizationId,
	setActiveOrganizationId,
	subscribeToActiveOrganization,
} from "@/lib/active-organization";
import { orpc } from "@/lib/orpc";
import type { MembershipRole } from "@/lib/permissions";
import type { MembershipOutput } from "@/server/orpc/organization";

export type Organization = MembershipOutput;

function useActiveOrganizationId(): string | null {
	return useSyncExternalStore(
		subscribeToActiveOrganization,
		getActiveOrganizationId,
		() => null,
	);
}

/**
 * Resolves the tenant context the whole workspace runs in. The server refuses
 * every tenant call until `x-organization-id` is set, so this hook owns
 * choosing (and persisting) that value.
 */
export function useOrganizations({
	enabled = true,
}: {
	enabled?: boolean;
} = {}) {
	const queryClient = useQueryClient();
	const activeId = useActiveOrganizationId();

	const query = useQuery({
		...orpc.organization.list.queryOptions(),
		enabled,
		staleTime: 5 * 60_000,
	});

	const queryData = query.data;
	const organizations = useMemo(() => queryData?.items ?? [], [queryData]);
	const active =
		organizations.find((item) => item.organizationId === activeId) ?? null;

	// Adopt the first membership when nothing valid is selected yet.
	useEffect(() => {
		const first = organizations[0];
		if (!first || active) return;
		setActiveOrganizationId(first.organizationId);
	}, [organizations, active]);

	const setActive = useCallback(
		(organizationId: string) => {
			if (organizationId === getActiveOrganizationId()) return;
			setActiveOrganizationId(organizationId);
			// Every cached page is tenant-scoped, so none of it survives a switch.
			queryClient.removeQueries({ predicate: isTenantQuery });
		},
		[queryClient],
	);

	return {
		organizations,
		activeOrganization: active,
		activeOrganizationId: active?.organizationId ?? null,
		role: (active?.role ?? null) as MembershipRole | null,
		setActive,
		isLoading: query.isPending && enabled,
		isError: query.isError,
		error: query.error,
		refetch: query.refetch,
		hasNoMembership: query.isSuccess && organizations.length === 0,
	};
}

function isTenantQuery(query: { queryKey: readonly unknown[] }): boolean {
	const path = query.queryKey[0];
	if (!Array.isArray(path)) return false;
	const root = path[0];
	return (
		root === "case" ||
		root === "evidence" ||
		root === "analysis" ||
		root === "report"
	);
}
