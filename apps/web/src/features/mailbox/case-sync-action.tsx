"use client";

import { Inbox } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useMailboxConnections } from "@/features/mailbox/queries";
import { SyncMailboxDialog } from "@/features/mailbox/sync-mailbox-dialog";
import { usePermissions } from "@/features/organization/use-permissions";

/**
 * The case-side entry point into a mailbox sync. It stays out of the way
 * entirely when the deployment has no usable connector — a case with no
 * mailbox available should not advertise the action, and settings is where a
 * missing or broken connection gets explained.
 */
export function CaseMailboxSyncAction({ caseId }: { caseId: string }) {
	const { can } = usePermissions();
	const allowed = can("analysis:start");
	const connections = useMailboxConnections(allowed);

	if (!allowed || connections.isPending || connections.isError) return null;

	const items = (connections.data?.items ?? []).filter(
		(item) => item.status !== "disconnected",
	);
	if (items.length === 0) return null;

	// With a single mailbox there is nothing to choose, so skip the picker.
	const only = items.length === 1 ? items[0] : undefined;

	return (
		<SyncMailboxDialog
			caseId={caseId}
			connectionId={only?.id}
			accountEmail={only?.accountEmail}
			trigger={
				<Button variant="tertiary">
					<Inbox className="size-4" />
					Sync from mailbox
				</Button>
			}
		/>
	);
}
