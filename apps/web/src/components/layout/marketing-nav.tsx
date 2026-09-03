"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { useSession } from "@/features/auth/use-session";

const LINKS = [
	{ href: "#pipeline", label: "Pipeline" },
	{ href: "#evidence", label: "Evidence" },
	{ href: "#explainability", label: "Explainability" },
	{ href: "#boundaries", label: "Boundaries" },
];

export function MarketingNav() {
	const { session, isPending } = useSession();
	const [open, setOpen] = useState(false);
	const workspaceHref = session ? "/dashboard" : "/sign-in";

	return (
		<header className="sticky top-0 z-40 border-hairline border-b bg-canvas">
			<div className="mx-auto flex h-14 max-w-[1240px] items-center gap-4 px-4 sm:px-6">
				<Link href="/" aria-label="MailSentinel home">
					<Logo />
				</Link>

				<nav className="mx-auto hidden items-center gap-1 md:flex">
					{LINKS.map((link) => (
						<a
							key={link.href}
							href={link.href}
							className="rounded-sm px-3 py-1.5 font-medium text-[14px] text-mute tracking-[0.2px] transition-colors duration-150 hover:bg-surface-elevated hover:text-on-dark"
						>
							{link.label}
						</a>
					))}
				</nav>

				<div className="ml-auto flex items-center gap-2 md:ml-0">
					{!isPending && !session ? (
						<Button
							asChild
							variant="secondary"
							size="sm"
							className="hidden sm:inline-flex"
						>
							<Link href="/sign-in">Sign in</Link>
						</Button>
					) : null}
					<Button asChild variant="primary" size="sm">
						<Link href={workspaceHref}>
							{session ? "Open workspace" : "Get started"}
						</Link>
					</Button>

					<Sheet open={open} onOpenChange={setOpen}>
						<SheetTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								className="md:hidden"
								aria-label="Open menu"
							>
								<Menu className="size-4" />
							</Button>
						</SheetTrigger>
						<SheetContent side="left" className="w-72">
							<SheetHeader>
								<SheetTitle className="text-left">
									<Logo />
								</SheetTitle>
							</SheetHeader>
							<nav className="space-y-1 px-4">
								{LINKS.map((link) => (
									<a
										key={link.href}
										href={link.href}
										onClick={() => setOpen(false)}
										className="block rounded-sm px-2.5 py-2 text-[14px] text-mute transition-colors hover:bg-surface-elevated hover:text-on-dark"
									>
										{link.label}
									</a>
								))}
								<Link
									href="/sign-in"
									onClick={() => setOpen(false)}
									className="block rounded-sm px-2.5 py-2 text-[14px] text-mute transition-colors hover:bg-surface-elevated hover:text-on-dark"
								>
									Sign in
								</Link>
							</nav>
						</SheetContent>
					</Sheet>
				</div>
			</div>
		</header>
	);
}
