import { cn } from "@/lib/utils";

/**
 * DESIGN.md `keycap`: 4px radius, 20px tall, a faint #121212 → #0d0d0d
 * gradient that suggests a physical key surface. The system's only "depth"
 * decoration.
 */
export function Keycap({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<kbd
			className={cn(
				"keycap-surface inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-xs border border-hairline px-1.5",
				"font-sans text-[13px] text-body leading-none tracking-[0.1px]",
				className,
			)}
		>
			{children}
		</kbd>
	);
}

export function KeycapCluster({
	keys,
	className,
}: {
	keys: string[];
	className?: string;
}) {
	return (
		<span className={cn("inline-flex items-center gap-1", className)}>
			{keys.map((key) => (
				<Keycap key={key}>{key}</Keycap>
			))}
		</span>
	);
}
