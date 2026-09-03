import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * DESIGN.md `text-input` / `store-search-bar`: surface-elevated fill with a
 * hairline edge that brightens to `hairline-strong` on focus — a subtle
 * brightening rather than a coloured ring.
 */
const inputVariants = cva(
	[
		"w-full min-w-0 rounded-md border border-hairline bg-surface-elevated",
		"text-[16px] leading-[1.6] text-on-dark placeholder:text-ash",
		"transition-colors duration-150 ease-brand outline-none",
		"focus-visible:border-hairline-strong focus-visible:outline-none",
		"disabled:pointer-events-none disabled:text-ash disabled:opacity-60",
		"aria-invalid:border-accent-red/60",
		"file:mr-3 file:h-full file:border-0 file:bg-transparent file:text-[14px] file:font-medium file:text-on-dark",
	],
	{
		variants: {
			inputSize: {
				sm: "h-8 px-2.5 text-[14px]",
				default: "h-9 px-3 text-[14px]",
				/** `store-search-bar` — 44px, one step above AA. */
				lg: "h-11 px-4 text-[16px]",
			},
		},
		defaultVariants: { inputSize: "default" },
	},
);

function Input({
	className,
	type,
	inputSize,
	...props
}: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(inputVariants({ inputSize }), className)}
			{...props}
		/>
	);
}

export { Input, inputVariants };
