"use client";

import { Search } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { Keycap } from "@/components/brand/keycap";
import { brandEase } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Row = {
	id: string;
	label: string;
	detail: string;
	tint: string;
	glyph: string;
	shortcut?: string;
};

const ROWS: Row[] = [
	{
		id: "verdict",
		label: "Q4-invoice-notice.eml",
		detail: "Malicious · 88",
		tint: "bg-accent-red-soft text-accent-red",
		glyph: "!",
		shortcut: "⏎",
	},
	{
		id: "auth",
		label: "SPF pass · DKIM fail · DMARC fail",
		detail: "Reported headers",
		tint: "bg-accent-yellow-soft text-accent-yellow",
		glyph: "@",
	},
	{
		id: "routing",
		label: "Private → public hop at position 3",
		detail: "Routing anomaly",
		tint: "bg-accent-blue-soft text-accent-blue",
		glyph: "↗",
	},
	{
		id: "link",
		label: "Display text does not match href target",
		detail: "Content indicator",
		tint: "bg-accent-green-soft text-accent-green",
		glyph: "#",
	},
];

/**
 * The load-bearing hero visual: the product's own command-palette chrome,
 * rendered rather than screenshotted so it stays sharp and responsive.
 */
export function CommandPaletteMock({ className }: { className?: string }) {
	const reduceMotion = useReducedMotion();

	return (
		<div
			className={cn(
				"overflow-hidden rounded-xl border border-hairline bg-surface",
				className,
			)}
			aria-hidden
		>
			<div className="flex items-center gap-2 border-hairline border-b px-4 py-3">
				<span className="flex gap-1.5">
					<span className="size-2.5 rounded-full bg-stone" />
					<span className="size-2.5 rounded-full bg-stone" />
					<span className="size-2.5 rounded-full bg-stone" />
				</span>
				<span className="ml-2 text-[12px] text-ash tracking-[0.4px]">
					MailSentinel · case CASE-2291
				</span>
			</div>

			<div className="flex items-center gap-2.5 border-hairline border-b px-4 py-3">
				<Search className="size-4 shrink-0 text-ash" />
				<span className="flex-1 text-[16px] text-mute">
					Why was this message flagged?
				</span>
				<Keycap>⌘K</Keycap>
			</div>

			<div className="space-y-0.5 p-2">
				{ROWS.map((row, index) => (
					<motion.div
						key={row.id}
						initial={reduceMotion ? undefined : { opacity: 0, x: -6 }}
						animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
						transition={{
							delay: 0.25 + index * 0.09,
							duration: 0.4,
							ease: brandEase,
						}}
						className={cn(
							"flex items-center gap-3 rounded-sm px-2.5 py-2",
							index === 0 && "bg-surface-card",
						)}
					>
						<span
							className={cn(
								"grid size-8 shrink-0 place-items-center rounded-md font-medium text-[13px]",
								row.tint,
							)}
						>
							{row.glyph}
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[14px] text-on-dark">
								{row.label}
							</span>
							<span className="block truncate text-[12px] text-ash tracking-[0.4px]">
								{row.detail}
							</span>
						</span>
						{row.shortcut ? <Keycap>{row.shortcut}</Keycap> : null}
					</motion.div>
				))}
			</div>

			<div className="flex items-center justify-between border-hairline border-t px-4 py-2.5">
				<span className="text-[12px] text-ash tracking-[0.4px]">
					Ruleset v1.1.0 · deterministic
				</span>
				<span className="flex items-center gap-1.5 text-[12px] text-ash">
					Open report <Keycap>⏎</Keycap>
				</span>
			</div>
		</div>
	);
}
