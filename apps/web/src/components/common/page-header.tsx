import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { FadeUp } from "@/components/common/motion";
import { cn } from "@/lib/utils";

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({
	items,
	className,
}: {
	items: Crumb[];
	className?: string;
}) {
	return (
		<nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
			<ol className="flex flex-wrap items-center gap-1.5 text-[13px] text-mute">
				{items.map((item, index) => {
					const isLast = index === items.length - 1;
					return (
						<li key={item.label} className="flex min-w-0 items-center gap-1.5">
							{index > 0 ? (
								<ChevronRight className="size-3.5 shrink-0 text-stone" />
							) : null}
							{item.href && !isLast ? (
								<Link
									href={item.href}
									className="truncate transition-colors hover:text-on-dark"
								>
									{item.label}
								</Link>
							) : (
								<span
									className={cn("truncate", isLast && "text-body")}
									aria-current={isLast ? "page" : undefined}
								>
									{item.label}
								</span>
							)}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

export function PageHeader({
	title,
	description,
	breadcrumbs,
	actions,
	meta,
	className,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	breadcrumbs?: Crumb[];
	actions?: React.ReactNode;
	meta?: React.ReactNode;
	className?: string;
}) {
	return (
		<FadeUp className={cn("space-y-4", className)}>
			{breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} /> : null}
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-2">
					<h1 className="font-medium text-[24px] text-ink leading-[1.3] tracking-[0.2px]">
						{title}
					</h1>
					{description ? (
						<p className="max-w-2xl text-[14px] text-mute leading-[1.6]">
							{description}
						</p>
					) : null}
					{meta ? (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
							{meta}
						</div>
					) : null}
				</div>
				{actions ? (
					<div className="flex shrink-0 flex-wrap items-center gap-2">
						{actions}
					</div>
				) : null}
			</div>
		</FadeUp>
	);
}
