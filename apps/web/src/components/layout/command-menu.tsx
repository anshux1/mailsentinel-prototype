"use client";

import { useQuery } from "@tanstack/react-query";
import {
	FolderClosed,
	LogOut,
	Plus,
	Search,
	Upload,
	Waypoints,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Keycap } from "@/components/brand/keycap";
import { WORKSPACE_NAV } from "@/components/layout/nav-items";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
	CommandShortcut,
} from "@/components/ui/command";
import { useSignOut } from "@/features/auth/use-session";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/**
 * The command palette is the brand's signature surface — the same interaction
 * the design system is modelled on, wired to real workspace navigation.
 */
export function CommandMenu({
	open,
	onOpenChange,
	organizationReady,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organizationReady: boolean;
}) {
	const router = useRouter();
	const signOut = useSignOut();
	const [search, setSearch] = useState("");

	// Cases are only fetched while the palette is open — it is a search surface,
	// not a background subscription.
	const cases = useQuery({
		...orpc.case.list.queryOptions({ input: { limit: 20 } }),
		enabled: open && organizationReady,
		staleTime: 15_000,
	});

	// Closing always clears the query, so the palette reopens fresh.
	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (!next) setSearch("");
			onOpenChange(next);
		},
		[onOpenChange],
	);

	const run = useCallback(
		(action: () => void) => {
			handleOpenChange(false);
			action();
		},
		[handleOpenChange],
	);

	const matchedCases = (cases.data?.items ?? []).filter((item) =>
		search.trim().length === 0
			? true
			: item.title.toLowerCase().includes(search.toLowerCase()),
	);

	return (
		<CommandDialog
			open={open}
			onOpenChange={handleOpenChange}
			title="Command palette"
			description="Jump to a page, a case, or an action."
			className="sm:max-w-xl"
		>
			<CommandInput
				placeholder="Search cases, pages, and actions…"
				value={search}
				onValueChange={setSearch}
			/>
			<CommandList className="max-h-[22rem]">
				<CommandEmpty>No matches in this organization.</CommandEmpty>

				<CommandGroup heading="Go to">
					{WORKSPACE_NAV.map((item) => (
						<CommandItem
							key={item.href}
							value={`go ${item.label} ${item.description}`}
							onSelect={() => run(() => router.push(item.href))}
						>
							<item.icon className="size-4 text-mute" />
							<span>{item.label}</span>
							<span className="ml-auto hidden text-[12px] text-stone sm:inline">
								{item.description}
							</span>
						</CommandItem>
					))}
				</CommandGroup>

				<CommandSeparator />

				<CommandGroup heading="Actions">
					<CommandItem
						value="create new case investigation"
						onSelect={() => run(() => router.push("/cases?new=1"))}
					>
						<Plus className="size-4 text-mute" />
						<span>New case</span>
						<CommandShortcut>
							<Keycap>C</Keycap>
						</CommandShortcut>
					</CommandItem>
					<CommandItem
						value="upload evidence eml message"
						onSelect={() => run(() => router.push("/cases"))}
					>
						<Upload className="size-4 text-mute" />
						<span>Upload evidence</span>
					</CommandItem>
					<CommandItem
						value="analysis runs queue"
						onSelect={() => run(() => router.push("/analysis"))}
					>
						<Waypoints className="size-4 text-mute" />
						<span>Review analysis runs</span>
					</CommandItem>
					<CommandItem
						value="sign out log out"
						onSelect={() => run(() => void signOut())}
					>
						<LogOut className="size-4 text-mute" />
						<span>Sign out</span>
					</CommandItem>
				</CommandGroup>

				{matchedCases.length > 0 ? (
					<>
						<CommandSeparator />
						<CommandGroup heading="Cases">
							{matchedCases.slice(0, 8).map((item) => (
								<CommandItem
									key={item.id}
									value={`case ${item.title} ${item.id}`}
									onSelect={() => run(() => router.push(`/cases/${item.id}`))}
								>
									<FolderClosed className="size-4 text-mute" />
									<span className="truncate">{item.title}</span>
								</CommandItem>
							))}
						</CommandGroup>
					</>
				) : null}
			</CommandList>
		</CommandDialog>
	);
}

/** Topbar affordance that opens the palette and advertises its shortcut. */
export function CommandMenuTrigger({
	onOpen,
	className,
}: {
	onOpen: () => void;
	className?: string;
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			className={cn(
				"group flex h-9 items-center gap-2 rounded-md border border-hairline bg-surface-elevated px-3 text-left",
				"text-[14px] text-ash transition-colors duration-150 hover:border-hairline-strong hover:text-mute",
				className,
			)}
		>
			<Search className="size-4 shrink-0" />
			<span className="flex-1 truncate">Search…</span>
			<Keycap className="hidden sm:inline-flex">⌘K</Keycap>
		</button>
	);
}

/** Registers the ⌘K / Ctrl-K binding for the palette. */
export function useCommandMenu() {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key.toLowerCase() !== "k") return;
			if (!event.metaKey && !event.ctrlKey) return;
			event.preventDefault();
			setOpen((previous) => !previous);
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	return { open, setOpen };
}
