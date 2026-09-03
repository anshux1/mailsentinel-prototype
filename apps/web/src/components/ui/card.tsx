import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * DESIGN.md `feature-card-dark` / `feature-card-elevated`: one surface notch
 * above the canvas, a single 1px hairline edge, 10px radius, 16-24px padding.
 * The system has no drop shadows — `tone` moves the card up the surface ladder
 * instead.
 */
function Card({
	className,
	tone = "surface",
	size = "default",
	...props
}: React.ComponentProps<"div"> & {
	tone?: "surface" | "elevated" | "flat";
	size?: "default" | "sm";
}) {
	return (
		<div
			data-slot="card"
			data-tone={tone}
			data-size={size}
			className={cn(
				"group/card flex flex-col gap-(--card-spacing) rounded-lg border border-hairline text-[14px] text-body",
				"py-(--card-spacing) [--card-spacing:--spacing(6)]",
				"data-[size=sm]:[--card-spacing:--spacing(4)]",
				tone === "surface" && "bg-surface",
				tone === "elevated" && "bg-surface-elevated",
				tone === "flat" && "bg-transparent",
				className,
			)}
			{...props}
		/>
	);
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-header"
			className={cn(
				"grid auto-rows-min items-start gap-1.5 px-(--card-spacing)",
				"has-data-[slot=card-action]:grid-cols-[1fr_auto]",
				"[.border-b]:border-hairline [.border-b]:pb-(--card-spacing)",
				className,
			)}
			{...props}
		/>
	);
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-title"
			className={cn(
				"font-medium text-[18px] leading-[1.4] tracking-[0.2px] text-ink",
				"group-data-[size=sm]/card:text-[16px]",
				className,
			)}
			{...props}
		/>
	);
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-description"
			className={cn("text-[14px] leading-[1.6] text-mute", className)}
			{...props}
		/>
	);
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-action"
			className={cn(
				"col-start-2 row-span-2 row-start-1 self-start justify-self-end",
				className,
			)}
			{...props}
		/>
	);
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-content"
			className={cn("px-(--card-spacing)", className)}
			{...props}
		/>
	);
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-footer"
			className={cn(
				"flex items-center gap-3 border-hairline border-t px-(--card-spacing) pt-(--card-spacing)",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
};
