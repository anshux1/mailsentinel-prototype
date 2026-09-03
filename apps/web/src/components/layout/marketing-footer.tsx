import Link from "next/link";

import { Logo } from "@/components/brand/logo";

const COLUMNS: Array<{
	heading: string;
	links: Array<{ label: string; href: string }>;
}> = [
	{
		heading: "Workspace",
		links: [
			{ label: "Dashboard", href: "/dashboard" },
			{ label: "Cases", href: "/cases" },
			{ label: "Analysis", href: "/analysis" },
			{ label: "Reports", href: "/reports" },
		],
	},
	{
		heading: "Pipeline",
		links: [
			{ label: "Evidence intake", href: "#evidence" },
			{ label: "Forensic extraction", href: "#pipeline" },
			{ label: "Deterministic scoring", href: "#explainability" },
			{ label: "Immutable reports", href: "#pipeline" },
		],
	},
	{
		heading: "Guarantees",
		links: [
			{ label: "Tenant isolation", href: "#boundaries" },
			{ label: "Private storage", href: "#evidence" },
			{ label: "No URL fetching", href: "#boundaries" },
			{ label: "No LLM verdicts", href: "#explainability" },
		],
	},
	{
		heading: "Account",
		links: [
			{ label: "Sign in", href: "/sign-in" },
			{ label: "Settings", href: "/settings" },
		],
	},
];

export function MarketingFooter() {
	return (
		<footer className="border-hairline border-t">
			<div className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6">
				<div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
					{COLUMNS.map((column) => (
						<div key={column.heading}>
							<p className="font-medium text-[14px] text-on-dark tracking-[0.2px]">
								{column.heading}
							</p>
							<ul className="mt-4 space-y-2.5">
								{column.links.map((link) => (
									<li key={`${column.heading}-${link.label}`}>
										<Link
											href={link.href}
											className="text-[14px] text-mute leading-[1.6] transition-colors duration-150 hover:text-on-dark"
										>
											{link.label}
										</Link>
									</li>
								))}
							</ul>
						</div>
					))}
				</div>

				<div className="mt-14 flex flex-col gap-4 border-hairline border-t pt-8 sm:flex-row sm:items-center sm:justify-between">
					<Logo />
					<p className="text-[13px] text-stone leading-[1.5]">
						Evidence is treated as hostile input. Nothing is rendered, fetched,
						or executed.
					</p>
				</div>
			</div>
		</footer>
	);
}
