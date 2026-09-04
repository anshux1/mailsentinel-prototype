"use client";

import { Inbox, Loader2, Plug, PlugZap, Unplug } from "lucide-react";

import { Stagger, StaggerItem } from "@/components/common/motion";
import { EmptyState, ErrorState } from "@/components/common/states";
import { MailboxStatusBadge } from "@/components/common/status-badge";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	mailboxConnectUrl,
	useDisconnectMailbox,
	useMailboxConnections,
} from "@/features/mailbox/queries";
import { SyncMailboxDialog } from "@/features/mailbox/sync-mailbox-dialog";
import { useOrganizations } from "@/features/organization/use-organizations";
import { usePermissions } from "@/features/organization/use-permissions";
import { isMailboxDisabled } from "@/lib/errors";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

export function MailboxConnections() {
	const { can } = usePermissions();
	const { activeOrganization } = useOrganizations();
	const connections = useMailboxConnections();
	const disconnect = useDisconnectMailbox();

	const canManage = can("mailbox:manage");
	const organizationId = activeOrganization?.organizationId;

	if (connections.isPending) {
		return (
			<div className="space-y-3" aria-busy>
				<Skeleton className="h-[74px] rounded-lg" />
			</div>
		);
	}

	/*
	 * Connectors switched off at the deployment level is a configuration fact,
	 * not a failure: there is nothing to retry and nothing the operator can fix
	 * from here, so it reads as explanation rather than as an error.
	 */
	if (isMailboxDisabled(connections.error)) {
		return (
			<EmptyState
				icon={PlugZap}
				title="Mailbox connectors are turned off"
				description="This deployment runs with MAILBOX_CONNECTORS_ENABLED=false. Evidence can still be uploaded directly to a case."
			/>
		);
	}

	if (connections.isError) {
		return (
			<ErrorState
				error={connections.error}
				onRetry={() => void connections.refetch()}
				title="Could not load mailbox connections"
			/>
		);
	}

	const items = connections.data?.items ?? [];

	const connectButton =
		canManage && organizationId ? (
			<Button variant="primary" size="sm" asChild>
				<a href={mailboxConnectUrl(organizationId)}>
					<Plug className="size-3.5" />
					Connect Gmail
				</a>
			</Button>
		) : null;

	if (items.length === 0) {
		return (
			<EmptyState
				icon={Inbox}
				title="No mailbox connected"
				description={
					canManage
						? "Connect a Gmail account to pull messages straight into a case. Access is read-only and the refresh token is stored encrypted."
						: "No mailbox is connected. An organization owner can add one."
				}
				action={connectButton}
			/>
		);
	}

	return (
		<div className="space-y-4">
			<Stagger className="space-y-3">
				{items.map((connection) => (
					<StaggerItem key={connection.id}>
						<div className="flex flex-col gap-4 rounded-lg border border-hairline bg-surface p-4 sm:flex-row sm:items-center">
							<span className="grid size-10 shrink-0 place-items-center rounded-md border border-hairline bg-surface-card">
								<Inbox className="size-4 text-body" />
							</span>

							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="truncate font-medium text-[14px] text-ink tracking-[0.2px]">
										{connection.accountEmail}
									</span>
									<MailboxStatusBadge status={connection.status} />
									<Badge variant="outline" className="capitalize">
										{connection.provider}
									</Badge>
								</div>
								<p className="mt-1 text-[13px] text-mute">
									{connection.lastSyncedAt
										? `Last synced ${formatRelativeTime(connection.lastSyncedAt)}`
										: "Never synced"}
									{" · Connected "}
									{formatDateTime(connection.createdAt)}
								</p>
								{connection.lastFailureReason ? (
									<p className="mt-1.5 text-[13px] text-accent-red leading-[1.5]">
										{connection.lastFailureReason}
									</p>
								) : null}
							</div>

							<div className="flex shrink-0 flex-wrap items-center gap-2">
								<SyncMailboxDialog
									connectionId={connection.id}
									accountEmail={connection.accountEmail}
									disabled={connection.status === "syncing"}
								/>

								{canManage ? (
									<AlertDialog>
										<AlertDialogTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												disabled={disconnect.isPending}
											>
												{disconnect.isPending ? (
													<Loader2 className="size-3.5 animate-spin" />
												) : (
													<Unplug className="size-3.5" />
												)}
												Disconnect
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													Disconnect {connection.accountEmail}?
												</AlertDialogTitle>
												<AlertDialogDescription>
													The encrypted refresh token is deleted and future
													syncs stop. Evidence and reports already ingested from
													this mailbox are unaffected. Reconnecting requires the
													Google consent screen again.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>Cancel</AlertDialogCancel>
												<AlertDialogAction
													onClick={() =>
														disconnect.mutate({ connectionId: connection.id })
													}
												>
													Disconnect
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								) : null}
							</div>
						</div>
					</StaggerItem>
				))}
			</Stagger>

			{connectButton ? <div>{connectButton}</div> : null}
		</div>
	);
}
