"use client";

import { Menu, ShieldAlert } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Logo } from "@/components/brand/logo";
import { EmptyState, ErrorState } from "@/components/common/states";
import {
	CommandMenu,
	CommandMenuTrigger,
	useCommandMenu,
} from "@/components/layout/command-menu";
import { isNavItemActive, WORKSPACE_NAV } from "@/components/layout/nav-items";
import { UserMenu } from "@/components/layout/user-menu";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/features/auth/use-session";
import { OrganizationSwitcher } from "@/features/organization/organization-switcher";
import { useOrganizations } from "@/features/organization/use-organizations";
import { brandEase } from "@/lib/motion";
import { cn } from "@/lib/utils";

function NavLinks({
	pathname,
	onNavigate,
}: {
	pathname: string;
	onNavigate?: () => void;
}) {
	return (
		<nav className="space-y-0.5">
			{WORKSPACE_NAV.map((item) => {
				const active = isNavItemActive(pathname, item.href);
				return (
					<Link
						key={item.href}
						href={item.href}
						onClick={onNavigate}
						aria-current={active ? "page" : undefined}
						className={cn(
							"relative flex items-center gap-2.5 rounded-sm px-2.5 py-2",
							"text-[14px] leading-[1.6] transition-colors duration-150",
							active
								? "bg-surface-card text-on-dark"
								: "text-mute hover:bg-surface-elevated hover:text-body",
						)}
					>
						<item.icon className="size-4 shrink-0" />
						<span className="truncate">{item.label}</span>
					</Link>
				);
			})}
		</nav>
	);
}

function SidebarBody({
	pathname,
	onNavigate,
}: {
	pathname: string;
	onNavigate?: () => void;
}) {
	return (
		<div className="flex h-full flex-col gap-6">
			<NavLinks pathname={pathname} onNavigate={onNavigate} />
			<div className="mt-auto rounded-lg border border-hairline bg-surface p-4">
				<p className="font-medium text-[13px] text-ink tracking-[0.2px]">
					Evidence stays private
				</p>
				<p className="mt-1.5 text-[12px] text-mute leading-[1.5]">
					Messages are never rendered, links are never fetched, and object keys
					never reach the browser.
				</p>
			</div>
		</div>
	);
}

export function AppShell({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();
	const router = useRouter();
	const { session, isPending: sessionPending } = useSession();
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const commandMenu = useCommandMenu();

	const {
		activeOrganization,
		role,
		isLoading: organizationsLoading,
		isError: organizationsFailed,
		error: organizationsError,
		refetch: refetchOrganizations,
		hasNoMembership,
	} = useOrganizations({ enabled: Boolean(session) });

	// The workspace is session-gated; unauthenticated visitors go to sign-in.
	useEffect(() => {
		if (!sessionPending && !session) {
			router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
		}
	}, [session, sessionPending, router, pathname]);

	if (sessionPending || !session) {
		return <ShellFallback />;
	}

	return (
		<div className="flex min-h-screen flex-col">
			<header className="sticky top-0 z-40 border-hairline border-b bg-canvas">
				<div className="mx-auto flex h-14 max-w-[1240px] items-center gap-3 px-4 sm:px-6">
					<Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
						<SheetTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								className="lg:hidden"
								aria-label="Open navigation"
							>
								<Menu className="size-4" />
							</Button>
						</SheetTrigger>
						<SheetContent side="left" className="w-72 p-0">
							<SheetHeader className="border-hairline border-b">
								<SheetTitle className="text-left">
									<Logo />
								</SheetTitle>
							</SheetHeader>
							<div className="h-[calc(100%-3.5rem)] p-4">
								<SidebarBody
									pathname={pathname}
									onNavigate={() => setMobileNavOpen(false)}
								/>
							</div>
						</SheetContent>
					</Sheet>

					<Link
						href="/dashboard"
						className="shrink-0"
						aria-label="MailSentinel dashboard"
					>
						<Logo />
					</Link>

					<div className="ml-auto flex items-center gap-2">
						<CommandMenuTrigger
							onOpen={() => commandMenu.setOpen(true)}
							className="hidden w-56 md:flex xl:w-64"
						/>
						<OrganizationSwitcher className="hidden sm:flex" />
						<UserMenu
							name={session.user.name}
							email={session.user.email}
							role={role}
						/>
					</div>
				</div>
			</header>

			<div className="mx-auto flex w-full max-w-[1240px] flex-1 gap-8 px-4 sm:px-6">
				<aside className="hidden w-56 shrink-0 py-8 lg:block">
					<div className="sticky top-[5.5rem] h-[calc(100vh-7.5rem)]">
						<SidebarBody pathname={pathname} />
					</div>
				</aside>

				<main className="min-w-0 flex-1 py-8">
					{organizationsLoading ? (
						<WorkspaceLoading />
					) : organizationsFailed ? (
						<ErrorState
							error={organizationsError}
							onRetry={() => void refetchOrganizations()}
							title="Could not resolve your organizations"
						/>
					) : hasNoMembership || !activeOrganization ? (
						<EmptyState
							icon={ShieldAlert}
							title="No organization membership"
							description="This account is not a member of any organization yet. An owner needs to add you before you can open cases or evidence."
						/>
					) : (
						/*
						 * Entrance only. The App Router reconciles `children` in place
						 * rather than remounting per route, so an AnimatePresence exit
						 * would fade out the page that just arrived. Re-keying on the
						 * pathname replays the entrance instead.
						 */
						<motion.div
							key={pathname}
							initial={{ opacity: 0, y: 6 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.24, ease: brandEase }}
						>
							{children}
						</motion.div>
					)}
				</main>
			</div>

			<CommandMenu
				open={commandMenu.open}
				onOpenChange={commandMenu.setOpen}
				organizationReady={Boolean(activeOrganization)}
			/>
		</div>
	);
}

function WorkspaceLoading() {
	return (
		<div className="space-y-6" aria-busy>
			<Skeleton className="h-7 w-52" />
			<Skeleton className="h-4 w-80" />
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				{Array.from({ length: 4 }, (_, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
					<Skeleton key={index} className="h-28 rounded-lg" />
				))}
			</div>
			<Skeleton className="h-64 rounded-lg" />
		</div>
	);
}

function ShellFallback() {
	return (
		<div className="flex min-h-screen items-center justify-center px-6">
			<div className="flex items-center gap-3 text-[14px] text-mute">
				<span className="size-2 animate-pulse rounded-full bg-stone" />
				Opening workspace…
			</div>
		</div>
	);
}
