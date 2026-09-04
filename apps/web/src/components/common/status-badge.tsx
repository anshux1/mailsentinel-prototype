import {
	CheckCircle2,
	CircleDashed,
	CircleSlash,
	Clock,
	Loader2,
	PlugZap,
	ShieldAlert,
	ShieldCheck,
	ShieldQuestion,
	ShieldX,
	Unplug,
	Upload,
	XCircle,
} from "lucide-react";
import type { ComponentProps } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

export type AnalysisRunStatus =
	| "accepted"
	| "queued"
	| "processing"
	| "completed"
	| "deferred"
	| "failed";

export type EvidenceStatus = "pending" | "stored" | "verified" | "failed";

export type Verdict = "unknown" | "benign" | "suspicious" | "malicious";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type ReportStatus = "pending" | "generating" | "completed" | "failed";

export type BatchStatus =
	| "pending"
	| "segmenting"
	| "ready"
	| "partial"
	| "failed";

export type MailboxStatus = "connected" | "disconnected" | "syncing" | "error";

const RUN_STATUS: Record<
	AnalysisRunStatus,
	{ label: string; variant: BadgeVariant; icon: typeof Clock; spin?: boolean }
> = {
	accepted: { label: "Accepted", variant: "default", icon: CircleDashed },
	queued: { label: "Queued", variant: "info", icon: Clock },
	processing: {
		label: "Processing",
		variant: "info",
		icon: Loader2,
		spin: true,
	},
	completed: { label: "Completed", variant: "success", icon: CheckCircle2 },
	deferred: { label: "Deferred", variant: "warning", icon: CircleSlash },
	failed: { label: "Failed", variant: "danger", icon: XCircle },
};

const EVIDENCE_STATUS: Record<
	EvidenceStatus,
	{ label: string; variant: BadgeVariant; icon: typeof Clock }
> = {
	pending: { label: "Pending", variant: "default", icon: CircleDashed },
	stored: { label: "Stored", variant: "info", icon: Upload },
	verified: { label: "Verified", variant: "success", icon: CheckCircle2 },
	failed: { label: "Failed", variant: "danger", icon: XCircle },
};

const VERDICT: Record<
	Verdict,
	{ label: string; variant: BadgeVariant; icon: typeof ShieldCheck }
> = {
	unknown: { label: "Unknown", variant: "default", icon: ShieldQuestion },
	benign: { label: "Benign", variant: "success", icon: ShieldCheck },
	suspicious: { label: "Suspicious", variant: "warning", icon: ShieldAlert },
	malicious: { label: "Malicious", variant: "danger", icon: ShieldX },
};

const SEVERITY: Record<Severity, { label: string; variant: BadgeVariant }> = {
	info: { label: "Info", variant: "info" },
	low: { label: "Low", variant: "default" },
	medium: { label: "Medium", variant: "warning" },
	high: { label: "High", variant: "danger" },
	critical: { label: "Critical", variant: "danger" },
};

const REPORT_STATUS: Record<
	ReportStatus,
	{ label: string; variant: BadgeVariant; icon: typeof Clock; spin?: boolean }
> = {
	pending: { label: "Pending", variant: "default", icon: CircleDashed },
	generating: {
		label: "Generating",
		variant: "info",
		icon: Loader2,
		spin: true,
	},
	completed: { label: "Completed", variant: "success", icon: CheckCircle2 },
	failed: { label: "Failed", variant: "danger", icon: XCircle },
};

/**
 * A batch is `partial` when some children were ingested and others failed. That
 * is a warning rather than a failure: the operator still has usable evidence.
 */
const BATCH_STATUS: Record<
	BatchStatus,
	{ label: string; variant: BadgeVariant; icon: typeof Clock; spin?: boolean }
> = {
	pending: { label: "Pending", variant: "default", icon: CircleDashed },
	segmenting: {
		label: "Segmenting",
		variant: "info",
		icon: Loader2,
		spin: true,
	},
	ready: { label: "Ready", variant: "success", icon: CheckCircle2 },
	partial: { label: "Partial", variant: "warning", icon: ShieldAlert },
	failed: { label: "Failed", variant: "danger", icon: XCircle },
};

