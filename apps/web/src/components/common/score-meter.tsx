"use client";

import { motion, useReducedMotion } from "motion/react";

import { brandEase } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Band = { label: string; text: string; track: string };

function bandFor(score: number): Band {
	if (score >= 70)
		return {
			label: "High risk",
			text: "text-accent-red",
			track: "bg-accent-red",
		};
	if (score >= 40)
		return {
			label: "Elevated risk",
			text: "text-accent-yellow",
			track: "bg-accent-yellow",
		};
	return {
		label: "Low risk",
		text: "text-accent-green",
		track: "bg-accent-green",
	};
}

/**
 * Risk is always shown with its 0–100 scale and its band label, never as a bare
 * coloured number — the score has to stay explainable at a glance.
 */
export function ScoreMeter({
	score,
	confidence,
	className,
	size = "default",
}: {
	score: number;
	confidence?: number;
	className?: string;
	size?: "default" | "sm";
}) {
	const reduceMotion = useReducedMotion();
	const clamped = Math.max(0, Math.min(100, Math.round(score)));
	const band = bandFor(clamped);

	return (
		<div className={cn("space-y-2", className)}>
			<div className="flex items-baseline justify-between gap-4">
				<div className="flex items-baseline gap-1.5">
					<span
						className={cn(
							"font-display font-medium text-ink tabular-nums",
							size === "default" ? "text-[40px] leading-none" : "text-[24px]",
						)}
					>
						{clamped}
					</span>
					<span className="text-[13px] text-ash">/ 100</span>
				</div>
				<span className={cn("text-[12px] tracking-[0.4px]", band.text)}>
					{band.label}
				</span>
			</div>

			{/* biome-ignore lint/a11y/useSemanticElements: no HTML element maps to role="meter" with a custom animated track */}
			<div
				className="h-1 w-full overflow-hidden rounded-full bg-surface-card"
				role="meter"
				aria-valuenow={clamped}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label={`Risk score ${clamped} of 100, ${band.label}`}
			>
				<motion.div
					className={cn("h-full rounded-full", band.track)}
					initial={{ width: reduceMotion ? `${clamped}%` : 0 }}
					animate={{ width: `${clamped}%` }}
					transition={{ duration: 0.7, ease: brandEase }}
				/>
			</div>

			{confidence !== undefined ? (
				<p className="text-[12px] text-ash tracking-[0.4px]">
					Confidence {Math.round(confidence * 100)}%
				</p>
			) : null}
		</div>
	);
}
