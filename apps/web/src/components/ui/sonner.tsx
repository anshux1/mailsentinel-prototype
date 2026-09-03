"use client";

import {
	CircleCheckIcon,
	InfoIcon,
	Loader2Icon,
	OctagonXIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toasts sit on `surface-elevated` with a hairline edge, like every other
 * overlay in the system. The theme is pinned dark — there is no light variant.
 */
function Toaster(props: ToasterProps) {
	return (
		<Sonner
			theme="dark"
			className="toaster group"
			position="bottom-right"
			offset={20}
			icons={{
				success: <CircleCheckIcon className="size-4 text-accent-green" />,
				info: <InfoIcon className="size-4 text-accent-blue" />,
				warning: <TriangleAlertIcon className="size-4 text-accent-yellow" />,
				error: <OctagonXIcon className="size-4 text-accent-red" />,
				loading: <Loader2Icon className="size-4 animate-spin text-mute" />,
			}}
			style={
				{
					"--normal-bg": "var(--color-surface-elevated)",
					"--normal-text": "var(--color-ink)",
					"--normal-border": "var(--color-hairline)",
					"--border-radius": "8px",
				} as React.CSSProperties
			}
			toastOptions={{
				classNames: {
					toast:
						"cn-toast !bg-surface-elevated !border-hairline !text-ink !text-[14px] !rounded-md",
					description: "!text-mute !text-[13px]",
					actionButton: "!bg-primary !text-primary-foreground !rounded-md",
					cancelButton: "!bg-surface-card !text-body !rounded-md",
				},
			}}
			{...props}
		/>
	);
}

export { Toaster };
