"use client";

import { CheckCircle2, FileUp, Loader2, Upload, X } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useId, useRef, useState } from "react";

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
import { Progress } from "@/components/ui/progress";
import {
	EVIDENCE_ACCEPT,
	EVIDENCE_FILE_ERRORS,
	prepareEvidenceFile,
	validateEvidenceFile,
} from "@/features/evidence/file";
import { useUploadEvidence } from "@/features/evidence/queries";
import { usePermissions } from "@/features/organization/use-permissions";
import { safeErrorMessage } from "@/lib/errors";
import { formatBytes, truncateDigest } from "@/lib/format";
import { brandEase } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Stage = "idle" | "hashing" | "uploading" | "done";

export function UploadEvidenceDialog({
	caseId,
	onUploaded,
	trigger,
}: {
	caseId: string;
	onUploaded?: (evidenceId: string) => void;
	trigger?: React.ReactNode;
}) {
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const { can } = usePermissions();

	const [open, setOpen] = useState(false);
	const [file, setFile] = useState<File | null>(null);
	const [digest, setDigest] = useState<string | null>(null);
	const [stage, setStage] = useState<Stage>("idle");
	const [localError, setLocalError] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);

	const upload = useUploadEvidence(caseId);

	const uploadReset = upload.reset;
	const reset = useCallback(() => {
		setFile(null);
		setDigest(null);
		setStage("idle");
		setLocalError(null);
		setDragging(false);
		uploadReset();
	}, [uploadReset]);

	// Closing discards the selection and any previous failure.
	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (!next) reset();
			setOpen(next);
		},
		[reset],
	);

	const chooseFile = useCallback((candidate: File) => {
		const problem = validateEvidenceFile(candidate);
		if (problem) {
			setLocalError(EVIDENCE_FILE_ERRORS[problem]);
			setFile(null);
			setDigest(null);
			return;
		}
		setLocalError(null);
		setFile(candidate);
		setDigest(null);
		setStage("idle");
	}, []);

	async function onSubmit(event: React.FormEvent) {
		event.preventDefault();
		if (!file || stage === "hashing" || stage === "uploading") return;

		try {
			setStage("hashing");
			// The digest is computed locally so the server can reject any body that
			// does not match what was registered.
			const prepared = await prepareEvidenceFile(file);
			setDigest(prepared.sha256);

			setStage("uploading");
			const evidence = await upload.mutateAsync({
				file,
				sha256: prepared.sha256,
				base64: prepared.base64,
				idempotencyKey: `upload_${prepared.sha256.slice(0, 32)}`,
			});

			setStage("done");
			onUploaded?.(evidence.id);
			window.setTimeout(() => handleOpenChange(false), 700);
		} catch {
			// The error surfaces through `upload.error` below.
			setStage("idle");
		}
	}

	if (!can("evidence:upload")) return null;

	const busy = stage === "hashing" || stage === "uploading";
	const progress =
		stage === "hashing"
			? 35
			: stage === "uploading"
				? 78
				: stage === "done"
					? 100
					: 0;

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			{trigger !== undefined ? (
				<DialogTrigger asChild>{trigger}</DialogTrigger>
			) : (
				<DialogTrigger asChild>
					<Button variant="primary">
						<Upload className="size-4" />
						Upload evidence
					</Button>
				</DialogTrigger>
			)}

			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Upload evidence</DialogTitle>
					<DialogDescription>
						Raw <code className="font-mono text-[13px]">.eml</code> only. The
						message is hashed in your browser, written to private storage, and
						sealed as immutable — it is never rendered here.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={onSubmit} className="space-y-4">
					{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target wraps a real file input */}
					<div
						onDragOver={(event) => {
							event.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={(event) => {
							event.preventDefault();
							setDragging(false);
							const dropped = event.dataTransfer.files[0];
							if (dropped) chooseFile(dropped);
						}}
						className={cn(
							"rounded-lg border border-dashed p-6 text-center transition-colors duration-150",
							dragging
								? "border-hairline-strong bg-surface-elevated"
								: "border-hairline bg-surface",
						)}
					>
						<input
							ref={inputRef}
							id={inputId}
							type="file"
							accept={EVIDENCE_ACCEPT}
							className="sr-only"
							onChange={(event) => {
								const selected = event.target.files?.[0];
								if (selected) chooseFile(selected);
							}}
						/>

						{file ? (
							<motion.div
								key="file"
								initial={{ opacity: 0, y: 4 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.18, ease: brandEase }}
								className="flex items-center gap-3 text-left"
							>
								<span className="grid size-10 shrink-0 place-items-center rounded-md border border-hairline bg-surface-card">
									<FileUp className="size-4 text-body" />
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[14px] text-ink">
										{file.name}
									</span>
									<span className="block text-[12px] text-ash tracking-[0.4px]">
										{formatBytes(file.size)}
										{digest ? ` · sha256 ${truncateDigest(digest)}` : null}
									</span>
								</span>
								{!busy && stage !== "done" ? (
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										onClick={reset}
										aria-label="Remove file"
									>
										<X className="size-3.5" />
									</Button>
								) : null}
								{stage === "done" ? (
									<CheckCircle2 className="size-4 text-accent-green" />
								) : null}
							</motion.div>
						) : (
							<motion.div
								key="empty"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								transition={{ duration: 0.18 }}
							>
								<Upload className="mx-auto size-5 text-ash" />
								<p className="mt-3 text-[14px] text-body">
									Drop an <span className="font-mono text-[13px]">.eml</span>{" "}
									file here
								</p>
								<Button
									type="button"
									variant="tertiary"
									size="sm"
									className="mt-4"
									onClick={() => inputRef.current?.click()}
								>
									Choose file
								</Button>
							</motion.div>
						)}
					</div>

					{busy || stage === "done" ? (
						<div className="space-y-2">
							<Progress value={progress} />
							<p className="text-[12px] text-ash tracking-[0.4px]">
								{stage === "hashing"
									? "Computing SHA-256 digest…"
									: stage === "uploading"
										? "Registering and writing to private storage…"
										: "Verified and immutable."}
							</p>
						</div>
					) : null}

					{localError || upload.isError ? (
						<p
							role="alert"
							className="rounded-md bg-accent-red-soft px-3 py-2.5 text-[13px] text-accent-red leading-[1.5]"
						>
							{localError ?? safeErrorMessage(upload.error)}
						</p>
					) : null}

					<DialogFooter>
						<Button
							type="button"
							variant="secondary"
							onClick={() => handleOpenChange(false)}
							disabled={busy}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							variant="primary"
							disabled={!file || busy || stage === "done"}
						>
							{busy ? (
								<>
									<Loader2 className="size-4 animate-spin" />
									{stage === "hashing" ? "Hashing…" : "Uploading…"}
								</>
							) : (
								"Upload and verify"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
