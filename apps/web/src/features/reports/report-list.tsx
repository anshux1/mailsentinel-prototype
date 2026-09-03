"use client";

import { ArrowUpRight, FileText } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";

import { Stagger, StaggerItem } from "@/components/common/motion";
import {
	EmptyState,
	ErrorState,
	ListSkeleton,
} from "@/components/common/states";
import { ReportStatusBadge } from "@/components/common/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type ReportListFilters, useReports } from "@/features/reports/queries";
import { formatRelativeTime } from "@/lib/format";

export function ReportList({
	filters = {},
	emptyDescription = "Generate a report from a completed analysis run.",
	emptyAction,
	showCaseLink = false,
}: {
	filters?: ReportListFilters;
	emptyDescription?: string;
	emptyAction?: React.ReactNode;
	showCaseLink?: boolean;
}) {
	const reports = useReports(filters);

	if (reports.isPending) return <ListSkeleton rows={3} />;

	if (reports.isError) {
		return (
			<ErrorState
				error={reports.error}
				onRetry={() => void reports.refetch()}
				title="Could not load reports"
			/>
		);
	}

	const items = reports.data?.items ?? [];

	if (items.length === 0) {
		return (
			<EmptyState
				icon={FileText}
				title="No reports yet"
				description={emptyDescription}
				action={emptyAction}
			/>
		);
	}

	return (
		<Stagger className="space-y-3">
			{items.map((report) => (
				<StaggerItem key={report.id}>
					<motion.div
						whileHover={{ y: -1 }}
						transition={{ duration: 0.15 }}
						className="flex flex-col gap-4 rounded-lg border border-hairline bg-surface p-4 transition-colors duration-200 hover:border-hairline-strong sm:flex-row sm:items-center"
					>
						<span className="grid size-10 shrink-0 place-items-center rounded-md border border-hairline bg-surface-card">
							<FileText className="size-4 text-body" />
						</span>

						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium text-[15px] text-ink tracking-[0.2px]">
									Version {report.version}
								</span>
								<Badge variant="outline" className="uppercase">
									{report.format}
								</Badge>
								<ReportStatusBadge status={report.status} />
							</div>
							<p className="mt-1 text-[13px] text-mute">
								{showCaseLink ? (
									<>
										Case{" "}
										<Link
											href={`/cases/${report.caseId}`}
											className="text-body transition-colors hover:text-on-dark"
										>
											{report.caseId}
										</Link>{" "}
										·{" "}
									</>
								) : null}
								Generated{" "}
								{formatRelativeTime(report.generatedAt ?? report.createdAt)}
							</p>
							{report.status === "failed" && report.failureReason ? (
								<p className="mt-1.5 text-[13px] text-accent-red leading-[1.5]">
									{report.failureReason}
								</p>
							) : null}
						</div>

						<Button asChild variant="outline" size="sm" className="shrink-0">
							<Link href={`/reports/${report.id}`}>
								Open
								<ArrowUpRight className="size-3.5" />
							</Link>
						</Button>
					</motion.div>
				</StaggerItem>
			))}
		</Stagger>
	);
}
