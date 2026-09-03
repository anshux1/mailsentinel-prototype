"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { setActiveOrganizationId } from "@/lib/active-organization";
import { authClient } from "@/lib/auth-client";

export function useSession() {
	const { data, isPending, error, refetch } = authClient.useSession();
	return {
		session: data ?? null,
		user: data?.user ?? null,
		isPending,
		error,
		refetch,
	};
}

export function useSignOut() {
	const router = useRouter();
	const queryClient = useQueryClient();

	return useCallback(async () => {
		await authClient.signOut();
		// Nothing cached is safe to keep once the session is gone.
		setActiveOrganizationId(null);
		queryClient.clear();
		router.replace("/sign-in");
		router.refresh();
	}, [queryClient, router]);
}

/** Initials for the avatar fallback, derived from name or email. */
export function initialsOf(value: string | null | undefined): string {
	if (!value) return "··";
	const cleaned = value.split("@")[0] ?? value;
	const [first, second] = cleaned.split(/[\s._-]+/).filter(Boolean);
	if (first && second) {
		return `${first[0]}${second[0]}`.toUpperCase();
	}
	return cleaned.slice(0, 2).toUpperCase();
}
