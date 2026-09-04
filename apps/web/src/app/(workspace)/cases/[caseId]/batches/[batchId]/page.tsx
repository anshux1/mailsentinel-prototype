"use client";

import { Layers } from "lucide-react";
import { useRouter } from "next/navigation";
import { use, useState } from "react";

import { CopyButton, Field, FieldGrid } from "@/components/common/field";
import { PageHeader } from "@/components/common/page-header";
import {
	EmptyState,
	ErrorState,
	ListSkeleton,
} from "@/components/common/states";
import { BatchStatusBadge } from "@/components/common/status-badge";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useStartAnalysis } from "@/features/analysis/queries";
import { BatchMessageList } from "@/features/batches/batch-message-list";
import { useBatch } from "@/features/batches/queries";
import { useCase } from "@/features/cases/queries";
import { formatDateTime, pluralize, titleCase } from "@/lib/format";

const SOURCE_LABELS: Record<string, string> = {
	upload_single: "Single upload",
	upload_container: "Container upload",
	mailbox_sync: "Mailbox sync",
};

export default function BatchDetailPage({
	params,
}: PageProps<"/cases/[caseId]/batches/[batchId]">) {
	const { caseId, batchId } = use(params);
	const router = useRouter();
	const [analyzingEvidenceId, setAnalyzingEvidenceId] = useState<string | null>(
		null,
	);

	const caseQuery = useCase(caseId);
	const batchQuery = useBatch(batchId, { caseId });

	const startAnalysis = useStartAnalysis((analysisRunId) => {
		setAnalyzingEvidenceId(null);
		router.push(`/analysis/${analysisRunId}`);
	});

	if (batchQuery.isPending) {
		return (
			<div className="space-y-8">
				<Skeleton className="h-4 w-56" />
				<Skeleton className="h-8 w-72" />
				<ListSkeleton rows={4} />
			</div>
		);
	}

	if (batchQuery.isError) {
		return (
			<ErrorState
				error={batchQuery.error}
				onRetry={() => void batchQuery.refetch()}
				title="Could not load this batch"
			/>
		);
	}

	if (!batchQuery.data) {
		return (
			<EmptyState
				icon={Layers}
				title="Batch not found"
				description="This ingestion batch does not exist, or it belongs to another organization."
			/>
		);
	}

	const batch = batchQuery.data;
	const sourceLabel = SOURCE_LABELS[batch.source] ?? titleCase(batch.source);

	return (
		<div className="space-y-8">
			<PageHeader
				breadcrumbs={[
					{ label: "Cases", href: "/cases" },
					{
						label: caseQuery.data?.title ?? "Case",
						href: `/cases/${caseId}`,
					},
					{ label: sourceLabel },
				]}
				title={sourceLabel}
				description="Every message that entered this case through a single ingestion, with the analyzer's extracted headers."
				meta={
					<>
						<BatchStatusBadge status={batch.status} />
						<Badge variant="outline">
							{batch.messageCount} {pluralize(batch.messageCount, "message")}
						</Badge>
						<Badge variant="outline">{batch.readyCount} ready</Badge>
						{batch.failedCount > 0 ? (
							<Badge variant="danger">{batch.failedCount} failed</Badge>
						) : null}
						<span className="text-[13px] text-mute">
							Ingested {formatDateTime(batch.createdAt)}
						</span>
					</>
				}
			/>

			<div className="rounded-lg border border-hairline bg-surface p-6">
				<FieldGrid columns={3}>
					<Field label="Batch id" mono>
						<span className="inline-flex items-center gap-1">
							{batch.id}
							<CopyButton value={batch.id} label="Copy batch id" />
						</span>
					</Field>
					<Field label="Source">{sourceLabel}</Field>
					<Field label="Container format">
						{batch.metadata.containerFormat ?? "—"}
					</Field>
					{batch.containerEvidenceId ? (
						<Field label="Container artifact" mono>
							<span className="inline-flex items-center gap-1">
								{batch.containerEvidenceId}
								<CopyButton
									value={batch.containerEvidenceId}
									label="Copy container evidence id"
								/>
							</span>
						</Field>
					) : null}
					{batch.metadata.provider ? (
						<Field label="Provider">{titleCase(batch.metadata.provider)}</Field>
					) : null}
					{batch.metadata.label ? (
						<Field label="Mailbox label">{batch.metadata.label}</Field>
					) : null}
					<Field label="Last updated">{formatDateTime(batch.updatedAt)}</Field>
				</FieldGrid>

				{batch.metadata.degradationReason ===
				"analyzer_segmentation_unavailable" ? (
					<p className="mt-5 rounded-md bg-accent-yellow-soft px-3 py-2.5 text-[13px] text-accent-yellow leading-[1.5]">
						The analyzer could not segment this upload, so it was ingested as a
						single message rather than split into its parts.
					</p>
				) : null}

				{batch.failureReason ? (
					<p
						role="alert"
						className="mt-5 rounded-md bg-accent-red-soft px-3 py-2.5 text-[13px] text-accent-red leading-[1.5]"
					>
						{batch.failureReason}
					</p>
				) : null}
			</div>

			<section className="space-y-4">
				<h2 className="font-medium text-[18px] text-ink tracking-[0.2px]">
					Messages
				</h2>
				<BatchMessageList
					batchId={batchId}
					caseId={caseId}
					analyzingEvidenceId={analyzingEvidenceId}
					onAnalyze={(evidenceId) => {
						setAnalyzingEvidenceId(evidenceId);
						startAnalysis.mutate(
							{ caseId, evidenceId },
							{ onError: () => setAnalyzingEvidenceId(null) },
						);
					}}
				/>
			</section>
		</div>
	);
}
