import { cn } from "@/lib/utils";

/** Loading placeholder that sits one notch up the surface ladder. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="skeleton"
			className={cn("animate-pulse rounded-sm bg-surface-elevated", className)}
			{...props}
		/>
	);
}

export { Skeleton };
