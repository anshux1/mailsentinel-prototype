"use client";

import { FolderX, Layers, Mail, Waypoints } from "lucide-react";
import { useRouter } from "next/navigation";
import { use, useState } from "react";

import { CopyButton, Field, FieldGrid } from "@/components/common/field";
import { PageHeader } from "@/components/common/page-header";
import {
	EmptyState,
	ErrorState,
	ListSkeleton,
} from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStartAnalysis } from "@/features/analysis/queries";
import { RunList } from "@/features/analysis/run-list";
import { BatchList } from "@/features/batches/batch-list";
import { useCase } from "@/features/cases/queries";
import { EvidenceList } from "@/features/evidence/evidence-list";
import { useEvidenceList } from "@/features/evidence/queries";
import { UploadEvidenceDialog } from "@/features/evidence/upload-evidence-dialog";
import { CaseMailboxSyncAction } from "@/features/mailbox/case-sync-action";
import { formatDateTime, pluralize } from "@/lib/format";

export default function CaseDetailPage({
	params,
}: PageProps<"/cases/[caseId]">) {
	const { caseId } = use(params);
	const router = useRouter();
	const [analyzingEvidenceId, setAnalyzingEvidenceId] = useState<string | null>(
		null,
	);

	const caseQuery = useCase(caseId);
	const evidence = useEvidenceList(caseId);

	const startAnalysis = useStartAnalysis((analysisRunId) => {
		setAnalyzingEvidenceId(null);
		router.push(`/analysis/${analysisRunId}`);
	});

	if (caseQuery.isPending) {
		return (
			<div className="space-y-8">
				<Skeleton className="h-4 w-40" />
				<Skeleton className="h-8 w-80" />
				<ListSkeleton rows={3} />
			</div>
		);
	}

	if (caseQuery.isError) {
		return (
			<ErrorState
				error={caseQuery.error}
				onRetry={() => void caseQuery.refetch()}
				title="Could not load this case"
			/>
		);
	}

	if (!caseQuery.data) {
		return (
			<EmptyState
				icon={FolderX}
				title="Case not found"
				description="This case does not exist, or it belongs to another organization."
			/>
		);
	}

	const record = caseQuery.data;
	const evidenceItems = evidence.data?.items ?? [];
	const verifiedCount = evidenceItems.filter(
		(item) => item.status === "verified",
	).length;

	return (
		<div className="space-y-8">
			<PageHeader
				breadcrumbs={[
					{ label: "Cases", href: "/cases" },
					{ label: record.title },
				]}
				title={record.title}
				meta={
					<>
						<Badge variant="outline">
							{evidenceItems.length}{" "}
							{pluralize(evidenceItems.length, "artifact")}
						</Badge>
						<Badge variant="outline">{verifiedCount} verified</Badge>
						<span className="text-[13px] text-mute">
							Opened {formatDateTime(record.createdAt)}
						</span>
					</>
				}
				actions={
					<>
						<CaseMailboxSyncAction caseId={caseId} />
						<UploadEvidenceDialog caseId={caseId} />
					</>
				}
			/>

			<div className="rounded-lg border border-hairline bg-surface p-6">
				<FieldGrid columns={3}>
					<Field label="Case id" mono>
						<span className="inline-flex items-center gap-1">
							{record.id}
							<CopyButton value={record.id} label="Copy case id" />
						</span>
					</Field>
					<Field label="Organization" mono>
						{record.organizationId}
					</Field>
					<Field label="Last updated">{formatDateTime(record.updatedAt)}</Field>
				</FieldGrid>
			</div>

			<Tabs defaultValue="evidence">
				<TabsList>
					<TabsTrigger value="evidence">
						<Mail className="size-3.5" />
						Evidence
					</TabsTrigger>
					<TabsTrigger value="batches">
						<Layers className="size-3.5" />
						Ingestion
					</TabsTrigger>
					<TabsTrigger value="analysis">
						<Waypoints className="size-3.5" />
						Analysis runs
					</TabsTrigger>
				</TabsList>

				<TabsContent value="evidence" className="pt-5">
					<EvidenceList
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
				</TabsContent>

				<TabsContent value="batches" className="pt-5">
					<BatchList caseId={caseId} />
				</TabsContent>

				<TabsContent value="analysis" className="pt-5">
					<RunList
						filters={{ caseId }}
						emptyDescription="Dispatch an analysis from a verified artifact on the Evidence tab."
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}
