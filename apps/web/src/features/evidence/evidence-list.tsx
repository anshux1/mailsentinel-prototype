"use client";

import { FileWarning, Loader2, Mail, Play } from "lucide-react";
import { motion } from "motion/react";

import { Stagger, StaggerItem } from "@/components/common/motion";
import {
	EmptyState,
	ErrorState,
	ListSkeleton,
} from "@/components/common/states";
import { EvidenceStatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEvidenceList } from "@/features/evidence/queries";
import { UploadEvidenceDialog } from "@/features/evidence/upload-evidence-dialog";
import { usePermissions } from "@/features/organization/use-permissions";
import { formatBytes, formatRelativeTime, truncateDigest } from "@/lib/format";

export function EvidenceList({
	caseId,
	onAnalyze,
	analyzingEvidenceId,
}: {
	caseId: string;
	onAnalyze?: (evidenceId: string) => void;
	analyzingEvidenceId?: string | null;
}) {
	const { can } = usePermissions();
	const evidence = useEvidenceList(caseId);

	if (evidence.isPending) return <ListSkeleton rows={3} />;

	if (evidence.isError) {
		return (
			<ErrorState
				error={evidence.error}
				onRetry={() => void evidence.refetch()}
				title="Could not load evidence"
			/>
		);
	}

	const items = evidence.data?.items ?? [];

	if (items.length === 0) {
		return (
			<EmptyState
				icon={Mail}
				title="No evidence yet"
				description="Upload the raw .eml message you want to investigate. It is hashed in your browser before anything is sent."
				action={<UploadEvidenceDialog caseId={caseId} />}
			/>
		);
	}

	return (
		<Stagger className="space-y-3">
			{items.map((item) => {
				const isAnalyzing = analyzingEvidenceId === item.id;
				const canAnalyze = item.status === "verified" && can("analysis:start");

				return (
					<StaggerItem key={item.id}>
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
									<EvidenceStatusBadge status={item.status} />
								</div>
								<p className="mt-1 text-[13px] text-mute">
									{formatBytes(item.byteSize)} · {item.contentType} ·{" "}
									{formatRelativeTime(item.createdAt)}
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
					</StaggerItem>
				);
			})}
		</Stagger>
	);
}
