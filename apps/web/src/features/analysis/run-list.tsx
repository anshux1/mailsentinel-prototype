"use client";

import { ArrowUpRight, RefreshCw, Waypoints } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";

import { Stagger, StaggerItem } from "@/components/common/motion";
import {
	EmptyState,
	ErrorState,
	ListSkeleton,
} from "@/components/common/states";
import {
	isActiveRunStatus,
	RunStatusBadge,
	VerdictBadge,
} from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	type AnalysisListFilters,
	useAnalysisRuns,
	useRetryAnalysis,
} from "@/features/analysis/queries";
import { usePermissions } from "@/features/organization/use-permissions";
import { formatRelativeTime, titleCase } from "@/lib/format";

export function RunList({
	filters = {},
	emptyAction,
	emptyDescription = "Run an analysis from a verified piece of evidence to see it here.",
	showCaseLink = false,
}: {
	filters?: AnalysisListFilters;
	emptyAction?: React.ReactNode;
	emptyDescription?: string;
	showCaseLink?: boolean;
}) {
	const runs = useAnalysisRuns(filters);
	const retry = useRetryAnalysis();
	const { can } = usePermissions();

	if (runs.isPending) return <ListSkeleton rows={3} />;

	if (runs.isError) {
		return (
			<ErrorState
				error={runs.error}
				onRetry={() => void runs.refetch()}
				title="Could not load analysis runs"
			/>
		);
	}

	const items = runs.data?.items ?? [];

	if (items.length === 0) {
		return (
			<EmptyState
				icon={Waypoints}
				title="No analysis runs"
				description={emptyDescription}
				action={emptyAction}
			/>
		);
	}

	return (
		<Stagger className="space-y-3">
			{items.map((run) => {
				const active = isActiveRunStatus(run.status);
				const canRetry =
					run.status === "failed" && run.retryable && can("analysis:retry");

				return (
					<StaggerItem key={run.id}>
						<motion.div
							whileHover={{ y: -1 }}
							transition={{ duration: 0.15 }}
							className="rounded-lg border border-hairline bg-surface p-4 transition-colors duration-200 hover:border-hairline-strong"
						>
							<div className="flex flex-col gap-4 sm:flex-row sm:items-start">
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<RunStatusBadge status={run.status} />
										{run.verdict ? (
											<VerdictBadge verdict={run.verdict} />
										) : null}
										{run.attempts > 1 ? (
											<span className="text-[12px] text-ash tracking-[0.4px]">
												Attempt {run.attempts}
											</span>
										) : null}
									</div>

									<p className="mt-2 font-mono text-[13px] text-ink">
										{run.id}
									</p>

									<p className="mt-1 text-[13px] text-mute">
										{showCaseLink ? (
											<>
												Case{" "}
												<Link
													href={`/cases/${run.caseId}`}
													className="text-body transition-colors hover:text-on-dark"
												>
													{run.caseId}
												</Link>{" "}
												·{" "}
											</>
										) : null}
										Updated {formatRelativeTime(run.updatedAt)}
										{run.score !== null && run.score !== undefined
											? ` · score ${run.score}/100`
											: ""}
									</p>

									{active ? (
										<div className="mt-3 max-w-sm space-y-1.5">
											<Progress value={run.progress ?? 8} />
											<p className="text-[12px] text-ash tracking-[0.4px]">
												{run.phase
													? titleCase(run.phase)
													: "Waiting for the analyzer"}
											</p>
										</div>
									) : null}

									{run.status === "failed" && run.failureMessage ? (
										<p className="mt-2.5 rounded-md bg-accent-red-soft px-3 py-2 text-[13px] text-accent-red leading-[1.5]">
											{run.failureMessage}
										</p>
									) : null}
								</div>

								<div className="flex shrink-0 items-center gap-2">
									{canRetry ? (
										<Button
											variant="tertiary"
											size="sm"
											disabled={retry.isPending}
											onClick={() =>
												retry.mutate({
													analysisRunId: run.id,
													caseId: run.caseId,
												})
											}
										>
											<RefreshCw
												className={
													retry.isPending ? "size-3.5 animate-spin" : "size-3.5"
												}
											/>
											Retry
										</Button>
									) : null}
									<Button asChild variant="outline" size="sm">
										<Link href={`/analysis/${run.id}`}>
											Open
											<ArrowUpRight className="size-3.5" />
										</Link>
									</Button>
								</div>
							</div>
						</motion.div>
					</StaggerItem>
				);
			})}
		</Stagger>
	);
}
