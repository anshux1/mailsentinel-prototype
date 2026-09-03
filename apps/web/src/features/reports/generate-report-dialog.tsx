"use client";

import { FileText, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { usePermissions } from "@/features/organization/use-permissions";
import {
	type ReportFormat,
	useGenerateReport,
} from "@/features/reports/queries";
import { safeErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

const FORMATS: Array<{
	value: ReportFormat;
	label: string;
	description: string;
}> = [
	{
		value: "html",
		label: "HTML",
		description: "Printable, fully escaped — no active content.",
	},
	{
		value: "json",
		label: "JSON",
		description: "Canonical machine-readable document.",
	},
	{
		value: "text",
		label: "Text",
		description: "Plain summary for tickets and email.",
	},
];

export function GenerateReportDialog({
	analysisRunId,
	onGenerated,
	trigger,
	disabled = false,
}: {
	analysisRunId: string;
	onGenerated?: (reportId: string) => void;
	trigger?: React.ReactNode;
	disabled?: boolean;
}) {
	const { can } = usePermissions();
	const [open, setOpen] = useState(false);
	const [format, setFormat] = useState<ReportFormat>("html");

	const generate = useGenerateReport((reportId) => {
		setOpen(false);
		onGenerated?.(reportId);
	});

	// Closing discards any previous failure.
	function handleOpenChange(next: boolean) {
		if (!next) generate.reset();
		setOpen(next);
	}

	if (!can("reports:generate")) return null;

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			{trigger !== undefined ? (
				<DialogTrigger asChild>{trigger}</DialogTrigger>
			) : (
				<DialogTrigger asChild>
					<Button variant="primary" disabled={disabled}>
						<FileText className="size-4" />
						Generate report
					</Button>
				</DialogTrigger>
			)}

			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Generate a forensic report</DialogTitle>
					<DialogDescription>
						Each generation writes a new immutable version built only from the
						persisted analysis result. Earlier versions are never overwritten.
					</DialogDescription>
				</DialogHeader>

				<fieldset className="space-y-2">
					<Label asChild>
						<legend>Format</legend>
					</Label>
					<div className="grid gap-2">
						{FORMATS.map((option) => {
							const selected = option.value === format;
							return (
								<button
									key={option.value}
									type="button"
									onClick={() => setFormat(option.value)}
									aria-pressed={selected}
									className={cn(
										"rounded-md border p-3 text-left transition-colors duration-150",
										selected
											? "border-hairline-strong bg-surface-card"
											: "border-hairline bg-surface hover:bg-surface-elevated",
									)}
								>
									<span className="flex items-center gap-2">
										<span
											className={cn(
												"size-1.5 rounded-full",
												selected ? "bg-on-dark" : "bg-stone",
											)}
										/>
										<span className="font-medium text-[14px] text-ink">
											{option.label}
										</span>
									</span>
									<span className="mt-1 block pl-3.5 text-[13px] text-mute leading-[1.5]">
										{option.description}
									</span>
								</button>
							);
						})}
					</div>
				</fieldset>

				{generate.isError ? (
					<p
						role="alert"
						className="rounded-md bg-accent-red-soft px-3 py-2.5 text-[13px] text-accent-red leading-[1.5]"
					>
						{safeErrorMessage(generate.error)}
					</p>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="secondary"
						onClick={() => handleOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="primary"
						disabled={generate.isPending}
						onClick={() => generate.mutate({ analysisRunId, format })}
					>
						{generate.isPending ? (
							<>
								<Loader2 className="size-4 animate-spin" />
								Generating…
							</>
						) : (
							"Generate"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
