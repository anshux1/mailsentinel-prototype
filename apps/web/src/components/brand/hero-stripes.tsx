import { cn } from "@/lib/utils";

/**
 * The signature launch-banner motif: three diagonal red stripes washed across
 * the top of the hero. DESIGN.md allows this exactly once per page and nowhere
 * below the first band.
 */
export function HeroStripes({ className }: { className?: string }) {
	return (
		<div
			aria-hidden
			className={cn(
				"pointer-events-none absolute inset-x-0 top-0 h-[420px] overflow-hidden",
				className,
			)}
		>
			<div className="hero-stripes absolute inset-x-[-20%] top-[-160px] h-[520px]" />
			<div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-canvas" />
		</div>
	);
}
