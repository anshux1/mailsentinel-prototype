"use client";

import type { LucideIcon } from "lucide-react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { FadeUp } from "@/components/common/motion";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { requestId, safeErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	className,
}: {
	icon: LucideIcon;
	title: string;
	description?: string;
	action?: React.ReactNode;
	className?: string;
}) {
	return (
		<FadeUp
			className={cn(
				"flex flex-col items-center justify-center rounded-lg border border-hairline border-dashed bg-surface/40 px-6 py-14 text-center",
				className,
			)}
		>
			<span className="mb-4 grid size-11 place-items-center rounded-md border border-hairline bg-surface-card">
				<Icon className="size-5 text-ash" />
			</span>
			<p className="font-medium text-[16px] text-ink tracking-[0.2px]">
				{title}
			</p>
			{description ? (
				<p className="mt-1.5 max-w-sm text-[14px] text-mute leading-[1.6]">
					{description}
				</p>
			) : null}
			{action ? <div className="mt-5">{action}</div> : null}
		</FadeUp>
	);
}

export function ErrorState({
	error,
	onRetry,
	title = "Could not load this view",
	className,
}: {
	error: unknown;
	onRetry?: () => void;
	title?: string;
	className?: string;
}) {
	const id = requestId(error);
	return (
		<FadeUp
			role="alert"
			className={cn(
				"flex flex-col items-center justify-center rounded-lg border border-hairline bg-surface px-6 py-12 text-center",
				className,
			)}
		>
			<span className="mb-4 grid size-11 place-items-center rounded-md bg-accent-red-soft">
				<AlertTriangle className="size-5 text-accent-red" />
			</span>
			<p className="font-medium text-[16px] text-ink tracking-[0.2px]">
				{title}
			</p>
			<p className="mt-1.5 max-w-md text-[14px] text-mute leading-[1.6]">
				{safeErrorMessage(error)}
			</p>
			{id ? (
				<p className="mt-2 font-mono text-[12px] text-stone">Request {id}</p>
			) : null}
			{onRetry ? (
				<Button
					variant="tertiary"
					size="sm"
					className="mt-5"
					onClick={onRetry}
					type="button"
				>
					<RefreshCw className="size-3.5" />
					Try again
				</Button>
			) : null}
		</FadeUp>
	);
}

export function ListSkeleton({
	rows = 4,
	className,
}: {
	rows?: number;
	className?: string;
}) {
	return (
		<div className={cn("space-y-3", className)} aria-busy>
			{Array.from({ length: rows }, (_, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
					key={index}
					className="flex items-center gap-4 rounded-lg border border-hairline bg-surface px-4 py-4"
				>
					<Skeleton className="size-10 rounded-md" />
					<div className="flex-1 space-y-2">
						<Skeleton className="h-3.5 w-2/5" />
						<Skeleton className="h-3 w-1/4" />
					</div>
					<Skeleton className="h-6 w-20 rounded-xs" />
				</div>
			))}
		</div>
	);
}

export function CardGridSkeleton({
	cards = 3,
	className,
}: {
	cards?: number;
	className?: string;
}) {
	return (
		<div
			className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}
			aria-busy
		>
			{Array.from({ length: cards }, (_, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
					key={index}
					className="space-y-3 rounded-lg border border-hairline bg-surface p-6"
				>
					<Skeleton className="h-3 w-24" />
					<Skeleton className="h-7 w-16" />
					<Skeleton className="h-3 w-32" />
				</div>
			))}
		</div>
	);
}
