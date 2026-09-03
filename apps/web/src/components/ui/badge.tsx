import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * DESIGN.md `badge-pro` / `badge-info-soft`: 12px/400 caption, 4px radius,
 * tight 2px×6-8px padding. Saturated accents stay inside soft-tinted chips —
 * they never colour chrome buttons or body text.
 */
const badgeVariants = cva(
	[
		"inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden",
		"rounded-xs border border-transparent px-2 py-0.5",
		"text-[12px] font-normal leading-[1.5] tracking-[0.4px] whitespace-nowrap",
		"transition-colors duration-150 ease-brand",
		"[&>svg]:pointer-events-none [&>svg]:size-3",
	],
	{
		variants: {
			variant: {
				/** `badge-pro` — neutral tier / metadata chip. */
				default: "bg-surface-elevated text-on-dark-mute",
				outline: "border-hairline bg-transparent text-mute",
				solid: "bg-primary text-primary-foreground",
				/** `badge-info-soft` and its semantic siblings. */
				info: "bg-accent-blue-soft text-accent-blue",
				success: "bg-accent-green-soft text-accent-green",
				warning: "bg-accent-yellow-soft text-accent-yellow",
				danger: "bg-accent-red-soft text-accent-red",
			},
		},
		defaultVariants: { variant: "default" },
	},
);

function Badge({
	className,
	variant,
	asChild = false,
	...props
}: React.ComponentProps<"span"> &
	VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
	const Comp = asChild ? Slot.Root : "span";

	return (
		<Comp
			data-slot="badge"
			data-variant={variant}
			className={cn(badgeVariants({ variant }), className)}
			{...props}
		/>
	);
}

export { Badge, badgeVariants };
