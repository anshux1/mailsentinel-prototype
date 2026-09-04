"use client";

import { Check, LogOut, Minus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { Field, FieldGrid } from "@/components/common/field";
import { Stagger, StaggerItem } from "@/components/common/motion";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useSession, useSignOut } from "@/features/auth/use-session";
import { MailboxConnections } from "@/features/mailbox/mailbox-connections";
import { mailboxOAuthErrorMessage } from "@/features/mailbox/oauth-result";
import { useOrganizations } from "@/features/organization/use-organizations";
import { titleCase } from "@/lib/format";
import {
	type MembershipRole,
	type Permission,
	ROLE_PERMISSIONS,
} from "@/lib/permissions";
import { cn } from "@/lib/utils";

const ROLES: MembershipRole[] = ["viewer", "investigator", "owner"];

const PERMISSIONS: Permission[] = [
	"cases:read",
	"cases:create",
	"evidence:read",
	"evidence:upload",
	"analysis:read",
	"analysis:start",
	"analysis:retry",
	"reports:read",
	"reports:generate",
	"retention:manage",
	"admin:manage",
	"mailbox:manage",
];

/**
 * The Gmail callback is a redirect handler, so it reports its outcome as a
 * query parameter here. The result is announced once and then stripped from the
 * URL, so a reload or a shared link does not replay a stale toast.
 */
function useMailboxOAuthResult() {
	const router = useRouter();
	const announced = useRef(false);

	useEffect(() => {
		if (announced.current) return;

		const params = new URLSearchParams(window.location.search);
		const connected = params.get("mailbox_connected");
		const error = params.get("error");
		if (!connected && !error) return;

		announced.current = true;

		if (connected === "true") {
			toast.success("Mailbox connected", {
				description: "Read-only Gmail access is ready to sync into a case.",
			});
		} else if (error) {
			toast.error("Mailbox not connected", {
				description: mailboxOAuthErrorMessage(error),
			});
		}

		router.replace("/settings");
	}, [router]);
}

export default function SettingsPage() {
	const { user } = useSession();
	const { organizations, activeOrganization, role, setActive } =
		useOrganizations();
	const signOut = useSignOut();

	useMailboxOAuthResult();

	return (
		<div className="space-y-10">
			<PageHeader
				title="Settings"
				description="Your session, the organizations you belong to, and what each role may do."
			/>

			<section id="session" className="space-y-4">
				<h2 className="font-medium text-[18px] text-ink tracking-[0.2px]">
					Session
				</h2>
				<div className="rounded-lg border border-hairline bg-surface p-6">
					<FieldGrid columns={3}>
						<Field label="Signed in as">{user?.name || "—"}</Field>
						<Field label="Email">{user?.email ?? "—"}</Field>
						<Field label="Active role">
							{role ? (
								<Badge variant="outline" className="capitalize">
									{role}
								</Badge>
							) : (
								"—"
							)}
						</Field>
					</FieldGrid>
					<div className="mt-6 border-hairline border-t pt-5">
						<Button variant="tertiary" onClick={() => void signOut()}>
							<LogOut className="size-4" />
							Sign out
						</Button>
					</div>
				</div>
			</section>

			<section className="space-y-4">
				<h2 className="font-medium text-[18px] text-ink tracking-[0.2px]">
					Organizations
				</h2>
				<p className="text-[14px] text-mute leading-[1.6]">
					Every request carries an explicit organization. There is no implicit
					fallback — switching here changes the tenant context for the whole
					workspace.
				</p>
				<Stagger className="space-y-3">
					{organizations.map((organization) => {
						const isActive =
							organization.organizationId ===
							activeOrganization?.organizationId;
						return (
							<StaggerItem key={organization.organizationId}>
								<div
									className={cn(
										"flex flex-col gap-3 rounded-lg border p-4 transition-colors duration-200 sm:flex-row sm:items-center",
										isActive
											? "border-hairline-strong bg-surface-elevated"
											: "border-hairline bg-surface",
									)}
								>
									<div className="min-w-0 flex-1">
										<p className="font-medium text-[15px] text-ink tracking-[0.2px]">
											{organization.name}
										</p>
										<p className="mt-1 font-mono text-[12px] text-mute">
											{organization.organizationId}
										</p>
									</div>
									<Badge variant="outline" className="capitalize">
										{organization.role}
									</Badge>
									{isActive ? (
										<Badge variant="success">Active</Badge>
									) : (
										<Button
											variant="tertiary"
											size="sm"
											onClick={() => setActive(organization.organizationId)}
										>
											Switch
										</Button>
									)}
								</div>
							</StaggerItem>
						);
					})}
				</Stagger>
			</section>

			<section id="mailbox" className="space-y-4">
				<h2 className="font-medium text-[18px] text-ink tracking-[0.2px]">
					Mailbox connectors
				</h2>
				<p className="text-[14px] text-mute leading-[1.6]">
					A connected mailbox pulls messages directly into a case as immutable
					evidence. Access is read-only, the refresh token is stored encrypted,
					and only an owner can connect or disconnect an account.
				</p>
				<MailboxConnections />
			</section>

			<section className="space-y-4">
				<h2 className="font-medium text-[18px] text-ink tracking-[0.2px]">
					Role permissions
				</h2>
				<p className="text-[14px] text-mute leading-[1.6]">
					The server enforces this table on every call. The interface only uses
					it to avoid offering an action that would be rejected.
				</p>
				<div className="overflow-x-auto rounded-lg border border-hairline">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="min-w-44">Permission</TableHead>
								{ROLES.map((entry) => (
									<TableHead key={entry} className="text-center capitalize">
										{entry}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{PERMISSIONS.map((permission) => (
								<TableRow key={permission}>
									<TableCell className="font-mono text-[13px] text-ink">
										{permission}
									</TableCell>
									{ROLES.map((entry) => {
										const granted =
											ROLE_PERMISSIONS[entry].includes(permission);
										return (
											<TableCell
												key={`${permission}-${entry}`}
												className="text-center"
											>
												{granted ? (
													<Check
														className="mx-auto size-4 text-accent-green"
														aria-label={`${titleCase(entry)} has ${permission}`}
													/>
												) : (
													<Minus
														className="mx-auto size-4 text-stone"
														aria-label={`${titleCase(entry)} does not have ${permission}`}
													/>
												)}
											</TableCell>
										);
									})}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</section>
		</div>
	);
}
