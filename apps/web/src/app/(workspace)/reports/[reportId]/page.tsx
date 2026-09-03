"use client";

import { FileWarning, Loader2, SearchX } from "lucide-react";
import Link from "next/link";
import { use } from "react";

import { CopyButton, Field, FieldGrid } from "@/components/common/field";
import { FadeUp } from "@/components/common/motion";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState } from "@/components/common/states";
import { ReportStatusBadge } from "@/components/common/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useReport } from "@/features/reports/queries";
import { ReportViewer } from "@/features/reports/report-viewer";
import { isNotFound } from "@/lib/errors";
import { formatBytes, formatDateTime } from "@/lib/format";

export default function ReportDetailPage({
	params,
}: PageProps<"/reports/[reportId]">) {
	const { reportId } = use(params);
	const report = useReport(reportId);

	if (report.isPending) {
		return (
			<div className="space-y-8">
				<Skeleton className="h-4 w-56" />
				<Skeleton className="h-8 w-72" />
				<Skeleton className="h-96 rounded-lg" />
			</div>
		);
	}

	if (report.isError) {
		return isNotFound(report.error) ? (
			<EmptyState
				icon={SearchX}
				title="Report not found"
				description="This report does not exist, or it belongs to another organization."
			/>
		) : (
			<ErrorState
				error={report.error}
				onRetry={() => void report.refetch()}
				title="Could not load this report"
			/>
		);
	}

	const record = report.data;
	const metadata = record.metadata as {
		reportVersion?: string;
		byteSize?: number;
		findingCount?: number;
	};

	return (
		<div className="space-y-8">
			<PageHeader
				breadcrumbs={[
					{ label: "Reports", href: "/reports" },
					{ label: `Version ${record.version}` },
				]}
				title={`Forensic report v${record.version}`}
				meta={
					<>
						<ReportStatusBadge status={record.status} />
						<Badge variant="outline" className="uppercase">
							{record.format}
						</Badge>
						<span className="text-[13px] text-mute">
							Generated {formatDateTime(record.generatedAt ?? record.createdAt)}
						</span>
					</>
				}
				actions={
					<Button asChild variant="tertiary">
						<Link href={`/analysis/${record.analysisRunId}`}>
							Open analysis run
						</Link>
					</Button>
				}
			/>

			<div className="rounded-lg border border-hairline bg-surface p-6">
				<FieldGrid columns={4}>
					<Field label="Report id" mono>
						<span className="inline-flex items-center gap-1">
							{record.id}
							<CopyButton value={record.id} label="Copy report id" />
						</span>
					</Field>
					<Field label="Analysis run" mono>
						<Link
							href={`/analysis/${record.analysisRunId}`}
							className="transition-colors hover:text-on-dark"
						>
							{record.analysisRunId}
						</Link>
					</Field>
					<Field label="Document version">
						{metadata.reportVersion ?? "—"}
					</Field>
					<Field label="Size">
						{metadata.byteSize ? formatBytes(metadata.byteSize) : "—"}
					</Field>
				</FieldGrid>
			</div>

			{record.status === "failed" ? (
				<EmptyState
					icon={FileWarning}
					title="This report failed to generate"
					description={
						record.failureReason ??
						"The private object could not be written. Generate a new version to try again."
					}
				/>
			) : record.status !== "completed" ? (
				<EmptyState
					icon={Loader2}
					title="Still generating"
					description="The report object is written before the record is marked complete."
				/>
			) : record.content ? (
				<FadeUp>
					<ReportViewer
						content={record.content}
						format={record.format}
						fileName={`mailsentinel-${record.analysisRunId}-v${record.version}`}
					/>
				</FadeUp>
			) : (
				<EmptyState
					icon={FileWarning}
					title="Report content unavailable"
					description="The record is complete but its private object could not be read."
				/>
			)}
		</div>
	);
}
