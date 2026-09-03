"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { isActiveRunStatus } from "@/components/common/status-badge";
import { orpc } from "@/lib/orpc";

export type AnalysisListFilters = {
	caseId?: string;
	evidenceId?: string;
	status?:
		| "accepted"
		| "queued"
		| "processing"
		| "completed"
		| "deferred"
		| "failed";
	verdict?: "unknown" | "benign" | "suspicious" | "malicious";
	limit?: number;
};

/**
 * List refreshes on an interval only while something is still running — see
 * `apps/web/src/server/orpc/POLLING.md`.
 */
export function useAnalysisRuns(
	filters: AnalysisListFilters = {},
	enabled = true,
) {
	return useQuery({
		...orpc.analysis.list.queryOptions({
			input: { limit: 50, ...filters },
		}),
		enabled,
		refetchInterval: (query) => {
			const items = query.state.data?.items ?? [];
			return items.some((run) => isActiveRunStatus(run.status)) ? 4000 : false;
		},
	});
}

export function useAnalysisStatus(analysisRunId: string, enabled = true) {
	return useQuery({
		...orpc.analysis.getStatus.queryOptions({ input: { analysisRunId } }),
		enabled: enabled && Boolean(analysisRunId),
		refetchInterval: (query) =>
			query.state.data && isActiveRunStatus(query.state.data.status)
				? 3000
				: false,
	});
}

/**
 * The result endpoint is a discriminated union — `ready: false` until the run
 * completes — so the same query serves the pending and completed views.
 */
export function useAnalysisResult(analysisRunId: string, enabled = true) {
	return useQuery({
		...orpc.analysis.getResult.queryOptions({ input: { analysisRunId } }),
		enabled: enabled && Boolean(analysisRunId),
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data || data.ready) return false;
			return isActiveRunStatus(data.status) ? 3000 : false;
		},
	});
}

export function useStartAnalysis(onStarted?: (analysisRunId: string) => void) {
	const queryClient = useQueryClient();

	return useMutation({
		...orpc.analysis.start.mutationOptions(),
		onSuccess: async (run) => {
			await queryClient.invalidateQueries({ queryKey: orpc.analysis.key() });
			toast.success("Analysis dispatched", {
				description: "Status updates will stream into this page.",
			});
			onStarted?.(run.id);
		},
	});
}

export function useRetryAnalysis() {
	const queryClient = useQueryClient();

	return useMutation({
		...orpc.analysis.retry.mutationOptions(),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: orpc.analysis.key() });
			toast.success("Analysis retried", {
				description: "The run was redispatched to the analyzer.",
			});
		},
	});
}
