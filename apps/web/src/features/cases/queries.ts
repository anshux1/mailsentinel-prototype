"use client";

import {
	type UseQueryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { orpc } from "@/lib/orpc";

export type CaseListInput = { limit?: number; cursor?: string };

export function useCases(
	input: CaseListInput = {},
	options?: Partial<UseQueryOptions>,
) {
	return useQuery({
		...orpc.case.list.queryOptions({ input }),
		...(options as object),
	});
}

export function useCase(caseId: string, enabled = true) {
	return useQuery({
		...orpc.case.get.queryOptions({ input: { caseId } }),
		enabled: enabled && Boolean(caseId),
	});
}

/**
 * Creating a case invalidates every case list page. The new record is not
 * written into the cache optimistically because the server owns its id and
 * timestamps.
 */
export function useCreateCase(onCreated?: (caseId: string) => void) {
	const queryClient = useQueryClient();

	return useMutation({
		...orpc.case.create.mutationOptions(),
		onSuccess: async (created) => {
			await queryClient.invalidateQueries({ queryKey: orpc.case.key() });
			toast.success("Case created", { description: created.title });
			onCreated?.(created.id);
		},
	});
}
