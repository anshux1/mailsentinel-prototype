"use client";

import {
	ArrowUpRight,
	FileText,
	FolderClosed,
	ShieldAlert,
	Waypoints,
} from "lucide-react";
import Link from "next/link";

import { Stagger } from "@/components/common/motion";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { CardGridSkeleton, ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { useAnalysisRuns } from "@/features/analysis/queries";
import { RunList } from "@/features/analysis/run-list";
import { CreateCaseDialog } from "@/features/cases/create-case-dialog";
import { useCases } from "@/features/cases/queries";
import { useOrganizations } from "@/features/organization/use-organizations";
import { useReports } from "@/features/reports/queries";
import { formatRelativeTime, pluralize } from "@/lib/format";

export default function DashboardPage() {
	const { activeOrganization } = useOrganizations();
	const cases = useCases({ limit: 100 });
	const runs = useAnalysisRuns({ limit: 100 });
	const reports = useReports({ limit: 100 });

	const caseItems = cases.data?.items ?? [];
	const runItems = runs.data?.items ?? [];
	const reportItems = reports.data?.items ?? [];

	const active = runItems.filter((run) =>
		["accepted", "queued", "processing"].includes(run.status),
	).length;
	const flagged = runItems.filter(
		(run) => run.verdict === "malicious" || run.verdict === "suspicious",
	).length;

	const statsLoading = cases.isPending || runs.isPending || reports.isPending;
	const statsFailed = cases.isError || runs.isError || reports.isError;

	return (
		<div className="space-y-10">
			<PageHeader
				title={`Welcome back${activeOrganization ? `, ${activeOrganization.name}` : ""}`}
				description="Everything below is scoped to your active organization."
				actions={<CreateCaseDialog />}
			/>

			{statsFailed ? (
				<ErrorState
					error={cases.error ?? runs.error ?? reports.error}
					onRetry={() => {
						void cases.refetch();
						void runs.refetch();
						void reports.refetch();
					}}
					title="Could not load workspace activity"
				/>
			) : statsLoading ? (
				<CardGridSkeleton cards={4} className="lg:grid-cols-4" />
			) : (
				<Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					<StatCard
						label="Cases"
						value={caseItems.length}
						icon={FolderClosed}
						hint={
							caseItems[0]
								? `Latest ${formatRelativeTime(caseItems[0].createdAt)}`
								: "No cases yet"
						}
					/>
					<StatCard
						label="Analysis runs"
						value={runItems.length}
						icon={Waypoints}
						hint={
							active > 0
								? `${active} ${pluralize(active, "run")} in progress`
								: "Nothing running"
						}
					/>
					<StatCard
						label="Flagged"
						value={flagged}
						icon={ShieldAlert}
						hint="Suspicious or malicious verdicts"
					/>
					<StatCard
						label="Reports"
						value={reportItems.length}
						icon={FileText}
						hint="Immutable versions generated"
					/>
				</Stagger>
			)}

			<section className="space-y-4">
				<div className="flex items-center justify-between gap-4">
					<h2 className="font-medium text-[18px] text-ink tracking-[0.2px]">
						Recent analysis
					</h2>
					<Button asChild variant="secondary" size="sm">
						<Link href="/analysis">
							View all
							<ArrowUpRight className="size-3.5" />
						</Link>
					</Button>
				</div>
				<RunList
					filters={{ limit: 5 }}
					showCaseLink
					emptyDescription="Open a case, upload an .eml message, and dispatch the first analysis."
					emptyAction={<CreateCaseDialog />}
				/>
			</section>

			<section className="space-y-4">
				<div className="flex items-center justify-between gap-4">
					<h2 className="font-medium text-[18px] text-ink tracking-[0.2px]">
						Recent cases
					</h2>
					<Button asChild variant="secondary" size="sm">
						<Link href="/cases">
							View all
							<ArrowUpRight className="size-3.5" />
						</Link>
					</Button>
				</div>

				{statsLoading ? (
					<CardGridSkeleton cards={3} />
				) : caseItems.length === 0 ? (
					<p className="rounded-lg border border-hairline border-dashed bg-surface/40 px-4 py-8 text-center text-[13px] text-ash">
						No cases in this organization yet.
					</p>
				) : (
					<Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{caseItems.slice(0, 6).map((item) => (
							<Link
								key={item.id}
								href={`/cases/${item.id}`}
								className="group rounded-lg border border-hairline bg-surface p-5 transition-colors duration-200 hover:border-hairline-strong"
							>
								<p className="line-clamp-2 font-medium text-[16px] text-ink leading-[1.4] tracking-[0.2px]">
									{item.title}
								</p>
								<p className="mt-2 text-[13px] text-mute">
									Opened {formatRelativeTime(item.createdAt)}
								</p>
								<span className="mt-4 inline-flex items-center gap-1 text-[13px] text-ash transition-colors group-hover:text-on-dark">
									Open case
									<ArrowUpRight className="size-3.5" />
								</span>
							</Link>
						))}
					</Stagger>
				)}
			</section>
		</div>
	);
}
