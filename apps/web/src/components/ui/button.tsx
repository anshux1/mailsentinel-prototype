import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * DESIGN.md `button-*`: 14px/500 label, 8px radius, 36px default height.
 * White is the only primary — elevation comes from the surface ladder, never
 * from shadows.
 */
const buttonVariants = cva(
	[
		"group/button relative inline-flex shrink-0 select-none items-center justify-center gap-2",
		"rounded-md border border-transparent whitespace-nowrap",
		"text-[14px] font-medium leading-[1.6] tracking-[0.2px]",
		"transition-[background-color,border-color,color,opacity] duration-150 ease-brand outline-none",
		"focus-visible:outline focus-visible:outline-1 focus-visible:outline-hairline-strong focus-visible:outline-offset-2",
		"disabled:pointer-events-none disabled:bg-surface-elevated disabled:text-ash",
		"aria-disabled:pointer-events-none aria-disabled:bg-surface-elevated aria-disabled:text-ash",
		"[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	],
	{
		variants: {
			variant: {
				/** `button-primary` — the universal white CTA. */
				primary:
					"bg-primary text-primary-foreground hover:bg-[#f2f2f2] active:bg-[#e8e8e8]",
				/** `button-secondary` — transparent text button. */
				secondary:
					"bg-transparent text-on-dark hover:bg-surface-elevated active:bg-surface-card",
				/** `button-tertiary` — soft surface button. */
				tertiary:
					"bg-surface-elevated text-on-dark hover:bg-surface-card active:bg-surface",
				/** `install-button` — hairline-outlined pill used on list rows. */
				outline:
					"border-hairline-strong bg-transparent text-on-dark hover:bg-surface-elevated active:bg-surface-card",
				ghost:
					"bg-transparent text-body hover:bg-surface-elevated hover:text-on-dark active:bg-surface-card",
				destructive:
					"bg-accent-red-soft text-accent-red hover:bg-[rgba(255,97,97,0.22)] active:bg-[rgba(255,97,97,0.28)]",
				link: "h-auto bg-transparent p-0 text-on-dark underline-offset-4 hover:underline",
			},
			size: {
				xs: "h-7 rounded-sm px-2.5 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
				sm: "h-8 px-3",
				default: "h-9 px-4",
				lg: "h-11 px-5 text-[16px]",
				icon: "size-9 p-0",
				"icon-sm": "size-8 p-0",
				"icon-xs":
					"size-7 rounded-sm p-0 [&_svg:not([class*='size-'])]:size-3.5",
			},
		},
		defaultVariants: {
			variant: "tertiary",
			size: "default",
		},
	},
);

function Button({
	className,
	variant,
	size,
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
	const Comp = asChild ? Slot.Root : "button";

	return (
		<Comp
			data-slot="button"
			data-variant={variant}
			data-size={size}
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
