"use client";

import { Check, Copy } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Label + value pair used across every detail panel. */
export function Field({
	label,
	children,
	className,
	mono = false,
}: {
	label: string;
	children: React.ReactNode;
	className?: string;
	mono?: boolean;
}) {
	return (
		<div className={cn("min-w-0 space-y-1", className)}>
			<dt className="text-[12px] text-ash uppercase tracking-[0.4px]">
				{label}
			</dt>
			<dd
				className={cn(
					"break-words text-[14px] text-body leading-[1.6]",
					mono && "font-mono text-[13px]",
				)}
			>
				{children}
			</dd>
		</div>
	);
}

export function FieldGrid({
	children,
	className,
	columns = 2,
}: {
	children: React.ReactNode;
	className?: string;
	columns?: 1 | 2 | 3 | 4;
}) {
	return (
		<dl
			className={cn(
				"grid gap-x-6 gap-y-5",
				columns === 1 && "grid-cols-1",
				columns === 2 && "grid-cols-1 sm:grid-cols-2",
				columns === 3 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
				columns === 4 && "grid-cols-2 lg:grid-cols-4",
				className,
			)}
		>
			{children}
		</dl>
	);
}

export function CopyButton({
	value,
	label = "Copy",
	className,
}: {
	value: string;
	label?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timeout = window.setTimeout(() => setCopied(false), 1600);
		return () => window.clearTimeout(timeout);
	}, [copied]);

	const copy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
		} catch {
			// Clipboard can be blocked; the value stays selectable on the page.
		}
	}, [value]);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={copy}
					aria-label={copied ? "Copied" : label}
					className={cn("text-ash hover:text-on-dark", className)}
				>
					<motion.span
						key={copied ? "copied" : "idle"}
						initial={{ opacity: 0, scale: 0.7 }}
						animate={{ opacity: 1, scale: 1 }}
						transition={{ duration: 0.14 }}
						className="grid place-items-center"
					>
						{copied ? (
							<Check className="size-3.5 text-accent-green" />
						) : (
							<Copy className="size-3.5" />
						)}
					</motion.span>
				</Button>
			</TooltipTrigger>
			<TooltipContent>{copied ? "Copied" : label}</TooltipContent>
		</Tooltip>
	);
}

/** Monospace identifier with an inline copy affordance. */
export function IdentifierChip({
	value,
	className,
	truncate = true,
}: {
	value: string;
	className?: string;
	truncate?: boolean;
}) {
	return (
		<span
			className={cn(
				"inline-flex max-w-full items-center gap-1 rounded-xs border border-hairline bg-surface-card py-0.5 pr-0.5 pl-2",
				className,
			)}
		>
			<code
				className={cn(
					"font-mono text-[12px] text-mute",
					truncate && "truncate",
				)}
			>
				{value}
			</code>
			<CopyButton value={value} label="Copy identifier" />
		</span>
	);
}