const MAILBOX_STATUS: Record<
	MailboxStatus,
	{ label: string; variant: BadgeVariant; icon: typeof Clock; spin?: boolean }
> = {
	connected: { label: "Connected", variant: "success", icon: PlugZap },
	syncing: { label: "Syncing", variant: "info", icon: Loader2, spin: true },
	disconnected: { label: "Disconnected", variant: "default", icon: Unplug },
	error: { label: "Error", variant: "danger", icon: XCircle },
};

export function RunStatusBadge({
	status,
	className,
}: {
	status: string;
	className?: string;
}) {
	const spec = RUN_STATUS[status as AnalysisRunStatus] ?? RUN_STATUS.accepted;
	const Icon = spec.icon;
	return (
		<Badge variant={spec.variant} className={className}>
			<Icon className={cn("size-3", spec.spin && "animate-spin")} />
			{spec.label}
		</Badge>
	);
}

export function EvidenceStatusBadge({
	status,
	className,
}: {
	status: string;
	className?: string;
}) {
	const spec =
		EVIDENCE_STATUS[status as EvidenceStatus] ?? EVIDENCE_STATUS.pending;
	const Icon = spec.icon;
	return (
		<Badge variant={spec.variant} className={className}>
			<Icon className="size-3" />
			{spec.label}
		</Badge>
	);
}

export function VerdictBadge({
	verdict,
	className,
	withIcon = true,
}: {
	verdict: string | null | undefined;
	className?: string;
	withIcon?: boolean;
}) {
	const spec = VERDICT[(verdict ?? "unknown") as Verdict] ?? VERDICT.unknown;
	const Icon = spec.icon;
	return (
		<Badge variant={spec.variant} className={className}>
			{withIcon ? <Icon className="size-3" /> : null}
			{spec.label}
		</Badge>
	);
}

export function SeverityBadge({
	severity,
	className,
}: {
	severity: string;
	className?: string;
}) {
	const spec = SEVERITY[severity as Severity] ?? SEVERITY.low;
	return (
		<Badge variant={spec.variant} className={cn("uppercase", className)}>
			{spec.label}
		</Badge>
	);
}

export function ReportStatusBadge({
	status,
	className,
}: {
	status: string;
	className?: string;
}) {
	const spec = REPORT_STATUS[status as ReportStatus] ?? REPORT_STATUS.pending;
	const Icon = spec.icon;
	return (
		<Badge variant={spec.variant} className={className}>
			<Icon className={cn("size-3", spec.spin && "animate-spin")} />
			{spec.label}
		</Badge>
	);
}

export function BatchStatusBadge({
	status,
	className,
}: {
	status: string;
	className?: string;
}) {
	const spec = BATCH_STATUS[status as BatchStatus] ?? BATCH_STATUS.pending;
	const Icon = spec.icon;
	return (
		<Badge variant={spec.variant} className={className}>
			<Icon className={cn("size-3", spec.spin && "animate-spin")} />
			{spec.label}
		</Badge>
	);
}

export function MailboxStatusBadge({
	status,
	className,
}: {
	status: string;
	className?: string;
}) {
	const spec =
		MAILBOX_STATUS[status as MailboxStatus] ?? MAILBOX_STATUS.disconnected;
	const Icon = spec.icon;
	return (
		<Badge variant={spec.variant} className={className}>
			<Icon className={cn("size-3", spec.spin && "animate-spin")} />
			{spec.label}
		</Badge>
	);
}

export const ACTIVE_BATCH_STATUSES: BatchStatus[] = ["pending", "segmenting"];

export function isActiveBatchStatus(status: string): boolean {
	return ACTIVE_BATCH_STATUSES.includes(status as BatchStatus);
}

export const ACTIVE_RUN_STATUSES: AnalysisRunStatus[] = [
	"accepted",
	"queued",
	"processing",
];

export function isActiveRunStatus(status: string): boolean {
	return ACTIVE_RUN_STATUSES.includes(status as AnalysisRunStatus);
}
