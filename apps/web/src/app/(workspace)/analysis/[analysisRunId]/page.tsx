"use client";

import { Loader2, RefreshCw, SearchX } from "lucide-react";
import { use } from "react";

import { CopyButton, Field, FieldGrid } from "@/components/common/field";
import { FadeUp } from "@/components/common/motion";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState } from "@/components/common/states";
import {
	isActiveRunStatus,
	RunStatusBadge,
} from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { AnalysisResultView } from "@/features/analysis/analysis-result-view";
import {
	useAnalysisResult,
	useAnalysisStatus,
	useRetryAnalysis,
} from "@/features/analysis/queries";
import { usePermissions } from "@/features/organization/use-permissions";
import { GenerateReportDialog } from "@/features/reports/generate-report-dialog";
import { ReportList } from "@/features/reports/report-list";
import { isNotFound } from "@/lib/errors";
import { formatDateTime, titleCase } from "@/lib/format";

export default function AnalysisRunPage({
	params,
}: PageProps<"/analysis/[analysisRunId]">) {
	const { analysisRunId } = use(params);
	const { can } = usePermissions();

	const status = useAnalysisStatus(analysisRunId);
	const result = useAnalysisResult(analysisRunId);
	const retry = useRetryAnalysis();

	if (status.isPending) {
		return (
			<div className="space-y-8">
				<Skeleton className="h-4 w-56" />
				<Skeleton className="h-8 w-72" />
				<Skeleton className="h-52 rounded-lg" />
			</div>
		);
	}

	if (status.isError) {
		return isNotFound(status.error) ? (
			<EmptyState
				icon={SearchX}
				title="Analysis run not found"
				description="This run does not exist, or it belongs to another organization."
			/>
		) : (
			<ErrorState
				error={status.error}
				onRetry={() => void status.refetch()}
				title="Could not load this analysis run"
			/>
		);
	}

	const run = status.data;
	const active = isActiveRunStatus(run.status);
	const completed = result.data?.ready === true;
	const canRetry =
		run.status === "failed" && run.retryable && can("analysis:retry");

	return (
		<div className="space-y-8">
			<PageHeader
				breadcrumbs={[
					{ label: "Cases", href: "/cases" },
					{ label: run.caseId, href: `/cases/${run.caseId}` },
					{ label: "Analysis run" },
				]}
				title="Analysis run"
				meta={
					<>
						<RunStatusBadge status={run.status} />
						<span className="inline-flex items-center gap-1 font-mono text-[13px] text-mute">
							{run.analysisRunId}
							<CopyButton value={run.analysisRunId} label="Copy run id" />
						</span>
					</>
				}
				actions={
					<>
						{canRetry ? (
							<Button
								variant="tertiary"
								disabled={retry.isPending}
								onClick={() =>
									retry.mutate({
										analysisRunId: run.analysisRunId,
										caseId: run.caseId,
									})
								}
							>
								<RefreshCw
									className={retry.isPending ? "size-4 animate-spin" : "size-4"}
								/>
								Retry run
							</Button>
						) : null}
						<GenerateReportDialog
							analysisRunId={run.analysisRunId}
							disabled={!completed}
						/>
					</>
				}
			/>

			<div className="rounded-lg border border-hairline bg-surface p-6">
				<FieldGrid columns={4}>
					<Field label="Attempts">{run.attempts}</Field>
					<Field label="Queued">{formatDateTime(run.queuedAt)}</Field>
					<Field label="Started">{formatDateTime(run.startedAt)}</Field>
					<Field label="Completed">
						{formatDateTime(run.completedAt ?? run.failedAt)}
					</Field>
				</FieldGrid>

				{active ? (
					<div className="mt-6 space-y-2 border-hairline border-t pt-5">
						<div className="flex items-center justify-between gap-4">
							<p className="flex items-center gap-2 text-[13px] text-mute">
								<Loader2 className="size-3.5 animate-spin" />
								{run.phase ? titleCase(run.phase) : "Waiting for the analyzer"}
							</p>
							<span className="text-[13px] text-ash tabular-nums">
								{run.progress ?? 0}%
							</span>
						</div>
						<Progress value={run.progress ?? 8} />
						<p className="text-[12px] text-stone tracking-[0.4px]">
							This page refreshes on its own while the run is active.
						</p>
					</div>
				) : null}

				{run.status === "failed" ? (
					<div className="mt-6 border-hairline border-t pt-5">
						<p className="rounded-md bg-accent-red-soft px-3 py-2.5 text-[13px] text-accent-red leading-[1.5]">
							{run.failureMessage ?? "The analyzer reported a failure."}
							{run.failureCode ? (
								<span className="mt-1 block font-mono text-[12px] opacity-80">
									{run.failureCode}
								</span>
							) : null}
						</p>
						<p className="mt-2 text-[12px] text-stone leading-[1.5]">
							{run.retryable
								? "This failure is retryable. An owner can redispatch the run."
								: "This failure is terminal and will not be retried."}
						</p>
					</div>
				) : null}
			</div>

			{result.isPending ? (
				<Skeleton className="h-64 rounded-lg" />
			) : result.isError ? (
				<ErrorState
					error={result.error}
					onRetry={() => void result.refetch()}
					title="Could not load the analysis result"
				/>
			) : result.data?.ready ? (
				<FadeUp>
					<AnalysisResultView result={result.data} />
				</FadeUp>
			) : (
				<EmptyState
					icon={Loader2}
					title={
						active ? "Results are still being produced" : "No result available"
					}
					description={
						active
							? "The analyzer writes its findings once scoring completes. Nothing here polls the message itself."
							: "This run did not produce a completed result."
					}
				/>
			)}

			{completed ? (
				<section className="space-y-4">
					<h2 className="font-medium text-[18px] text-ink tracking-[0.2px]">
						Reports from this run
					</h2>
					<ReportList
						filters={{ analysisRunId: run.analysisRunId }}
						emptyDescription="Generate the first immutable report for this run."
						emptyAction={
							<GenerateReportDialog analysisRunId={run.analysisRunId} />
						}
					/>
				</section>
			) : null}
		</div>
	);
}
