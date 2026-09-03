"use client";

import { Building2, Check, ChevronsUpDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganizations } from "@/features/organization/use-organizations";
import { cn } from "@/lib/utils";

export function OrganizationSwitcher({ className }: { className?: string }) {
	const { organizations, activeOrganization, setActive, isLoading } =
		useOrganizations();

	if (isLoading) {
		return <Skeleton className={cn("h-9 w-44 rounded-md", className)} />;
	}

	if (!activeOrganization) return null;

	const soleMembership = organizations.length <= 1;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={soleMembership}>
				<Button
					variant="tertiary"
					size="default"
					className={cn("max-w-[16rem] justify-between gap-2", className)}
					aria-label="Active organization"
				>
					<span className="flex min-w-0 items-center gap-2">
						<Building2 className="size-4 shrink-0 text-mute" />
						<span className="truncate">{activeOrganization.name}</span>
					</span>
					{soleMembership ? null : (
						<ChevronsUpDown className="size-3.5 shrink-0 text-ash" />
					)}
				</Button>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel>Organizations</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{organizations.map((organization) => {
					const isActive =
						organization.organizationId === activeOrganization.organizationId;
					return (
						<DropdownMenuItem
							key={organization.organizationId}
							onSelect={() => setActive(organization.organizationId)}
							className="gap-2"
						>
							<Check
								className={cn(
									"size-3.5 shrink-0",
									isActive ? "opacity-100" : "opacity-0",
								)}
							/>
							<span className="min-w-0 flex-1 truncate">
								{organization.name}
							</span>
							<Badge variant="outline" className="capitalize">
								{organization.role}
							</Badge>
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
