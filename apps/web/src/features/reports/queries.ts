"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { orpc } from "@/lib/orpc";

export type ReportFormat = "json" | "html" | "text";

export type ReportListFilters = {
	caseId?: string;
	analysisRunId?: string;
	format?: "json" | "html" | "pdf" | "markdown" | "text";
	status?: "pending" | "generating" | "completed" | "failed";
	limit?: number;
};

export function useReports(filters: ReportListFilters = {}, enabled = true) {
	return useQuery({
		...orpc.report.list.queryOptions({ input: { limit: 50, ...filters } }),
		enabled,
	});
}

export function useReport(reportId: string, enabled = true) {
	return useQuery({
		...orpc.report.get.queryOptions({ input: { reportId } }),
		enabled: enabled && Boolean(reportId),
		// Report objects are immutable once completed.
		staleTime: 10 * 60_000,
	});
}

/**
 * Every generation mints a new immutable version, so the list is always
 * invalidated rather than patched.
 */
export function useGenerateReport(onGenerated?: (reportId: string) => void) {
	const queryClient = useQueryClient();

	return useMutation({
		...orpc.report.generate.mutationOptions(),
		onSuccess: async (report) => {
			await queryClient.invalidateQueries({ queryKey: orpc.report.key() });
			toast.success(`Report v${report.version} generated`, {
				description: `Immutable ${report.format.toUpperCase()} report stored privately.`,
			});
			onGenerated?.(report.id);
		},
	});
}
