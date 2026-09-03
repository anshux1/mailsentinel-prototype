"use client";

import { LogOut, Settings, UserRound } from "lucide-react";
import Link from "next/link";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { initialsOf, useSignOut } from "@/features/auth/use-session";
import type { MembershipRole } from "@/lib/permissions";

export function UserMenu({
	name,
	email,
	role,
}: {
	name?: string | null;
	email?: string | null;
	role: MembershipRole | null;
}) {
	const signOut = useSignOut();
	const label = name || email || "Account";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="rounded-full"
					aria-label="Account menu"
				>
					<Avatar className="size-7">
						<AvatarFallback className="bg-surface-card text-[12px] text-body">
							{initialsOf(name ?? email)}
						</AvatarFallback>
					</Avatar>
				</Button>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="end" className="w-64">
				<div className="flex items-start gap-3 px-2 py-2">
					<Avatar className="size-8">
						<AvatarFallback className="bg-surface-card text-[12px] text-body">
							{initialsOf(name ?? email)}
						</AvatarFallback>
					</Avatar>
					<div className="min-w-0 flex-1">
						<p className="truncate font-medium text-[14px] text-ink">{label}</p>
						{email && email !== label ? (
							<p className="truncate text-[12px] text-mute">{email}</p>
						) : null}
						{role ? (
							<Badge variant="outline" className="mt-1.5 capitalize">
								{role}
							</Badge>
						) : null}
					</div>
				</div>

				<DropdownMenuSeparator />

				<DropdownMenuItem asChild>
					<Link href="/settings">
						<Settings className="size-4 text-mute" />
						Settings
					</Link>
				</DropdownMenuItem>
				<DropdownMenuItem asChild>
					<Link href="/settings#session">
						<UserRound className="size-4 text-mute" />
						Session details
					</Link>
				</DropdownMenuItem>

				<DropdownMenuSeparator />

				<DropdownMenuItem onSelect={() => void signOut()}>
					<LogOut className="size-4 text-mute" />
					Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
