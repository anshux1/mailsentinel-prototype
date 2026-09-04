"use client";

import { Download, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useId, useState } from "react";

import { MailboxStatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useCases } from "@/features/cases/queries";
import {
	useMailboxConnections,
	useMailboxStatus,
	useStartMailboxSync,
} from "@/features/mailbox/queries";
import { usePermissions } from "@/features/organization/use-permissions";
import { safeErrorMessage } from "@/lib/errors";

/**
 * Gmail label identifiers the connector accepts. The server constrains labels
 * to `[A-Za-z0-9_-]`, which covers the system labels and user label ids but not
 * free-text display names, so this is a fixed choice rather than a text field.
 */
const LABELS = [
	{ value: "__all__", label: "All mail" },
	{ value: "INBOX", label: "Inbox" },
	{ value: "SENT", label: "Sent" },
	{ value: "SPAM", label: "Spam" },
	{ value: "IMPORTANT", label: "Important" },
	{ value: "STARRED", label: "Starred" },
	{ value: "UNREAD", label: "Unread" },
];

const DEFAULT_MAX_MESSAGES = 200;

/** `<input type="date">` yields a bare day; the server wants an RFC 3339 instant. */
function startOfDayIso(value: string): string | undefined {
	if (!value) return undefined;
	const parsed = new Date(`${value}T00:00:00Z`);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function endOfDayIso(value: string): string | undefined {
	if (!value) return undefined;
	const parsed = new Date(`${value}T23:59:59.999Z`);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Opened from two directions: from a mailbox in settings (the connection is
 * fixed, the case is chosen) and from a case (the case is fixed, the mailbox is
 * chosen). Whichever end is supplied is locked; the other becomes a picker.
 */
export function SyncMailboxDialog({
	connectionId: fixedConnectionId,
	accountEmail,
	caseId: fixedCaseId,
	trigger,
	disabled = false,
}: {
	connectionId?: string;
	accountEmail?: string;
	caseId?: string;
	trigger?: React.ReactNode;
	disabled?: boolean;
}) {
	const router = useRouter();
	const { can } = usePermissions();
	const labelId = useId();
	const caseFieldId = useId();
	const connectionFieldId = useId();
	const maxId = useId();
	const startId = useId();
	const endId = useId();

	const [open, setOpen] = useState(false);
	const [caseId, setCaseId] = useState(fixedCaseId ?? "");
	const [connectionId, setConnectionId] = useState(fixedConnectionId ?? "");
	const [label, setLabel] = useState("INBOX");
	const [maxMessages, setMaxMessages] = useState(String(DEFAULT_MAX_MESSAGES));
	const [startDate, setStartDate] = useState("");
	const [endDate, setEndDate] = useState("");
	const [rangeError, setRangeError] = useState<string | null>(null);

	// Each picker only fetches when the dialog actually has to offer it.
	const cases = useCases({ limit: 100 }, { enabled: open && !fixedCaseId });
	const caseItems =
		(cases.data as { items?: { id: string; title: string }[] } | undefined)
			?.items ?? [];

	const connections = useMailboxConnections(open && !fixedConnectionId);
	const connectableItems = (connections.data?.items ?? []).filter(
		(item) => item.status !== "disconnected",
	);

	// Whichever mailbox this run would target, watched live while the dialog sits open.
	const targetConnectionId = fixedConnectionId ?? connectionId;
	const status = useMailboxStatus(targetConnectionId, open);
	const connection = status.data ?? null;

	const sync = useStartMailboxSync((batchId) => {
		const destination = fixedCaseId ?? caseId;
		setOpen(false);
		if (destination) router.push(`/cases/${destination}/batches/${batchId}`);
	});

	const syncReset = sync.reset;
	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (!next) {
				setRangeError(null);
				syncReset();
			}
			setOpen(next);
		},
		[syncReset],
	);

	if (!can("analysis:start")) return null;

	const effectiveCaseId = fixedCaseId ?? caseId;
	const effectiveConnectionId = fixedConnectionId ?? connectionId;
	/*
	 * The server guards concurrent pulls per connection with a compare-and-set,
	 * so a mailbox already syncing would reject this run. Saying so up front
	 * beats letting the operator fill the form and collect the rejection.
	 */
	const busyElsewhere = connection?.status === "syncing" && !sync.isPending;
	const parsedMax = Number.parseInt(maxMessages, 10);
	const maxIsValid =
		Number.isInteger(parsedMax) && parsedMax >= 1 && parsedMax <= 1000;
	const canSubmit =
		Boolean(effectiveCaseId) &&
		Boolean(effectiveConnectionId) &&
		maxIsValid &&
		!busyElsewhere &&
		!sync.isPending;

	function onSubmit(event: React.FormEvent) {
		event.preventDefault();
		if (!canSubmit) return;

		if (startDate && endDate && startDate > endDate) {
			setRangeError("The start date must fall on or before the end date.");
			return;
		}
		setRangeError(null);

		sync.mutate({
			connectionId: effectiveConnectionId,
			caseId: effectiveCaseId,
			maxMessages: parsedMax,
			label: label === "__all__" ? undefined : label,
			startDate: startOfDayIso(startDate),
			endDate: endOfDayIso(endDate),
		});
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			{trigger !== undefined ? (
				<DialogTrigger asChild>{trigger}</DialogTrigger>
			) : (
				<DialogTrigger asChild>
					<Button variant="tertiary" size="sm" disabled={disabled}>
						<Download className="size-3.5" />
						Sync to case
					</Button>
				</DialogTrigger>
			)}

			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Sync messages into a case</DialogTitle>
					<DialogDescription>
						Pulls messages
						{accountEmail ? (
							<>
								{" from "}
								<span className="text-body">{accountEmail}</span>
							</>
						) : null}{" "}
						into one ingestion batch. Each message is hashed and stored as
						immutable evidence; nothing is deleted or modified in the mailbox.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={onSubmit} className="space-y-4">
					{fixedConnectionId ? null : (
						<div className="space-y-2">
							<Label htmlFor={connectionFieldId}>Mailbox</Label>
							<Select value={connectionId} onValueChange={setConnectionId}>
								<SelectTrigger id={connectionFieldId} className="w-full">
									<SelectValue
										placeholder={
											connections.isPending
												? "Loading mailboxes…"
												: "Choose a mailbox"
										}
									/>
								</SelectTrigger>
								<SelectContent>
									{connectableItems.map((item) => (
										<SelectItem key={item.id} value={item.id}>
											{item.accountEmail}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{!connections.isPending && connectableItems.length === 0 ? (
								<p className="text-[12px] text-ash tracking-[0.4px]">
									No mailbox is connected. An owner can add one from Settings.
								</p>
							) : null}
						</div>
					)}

					{fixedCaseId ? null : (
						<div className="space-y-2">
							<Label htmlFor={caseFieldId}>Destination case</Label>
							<Select value={caseId} onValueChange={setCaseId}>
								<SelectTrigger id={caseFieldId} className="w-full">
									<SelectValue
										placeholder={
											cases.isPending ? "Loading cases…" : "Choose a case"
										}
									/>
								</SelectTrigger>
								<SelectContent>
									{caseItems.map((item) => (
										<SelectItem key={item.id} value={item.id}>
											{item.title}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{!cases.isPending && caseItems.length === 0 ? (
								<p className="text-[12px] text-ash tracking-[0.4px]">
									Create a case before syncing a mailbox into it.
								</p>
							) : null}
						</div>
					)}

					<div className="space-y-2">
						<Label htmlFor={labelId}>Mailbox label</Label>
						<Select value={label} onValueChange={setLabel}>
							<SelectTrigger id={labelId} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{LABELS.map((entry) => (
									<SelectItem key={entry.value} value={entry.value}>
										{entry.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor={startId}>From date</Label>
							<Input
								id={startId}
								type="date"
								value={startDate}
								max={endDate || undefined}
								onChange={(event) => setStartDate(event.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor={endId}>To date</Label>
							<Input
								id={endId}
								type="date"
								value={endDate}
								min={startDate || undefined}
								onChange={(event) => setEndDate(event.target.value)}
							/>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor={maxId}>Maximum messages</Label>
						<Input
							id={maxId}
							type="number"
							min={1}
							max={1000}
							value={maxMessages}
							onChange={(event) => setMaxMessages(event.target.value)}
							aria-invalid={!maxIsValid}
						/>
						<p className="text-[12px] text-ash tracking-[0.4px]">
							Between 1 and 1000. The deployment may enforce a lower ceiling.
						</p>
					</div>

					{connection ? (
						<div className="flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-surface-elevated px-3 py-2.5">
							<span className="text-[13px] text-mute">Mailbox status</span>
							<MailboxStatusBadge status={connection.status} />
							{connection.lastFailureReason ? (
								<span className="w-full text-[13px] text-accent-red leading-[1.5]">
									{connection.lastFailureReason}
								</span>
							) : null}
							{busyElsewhere ? (
								<span className="w-full text-[13px] text-accent-yellow leading-[1.5]">
									A sync is already running against this mailbox. Wait for it to
									finish before starting another.
								</span>
							) : null}
						</div>
					) : null}

					{rangeError || sync.isError ? (
						<p
							role="alert"
							className="rounded-md bg-accent-red-soft px-3 py-2.5 text-[13px] text-accent-red leading-[1.5]"
						>
							{rangeError ?? safeErrorMessage(sync.error)}
						</p>
					) : null}

					{sync.isPending ? (
						<p className="rounded-md bg-surface-elevated px-3 py-2.5 text-[13px] text-mute leading-[1.5]">
							Fetching and hashing messages. Large ranges can take a while —
							keep this dialog open.
						</p>
					) : null}

					<DialogFooter>
						<Button
							type="button"
							variant="secondary"
							onClick={() => handleOpenChange(false)}
							disabled={sync.isPending}
						>
							Cancel
						</Button>
						<Button type="submit" variant="primary" disabled={!canSubmit}>
							{sync.isPending ? (
								<>
									<Loader2 className="size-4 animate-spin" />
									Syncing…
								</>
							) : (
								"Start sync"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
