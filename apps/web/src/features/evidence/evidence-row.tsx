"use client";

import { FileWarning, Loader2, Mail, Play } from "lucide-react";
import { motion } from "motion/react";

import { EvidenceStatusBadge } from "@/components/common/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatBytes, formatRelativeTime, truncateDigest } from "@/lib/format";
import type { EvidenceOutput } from "@/server/orpc/evidence";

/**
 * One evidence artifact. Container segmentation and mailbox sync can put
 * hundreds of messages in a case, so the analyzer-extracted summary leads when
 * it exists and the digest falls back to being the identifier — a wall of
 * hashes is unreadable at that scale.
 *
 * The summary is header-derived text from a hostile source: it is rendered as
 * plain text only, never as markup, and never used to build a link.
 */
export function EvidenceRow({
	item,
	onAnalyze,
	isAnalyzing = false,
	canAnalyze = false,
}: {
	item: EvidenceOutput;
	onAnalyze?: (evidenceId: string) => void;
	isAnalyzing?: boolean;
	canAnalyze?: boolean;
}) {
	const summary = item.summary ?? null;
	const sender = summary?.fromDisplayName || summary?.from || null;
	const subject = summary?.subject || null;
	const hasSummary = Boolean(sender || subject);

	return (
		<motion.div
			whileHover={{ y: -1 }}
			transition={{ duration: 0.15 }}
			className="flex flex-col gap-4 rounded-lg border border-hairline bg-surface p-4 transition-colors duration-200 hover:border-hairline-strong sm:flex-row sm:items-center"
		>
			<span className="grid size-10 shrink-0 place-items-center rounded-md border border-hairline bg-surface-card">
				{item.status === "failed" ? (
					<FileWarning className="size-4 text-accent-red" />
				) : (
					<Mail className="size-4 text-body" />
				)}
			</span>

			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					{typeof item.sequence === "number" ? (
						<Badge variant="outline" className="font-mono">
							#{item.sequence + 1}
						</Badge>
					) : null}

					{hasSummary ? (
						<span className="min-w-0 truncate font-medium text-[14px] text-ink tracking-[0.2px]">
							{subject ?? "(no subject)"}
						</span>
					) : (
						<Tooltip>
							<TooltipTrigger asChild>
								<code className="font-mono text-[13px] text-ink">
									{truncateDigest(item.sha256)}
								</code>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs break-all font-mono text-[12px]">
								{item.sha256}
							</TooltipContent>
						</Tooltip>
					)}

					<EvidenceStatusBadge status={item.status} />
				</div>

				{hasSummary ? (
					<p className="mt-1 truncate text-[13px] text-body">
						{sender ?? "Unknown sender"}
						{summary?.date ? (
							<span className="text-mute"> · {summary.date}</span>
						) : null}
					</p>
				) : null}

				<p className="mt-1 text-[13px] text-mute">
					{hasSummary ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<code className="font-mono text-[12px]">
									{truncateDigest(item.sha256)}
								</code>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs break-all font-mono text-[12px]">
								{item.sha256}
							</TooltipContent>
						</Tooltip>
					) : null}
					{hasSummary ? " · " : null}
					{formatBytes(item.byteSize)} · {formatRelativeTime(item.createdAt)}
				</p>

				{item.status === "failed" && item.failureReason ? (
					<p className="mt-1.5 text-[13px] text-accent-red leading-[1.5]">
						{item.failureReason}
					</p>
				) : null}
			</div>

			{canAnalyze ? (
				<Button
					variant="outline"
					size="sm"
					className="shrink-0"
					disabled={isAnalyzing}
					onClick={() => onAnalyze?.(item.id)}
				>
					{isAnalyzing ? (
						<>
							<Loader2 className="size-3.5 animate-spin" />
							Dispatching…
						</>
					) : (
						<>
							<Play className="size-3.5" />
							Run analysis
						</>
					)}
				</Button>
			) : null}
		</motion.div>
	);
}
