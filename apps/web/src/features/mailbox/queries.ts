"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { isMailboxDisabled } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

/**
 * The OAuth handshake is a browser redirect rather than an RPC call: the start
 * route validates the owner role, mints PKCE state, and hands off to Google.
 * The callback returns to `/settings` with a result parameter.
 */
export function mailboxConnectUrl(organizationId: string): string {
	return `/api/mailbox/gmail/start?organizationId=${encodeURIComponent(organizationId)}`;
}

export function useMailboxConnections(enabled = true) {
	return useQuery({
		...orpc.mailbox.list.queryOptions({ input: {} }),
		enabled,
		/*
		 * A deployment with connectors switched off answers every mailbox call
		 * with the same forbidden code. Retrying cannot change that, and the
		 * section renders an explanation instead.
		 */
		retry: (failureCount, error) =>
			!isMailboxDisabled(error) && failureCount < 2,
		refetchInterval: (query) => {
			const items = query.state.data?.items ?? [];
			return items.some((item) => item.status === "syncing") ? 5000 : false;
		},
	});
}

/**
 * One connection's live state. A sync started elsewhere — another tab, another
 * investigator — flips the connection to `syncing`, and the server's
 * compare-and-set would reject a second concurrent pull. Watching the single
 * connection lets the sync dialog say so before the operator commits to a run.
 */
export function useMailboxStatus(connectionId: string, enabled = true) {
	return useQuery({
		...orpc.mailbox.status.queryOptions({ input: { connectionId } }),
		enabled: enabled && Boolean(connectionId),
		retry: (failureCount, error) =>
			!isMailboxDisabled(error) && failureCount < 2,
		refetchInterval: (query) =>
			query.state.data?.status === "syncing" ? 3000 : false,
	});
}

/**
 * Sync runs inside the request, so this mutation stays open for the duration of
 * the pull. It returns the batch it produced; `partial` means some messages
 * failed to ingest while the rest are usable.
 */
export function useStartMailboxSync(onSynced?: (batchId: string) => void) {
	const queryClient = useQueryClient();

	return useMutation({
		...orpc.mailbox.startSync.mutationOptions(),
		onSuccess: async (result) => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: orpc.mailbox.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.batch.key() }),
				queryClient.invalidateQueries({ queryKey: orpc.evidence.key() }),
			]);

			if (result.status === "failed") {
				toast.error("Mailbox sync failed", {
					description: result.failureReason ?? "No messages were ingested.",
				});
			} else if (result.status === "partial") {
				toast.warning("Mailbox sync partially completed", {
					description: `${result.readyCount} of ${result.messageCount} messages ingested; ${result.failedCount} failed.`,
				});
			} else {
				toast.success("Mailbox sync complete", {
					description: `${result.readyCount} ${result.readyCount === 1 ? "message" : "messages"} ingested into the case.`,
				});
			}

			onSynced?.(result.batchId);
		},
	});
}

export function useDisconnectMailbox() {
	const queryClient = useQueryClient();

	return useMutation({
		...orpc.mailbox.disconnect.mutationOptions(),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: orpc.mailbox.key() });
			toast.success("Mailbox disconnected", {
				description:
					"The stored refresh token was deleted. Evidence already ingested is unaffected.",
			});
		},
	});
}
