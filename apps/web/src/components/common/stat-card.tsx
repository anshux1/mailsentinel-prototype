import type { LucideIcon } from "lucide-react";

import { StaggerItem } from "@/components/common/motion";
import { cn } from "@/lib/utils";

export function StatCard({
	label,
	value,
	hint,
	icon: Icon,
	className,
}: {
	label: string;
	value: React.ReactNode;
	hint?: React.ReactNode;
	icon?: LucideIcon;
	className?: string;
}) {
	return (
		<StaggerItem
			className={cn(
				"rounded-lg border border-hairline bg-surface p-6 transition-colors duration-200 hover:border-hairline-strong",
				className,
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<p className="text-[12px] text-ash uppercase tracking-[0.4px]">
					{label}
				</p>
				{Icon ? <Icon className="size-4 shrink-0 text-stone" /> : null}
			</div>
			<p className="mt-3 font-display font-medium text-[28px] text-ink leading-none tabular-nums">
				{value}
			</p>
			{hint ? (
				<div className="mt-2 text-[13px] text-mute leading-[1.5]">{hint}</div>
			) : null}
		</StaggerItem>
	);
}
