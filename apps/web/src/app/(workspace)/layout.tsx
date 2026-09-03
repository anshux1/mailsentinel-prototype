import { AppShell } from "@/components/layout/app-shell";

/**
 * Session-gated chrome shared by every workspace route. The group has no URL
 * segment of its own, so it takes plain `children` rather than a route literal.
 */
export default function WorkspaceLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <AppShell>{children}</AppShell>;
}
