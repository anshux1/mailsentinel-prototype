import type * as React from "react";

import { cn } from "@/lib/utils";

/** DESIGN.md `text-input`, multi-line variant. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"flex field-sizing-content min-h-20 w-full rounded-md border border-hairline bg-surface-elevated px-3 py-2",
				"text-[14px] leading-[1.6] text-on-dark placeholder:text-ash",
				"transition-colors duration-150 ease-brand outline-none",
				"focus-visible:border-hairline-strong",
				"disabled:pointer-events-none disabled:text-ash disabled:opacity-60",
				"aria-invalid:border-accent-red/60",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
