"use client";

import { Archive, Inbox, Layers, Mail } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";

import { Stagger, StaggerItem } from "@/components/common/motion";
import {
	EmptyState,
	ErrorState,
	ListSkeleton,
} from "@/components/common/states";
import { BatchStatusBadge } from "@/components/common/status-badge";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useBatches } from "@/features/batches/queries";
import { formatRelativeTime, pluralize } from "@/lib/format";

type BatchSource = "upload_single" | "upload_container" | "mailbox_sync";

const SOURCE: Record<BatchSource, { label: string; icon: typeof Mail }> = {
	upload_single: { label: "Single upload", icon: Mail },
	upload_container: { label: "Container upload", icon: Archive },
	mailbox_sync: { label: "Mailbox sync", icon: Inbox },
};

const CONTAINER_FORMAT_LABELS: Record<string, string> = {
	mbox: "mbox",
	bare_concatenation: "concatenated",
	"multipart/digest": "multipart/digest",
	single: "single message",
};

export function BatchList({ caseId }: { caseId: string }) {
	const batches = useBatches(caseId);

	if (batches.isPending) return <ListSkeleton rows={3} />;

	if (batches.isError) {
		return (
			<ErrorState
				error={batches.error}
				onRetry={() => void batches.refetch()}
				title="Could not load ingestion batches"
			/>
		);
	}

	const items = batches.data?.items ?? [];

	if (items.length === 0) {
		return (
			<EmptyState
				icon={Layers}
				title="No ingestion batches yet"
				description="Every upload and mailbox sync is recorded as a batch, so you can trace which messages entered this case together."
			/>
		);
	}

	return (
		<Stagger className="space-y-3">
			{items.map((batch) => {
				const spec =
					SOURCE[batch.source as BatchSource] ?? SOURCE.upload_single;
				const Icon = spec.icon;
				const format = batch.metadata.containerFormat;
				const percent =
					batch.messageCount > 0
						? Math.round((batch.readyCount / batch.messageCount) * 100)
						: 0;
				// A single-message batch has no interesting breakdown to show.
				const showProgress = batch.messageCount > 1;

				return (
					<StaggerItem key={batch.id}>
						<motion.div whileHover={{ y: -1 }} transition={{ duration: 0.15 }}>
							<Link
								href={`/cases/${caseId}/batches/${batch.id}`}
								className="block rounded-lg border border-hairline bg-surface p-4 transition-colors duration-200 hover:border-hairline-strong"
							>
								<div className="flex flex-col gap-4 sm:flex-row sm:items-center">
									<span className="grid size-10 shrink-0 place-items-center rounded-md border border-hairline bg-surface-card">
										<Icon className="size-4 text-body" />
									</span>

									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium text-[14px] text-ink tracking-[0.2px]">
												{spec.label}
											</span>
											<BatchStatusBadge status={batch.status} />
											{format && format !== "single" ? (
												<Badge variant="outline">
													{CONTAINER_FORMAT_LABELS[format] ?? format}
												</Badge>
											) : null}
											{batch.metadata.label ? (
												<Badge variant="outline">{batch.metadata.label}</Badge>
											) : null}
										</div>

										<p className="mt-1 text-[13px] text-mute">
											{batch.messageCount}{" "}
											{pluralize(batch.messageCount, "message")} ·{" "}
											{batch.readyCount} ready
											{batch.failedCount > 0
												? ` · ${batch.failedCount} failed`
												: ""}{" "}
											· {formatRelativeTime(batch.createdAt)}
										</p>

										{batch.metadata.degradationReason ===
										"analyzer_segmentation_unavailable" ? (
											<p className="mt-1.5 text-[13px] text-accent-yellow leading-[1.5]">
												Segmentation was unavailable, so this was ingested as a
												single message.
											</p>
										) : null}

										{batch.failureReason ? (
											<p className="mt-1.5 text-[13px] text-accent-red leading-[1.5]">
												{batch.failureReason}
											</p>
										) : null}
									</div>

									{showProgress ? (
										<div className="w-full shrink-0 sm:w-40">
											<Progress value={percent} />
											<p className="mt-1.5 text-right text-[12px] text-ash tracking-[0.4px]">
												{percent}% ingested
											</p>
										</div>
									) : null}
								</div>
							</Link>
						</motion.div>
					</StaggerItem>
				);
			})}
		</Stagger>
	);
}
