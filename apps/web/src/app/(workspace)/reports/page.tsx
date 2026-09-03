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
import type { ReportListFilters } from "@/features/reports/queries";
import { ReportList } from "@/features/reports/report-list";

type FormatFilter = NonNullable<ReportListFilters["format"]> | "all";
type StatusFilter = NonNullable<ReportListFilters["status"]> | "all";

const FORMATS: Array<{ value: FormatFilter; label: string }> = [
	{ value: "all", label: "All formats" },
	{ value: "html", label: "HTML" },
	{ value: "json", label: "JSON" },
	{ value: "text", label: "Text" },
];

const STATUSES: Array<{ value: StatusFilter; label: string }> = [
	{ value: "all", label: "All statuses" },
	{ value: "completed", label: "Completed" },
	{ value: "generating", label: "Generating" },
	{ value: "failed", label: "Failed" },
];

export default function ReportsPage() {
	const [format, setFormat] = useState<FormatFilter>("all");
	const [status, setStatus] = useState<StatusFilter>("all");

	return (
		<div className="space-y-8">
			<PageHeader
				title="Reports"
				description="Immutable forensic documents. Regenerating a run mints a new version rather than replacing history."
			/>

			<div className="flex flex-wrap gap-3">
				<Select
					value={format}
					onValueChange={(value) => setFormat(value as FormatFilter)}
				>
					<SelectTrigger className="w-40" aria-label="Filter by format">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{FORMATS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Select
					value={status}
					onValueChange={(value) => setStatus(value as StatusFilter)}
				>
					<SelectTrigger className="w-40" aria-label="Filter by status">
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
			</div>

			<ReportList
				showCaseLink
				filters={{
					format: format === "all" ? undefined : format,
					status: status === "all" ? undefined : status,
				}}
				emptyDescription={
					format === "all" && status === "all"
						? "Complete an analysis run, then generate its first report."
						: "No reports match these filters."
				}
			/>
		</div>
	);
}
