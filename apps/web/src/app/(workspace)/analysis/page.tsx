"use client";

import { useState } from "react";

import { PageHeader } from "@/components/common/page-header";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { AnalysisListFilters } from "@/features/analysis/queries";
import { RunList } from "@/features/analysis/run-list";

type StatusFilter = NonNullable<AnalysisListFilters["status"]> | "all";
type VerdictFilter = NonNullable<AnalysisListFilters["verdict"]> | "all";

const STATUSES: Array<{ value: StatusFilter; label: string }> = [
	{ value: "all", label: "All statuses" },
	{ value: "accepted", label: "Accepted" },
	{ value: "queued", label: "Queued" },
	{ value: "processing", label: "Processing" },
	{ value: "completed", label: "Completed" },
	{ value: "deferred", label: "Deferred" },
	{ value: "failed", label: "Failed" },
];

const VERDICTS: Array<{ value: VerdictFilter; label: string }> = [
	{ value: "all", label: "All verdicts" },
	{ value: "benign", label: "Benign" },
	{ value: "suspicious", label: "Suspicious" },
	{ value: "malicious", label: "Malicious" },
	{ value: "unknown", label: "Unknown" },
];

export default function AnalysisPage() {
	const [status, setStatus] = useState<StatusFilter>("all");
	const [verdict, setVerdict] = useState<VerdictFilter>("all");

	return (
		<div className="space-y-8">
			<PageHeader
				title="Analysis"
				description="Every run in this organization. Active runs refresh automatically until they settle."
			/>

			<div className="flex flex-wrap gap-3">
				<Select
					value={status}
					onValueChange={(value) => setStatus(value as StatusFilter)}
				>
					<SelectTrigger className="w-44" aria-label="Filter by status">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{STATUSES.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Select
					value={verdict}
					onValueChange={(value) => setVerdict(value as VerdictFilter)}
				>
					<SelectTrigger className="w-44" aria-label="Filter by verdict">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{VERDICTS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<RunList
				showCaseLink
				filters={{
					status: status === "all" ? undefined : status,
					verdict: verdict === "all" ? undefined : verdict,
				}}
				emptyDescription={
					status === "all" && verdict === "all"
						? "Dispatch an analysis from a verified artifact inside a case."
						: "No runs match these filters."
				}
			/>
		</div>
	);
}
