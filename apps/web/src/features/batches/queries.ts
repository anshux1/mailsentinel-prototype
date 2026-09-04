"use client";

import { useQuery } from "@tanstack/react-query";

import { isActiveBatchStatus } from "@/components/common/status-badge";
import { orpc } from "@/lib/orpc";

/**
 * An ingestion batch groups the messages that entered a case together — one
 * `.eml` upload, a segmented container, or a mailbox sync. Segmentation runs
 * behind the upload call, so a batch can still be counting children when the
 * list first renders; those states poll until they settle.
 */
export function useBatches(
	caseId: string,
	options: { limit?: number; enabled?: boolean } = {},
) {
	const { limit = 50, enabled = true } = options;

	return useQuery({
		...orpc.batch.list.queryOptions({ input: { caseId, limit } }),
		enabled: enabled && Boolean(caseId),
		refetchInterval: (query) => {
			const items = query.state.data?.items ?? [];
			return items.some((batch) => isActiveBatchStatus(batch.status))
				? 4000
				: false;
		},
	});
}

export function useBatch(
	batchId: string,
	options: { caseId?: string; enabled?: boolean } = {},
) {
	const { caseId, enabled = true } = options;

	return useQuery({
		...orpc.batch.get.queryOptions({ input: { batchId, caseId } }),
		enabled: enabled && Boolean(batchId),
		refetchInterval: (query) =>
			query.state.data && isActiveBatchStatus(query.state.data.status)
				? 3000
				: false,
	});
}

/**
 * The children of a batch. Unlike `evidence.list`, this endpoint attaches the
 * per-message summary (from / subject / date) the analyzer extracted, which is
 * the only way to tell hundreds of segmented messages apart.
 */
export function useBatchEvidence(
	batchId: string,
	options: { caseId?: string; limit?: number; enabled?: boolean } = {},
) {
	const { caseId, limit = 50, enabled = true } = options;

	return useQuery({
		...orpc.evidence.listByBatch.queryOptions({
			input: { batchId, caseId, limit },
		}),
		enabled: enabled && Boolean(batchId),
	});
}
