"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { orpc, orpcClient } from "@/lib/orpc";

export type EvidenceStatusFilter =
	| "pending"
	| "stored"
	| "verified"
	| "failed"
	| undefined;

export function useEvidenceList(
	caseId: string,
	options: {
		status?: EvidenceStatusFilter;
		limit?: number;
		enabled?: boolean;
	} = {},
) {
	const { status, limit = 50, enabled = true } = options;
	return useQuery({
		...orpc.evidence.list.queryOptions({
			input: { caseId, status, limit },
		}),
		enabled: enabled && Boolean(caseId),
	});
}

export function useEvidence(
	caseId: string,
	evidenceId: string,
	enabled = true,
) {
	return useQuery({
		...orpc.evidence.get.queryOptions({ input: { caseId, evidenceId } }),
		enabled: enabled && Boolean(caseId) && Boolean(evidenceId),
	});
}

/**
 * Two-step upload: register the digest and size first, then send the bounded
 * base64 body. The server refuses a body whose digest does not match the
 * registration, so both steps are driven from the same locally-computed hash.
 */
export function useUploadEvidence(caseId: string) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationKey: ["evidence", "upload", caseId],
		meta: { silent: true },
		mutationFn: async (input: {
			file: File;
			sha256: string;
			base64: string;
			idempotencyKey: string;
		}) => {
			const pending = await orpcClient.evidence.createUpload({
				caseId,
				filename: input.file.name,
				contentType: "message/rfc822",
				byteSize: input.file.size,
				sha256: input.sha256,
				idempotencyKey: input.idempotencyKey,
			});

			return orpcClient.evidence.completeUpload({
				caseId,
				evidenceId: pending.id,
				body: input.base64,
				sha256: input.sha256,
			});
		},
		onSuccess: () => {
			toast.success("Evidence verified", {
				description: "The upload is stored privately and ready to analyze.",
			});
		},
		/*
		 * Refresh on failure too: `createUpload` may have registered the record
		 * before the storage write failed, and the operator needs to see that
		 * failed row rather than an empty list. Every upload also produces an
		 * ingestion batch — one message for a single `.eml`, many for a
		 * container — so that list is stale as well.
		 */
		onSettled: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: orpc.evidence.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.batch.key() }),
			]);
		},
	});
}
