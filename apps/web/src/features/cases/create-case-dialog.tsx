"use client";

import { Loader2, Plus } from "lucide-react";
import { useId, useState } from "react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateCase } from "@/features/cases/queries";
import { usePermissions } from "@/features/organization/use-permissions";
import { safeErrorMessage } from "@/lib/errors";

const MAX_TITLE = 160;

export function CreateCaseDialog({
	open: controlledOpen,
	onOpenChange,
	onCreated,
	trigger,
}: {
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	onCreated?: (caseId: string) => void;
	trigger?: React.ReactNode;
}) {
	const titleId = useId();
	const { can } = usePermissions();
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const [title, setTitle] = useState("");

	const open = controlledOpen ?? uncontrolledOpen;
	const setOpen = onOpenChange ?? setUncontrolledOpen;

	const createCase = useCreateCase((caseId) => {
		setOpen(false);
		onCreated?.(caseId);
	});

	// Closing discards the draft and any previous failure.
	function handleOpenChange(next: boolean) {
		if (!next) {
			setTitle("");
			createCase.reset();
		}
		setOpen(next);
	}

	if (!can("cases:create")) return null;

	const trimmed = title.trim();
	const invalid = trimmed.length === 0 || trimmed.length > MAX_TITLE;

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			{trigger !== undefined ? (
				<DialogTrigger asChild>{trigger}</DialogTrigger>
			) : (
				<DialogTrigger asChild>
					<Button variant="primary">
						<Plus className="size-4" />
						New case
					</Button>
				</DialogTrigger>
			)}

			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Open a case</DialogTitle>
					<DialogDescription>
						A case groups the evidence, analysis runs, and reports for one
						investigation.
					</DialogDescription>
				</DialogHeader>

				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (invalid || createCase.isPending) return;
						createCase.mutate({ title: trimmed });
					}}
				>
					<div className="space-y-2">
						<Label htmlFor={titleId}>Case title</Label>
						<Input
							id={titleId}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="Suspected invoice fraud — finance inbox"
							maxLength={MAX_TITLE}
							autoFocus
							aria-invalid={
								trimmed.length > MAX_TITLE || createCase.isError || undefined
							}
						/>
						<p className="flex justify-between text-[12px] text-ash tracking-[0.4px]">
							<span>Describe the investigation, not the message.</span>
							<span className="tabular-nums">
								{trimmed.length}/{MAX_TITLE}
							</span>
						</p>
					</div>

					{createCase.isError ? (
						<p
							role="alert"
							className="rounded-md bg-accent-red-soft px-3 py-2.5 text-[13px] text-accent-red leading-[1.5]"
						>
							{safeErrorMessage(createCase.error)}
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
							type="submit"
							variant="primary"
							disabled={invalid || createCase.isPending}
						>
							{createCase.isPending ? (
								<>
									<Loader2 className="size-4 animate-spin" />
									Creating…
								</>
							) : (
								"Create case"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
