import {
	FileText,
	FolderClosed,
	LayoutDashboard,
	type LucideIcon,
	Settings,
	Waypoints,
} from "lucide-react";

export type NavItem = {
	href: string;
	label: string;
	icon: LucideIcon;
	description: string;
};

export const WORKSPACE_NAV: NavItem[] = [
	{
		href: "/dashboard",
		label: "Dashboard",
		icon: LayoutDashboard,
		description: "Workspace activity at a glance",
	},
	{
		href: "/cases",
		label: "Cases",
		icon: FolderClosed,
		description: "Investigations and their evidence",
	},
	{
		href: "/analysis",
		label: "Analysis",
		icon: Waypoints,
		description: "Every analysis run in this organization",
	},
	{
		href: "/reports",
		label: "Reports",
		icon: FileText,
		description: "Immutable forensic reports",
	},
	{
		href: "/settings",
		label: "Settings",
		icon: Settings,
		description: "Organization, role, and session",
	},
];

export function isNavItemActive(pathname: string, href: string): boolean {
	return pathname === href || pathname.startsWith(`${href}/`);
}
