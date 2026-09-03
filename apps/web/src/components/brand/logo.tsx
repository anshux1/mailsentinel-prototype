import { cn } from "@/lib/utils";

/**
 * The mark is a shield cut from the surface ladder with a single hairline edge
 * — the same vocabulary as every card in the system.
 */
export function LogoMark({ className }: { className?: string }) {
	return (
		<span
			aria-hidden
			className={cn(
				"inline-grid size-7 shrink-0 place-items-center rounded-md border border-hairline bg-surface-card",
				className,
			)}
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				className="size-4 text-ink"
				role="presentation"
			>
				<title>MailSentinel</title>
				<path
					d="M12 2.75 4.75 5.6v5.65c0 4.34 2.9 8.36 7.25 9.99 4.35-1.63 7.25-5.65 7.25-9.99V5.6Z"
					stroke="currentColor"
					strokeWidth="1.4"
					strokeLinejoin="round"
				/>
				<path
					d="M8.4 9.6h7.2v5.1H8.4z"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinejoin="round"
				/>
				<path
					d="m8.4 9.9 3.6 2.7 3.6-2.7"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		</span>
	);
}

export function Logo({
	className,
	showWordmark = true,
}: {
	className?: string;
	showWordmark?: boolean;
}) {
	return (
		<span className={cn("inline-flex items-center gap-2.5", className)}>
			<LogoMark />
			{showWordmark ? (
				<span className="font-medium text-[15px] text-ink tracking-[0.2px]">
					MailSentinel
				</span>
			) : null}
		</span>
	);
}
