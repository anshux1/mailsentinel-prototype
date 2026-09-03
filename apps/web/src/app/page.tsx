"use client";

import { useQuery } from "@tanstack/react-query";
import {
	ArrowRight,
	FileLock2,
	FileText,
	Fingerprint,
	Route,
	ScanSearch,
	ShieldCheck,
	Siren,
	Upload,
} from "lucide-react";
import Link from "next/link";

import { CommandPaletteMock } from "@/components/brand/command-palette-mock";
import { HeroStripes } from "@/components/brand/hero-stripes";
import { Keycap } from "@/components/brand/keycap";
import { FadeUp, RevealOnScroll } from "@/components/common/motion";
import { MarketingFooter } from "@/components/layout/marketing-footer";
import { MarketingNav } from "@/components/layout/marketing-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSession } from "@/features/auth/use-session";
import { orpc } from "@/lib/orpc";

const PIPELINE = [
	{
		icon: Upload,
		title: "Private intake",
		body: "The browser registers a digest and byte size, then streams the bounded message straight into private object storage. Object keys never come back.",
	},
	{
		icon: ScanSearch,
		title: "Bounded parsing",
		body: "A hardened RFC 5322 parser walks headers, MIME parts, and attachments under hard limits. Nothing is rendered and no link is ever fetched.",
	},
	{
		icon: Route,
		title: "Deterministic scoring",
		body: "Ruleset v1.1.0 turns observations into evidence-backed findings with fixed weights, so the same message always produces the same verdict.",
	},
	{
		icon: FileText,
		title: "Immutable reports",
		body: "Each generation writes a new versioned report object. History is never silently overwritten.",
	},
];

const EXPLAINABILITY = [
	{
		icon: Fingerprint,
		title: "Every finding cites its evidence",
		body: "Rule id, category, severity, score contribution, and the exact header or content reference that triggered it.",
	},
	{
		icon: Siren,
		title: "Reported is not verified",
		body: "SPF, DKIM, and DMARC outcomes are presented as reported by headers — never as independently verified checks.",
	},
	{
		icon: ShieldCheck,
		title: "Benign evidence counts too",
		body: "Aligned authentication reduces the score. Missing enrichment never defaults a message to malicious.",
	},
];

const BOUNDARIES = [
	"Tenant context is explicit on every request — there is no implicit organization fallback.",
	"Object keys, storage credentials, and analyzer tokens never reach the browser.",
	"Attachments are inspected as bounded metadata; nothing is executed or decompressed.",
	"No LLM writes a verdict, and no opaque model score replaces the deterministic ruleset.",
];

export default function LandingPage() {
	const { session } = useSession();
	const health = useQuery({
		...orpc.system.health.queryOptions(),
		refetchInterval: 60_000,
	});

	const workspaceHref = session ? "/dashboard" : "/sign-in";

	return (
		<>
			<MarketingNav />

			<main className="flex-1">
				{/* Hero — the one place the stripe gradient is allowed. */}
				<section className="relative overflow-hidden">
					<HeroStripes />
					<div className="relative mx-auto grid max-w-[1240px] items-center gap-12 px-4 pt-16 pb-8 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:pt-24 lg:pb-12">
						<FadeUp className="min-w-0">
							<Badge variant="info" className="mb-6">
								Explainable email forensics
							</Badge>
							<h1 className="font-display font-semibold text-[36px] text-ink leading-[1.1] tracking-normal sm:text-[44px] lg:text-[56px] xl:text-[64px]">
								Understand every signal in an email.
							</h1>
							<p className="mt-6 max-w-xl text-[18px] text-body leading-[1.6]">
								MailSentinel is a tenant-scoped workspace for investigating
								suspicious messages. Evidence stays private, analysis stays
								deterministic, and every verdict shows its work.
							</p>

							<div className="mt-9 flex flex-wrap items-center gap-3">
								<Button asChild variant="primary" size="lg">
									<Link href={workspaceHref}>
										{session ? "Open workspace" : "Open the workspace"}
										<ArrowRight className="size-4" />
									</Link>
								</Button>
								<Button asChild variant="secondary" size="lg">
									<a href="#pipeline">See how it works</a>
								</Button>
							</div>

							<p className="mt-8 flex flex-wrap items-center gap-2 text-[13px] text-ash">
								<span>Press</span>
								<Keycap>⌘K</Keycap>
								<span>anywhere inside the workspace to search cases.</span>
							</p>
						</FadeUp>

						<FadeUp delay={0.12} className="min-w-0">
							<CommandPaletteMock />
							<div className="mt-4 flex items-center justify-between rounded-lg border border-hairline bg-surface px-4 py-3">
								<span className="text-[13px] text-mute">
									Application server
								</span>
								<span className="flex items-center gap-2 text-[13px]">
									<span
										className={
											health.data?.ok
												? "size-1.5 rounded-full bg-accent-green"
												: "size-1.5 rounded-full bg-stone"
										}
									/>
									<span className="text-mute">
										{health.isPending
											? "Checking…"
											: health.data?.ok
												? "Operational"
												: "Unavailable"}
									</span>
								</span>
							</div>
						</FadeUp>
					</div>
				</section>

				{/* Pipeline */}
				<section
					id="pipeline"
					className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6 lg:py-24"
				>
					<RevealOnScroll className="max-w-2xl">
						<h2 className="font-medium text-[28px] text-ink leading-[1.2] tracking-[0.2px] sm:text-[36px]">
							One path, from raw message to signed conclusion.
						</h2>
						<p className="mt-4 text-[16px] text-mute leading-[1.6]">
							The browser talks to a single typed endpoint. Everything private
							stays behind it.
						</p>
					</RevealOnScroll>

					<div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
						{PIPELINE.map((step, index) => (
							<RevealOnScroll
								key={step.title}
								amount={0.2}
								className="rounded-lg border border-hairline bg-surface p-6 transition-colors duration-200 hover:border-hairline-strong"
							>
								<div className="flex items-center justify-between">
									<span className="grid size-10 place-items-center rounded-md border border-hairline bg-surface-card">
										<step.icon className="size-4 text-body" />
									</span>
									<span className="font-mono text-[12px] text-stone">
										0{index + 1}
									</span>
								</div>
								<h3 className="mt-5 font-medium text-[18px] text-ink leading-[1.4] tracking-[0.2px]">
									{step.title}
								</h3>
								<p className="mt-2 text-[14px] text-mute leading-[1.6]">
									{step.body}
								</p>
							</RevealOnScroll>
						))}
					</div>
				</section>

				{/* Evidence */}
				<section
					id="evidence"
					className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6 lg:py-24"
				>
					<div className="grid items-center gap-12 lg:grid-cols-2">
						<RevealOnScroll className="min-w-0">
							<Badge variant="default" className="mb-5">
								Evidence handling
							</Badge>
							<h2 className="font-medium text-[28px] text-ink leading-[1.2] tracking-[0.2px] sm:text-[36px]">
								Raw email is hostile input, and it is treated that way.
							</h2>
							<p className="mt-4 text-[16px] text-mute leading-[1.6]">
								Uploads are registered before a single byte is written, verified
								against a SHA-256 digest computed in your browser, and sealed as
								immutable once stored. A mismatch fails the record instead of
								quietly accepting it.
							</p>
							<ul className="mt-7 space-y-3">
								{[
									"Digest and byte size are agreed before the body is sent",
									"Verified evidence is immutable and safe to re-submit",
									"Failed uploads keep only a safe failure reason",
								].map((item) => (
									<li key={item} className="flex gap-3 text-[14px] text-body">
										<FileLock2 className="mt-0.5 size-4 shrink-0 text-ash" />
										<span className="leading-[1.6]">{item}</span>
									</li>
								))}
							</ul>
						</RevealOnScroll>

						<RevealOnScroll amount={0.2} className="min-w-0">
							<div className="rounded-xl border border-hairline bg-surface p-2">
								<div className="space-y-2 rounded-lg bg-surface-elevated p-4">
									{[
										{ label: "Registered", detail: "pending · digest agreed" },
										{ label: "Written", detail: "stored · private object" },
										{ label: "Verified", detail: "verified · immutable" },
									].map((row, index) => (
										<div
											key={row.label}
											className="flex items-center gap-3 rounded-sm bg-surface-card px-3 py-2.5"
										>
											<span className="grid size-6 place-items-center rounded-xs bg-accent-green-soft font-mono text-[11px] text-accent-green">
												{index + 1}
											</span>
											<span className="flex-1 text-[14px] text-on-dark">
												{row.label}
											</span>
											<span className="text-[12px] text-ash tracking-[0.4px]">
												{row.detail}
											</span>
										</div>
									))}
								</div>
							</div>
						</RevealOnScroll>
					</div>
				</section>

				{/* Explainability */}
				<section
					id="explainability"
					className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6 lg:py-24"
				>
					<RevealOnScroll className="max-w-2xl">
						<h2 className="font-medium text-[28px] text-ink leading-[1.2] tracking-[0.2px] sm:text-[36px]">
							A verdict you can defend in a review.
						</h2>
						<p className="mt-4 text-[16px] text-mute leading-[1.6]">
							Scores come from a versioned ruleset, not a model you cannot
							inspect.
						</p>
					</RevealOnScroll>

					<div className="mt-12 grid gap-4 lg:grid-cols-3">
						{EXPLAINABILITY.map((item) => (
							<RevealOnScroll
								key={item.title}
								amount={0.2}
								className="rounded-lg border border-hairline bg-surface-elevated p-6"
							>
								<item.icon className="size-5 text-body" />
								<h3 className="mt-5 font-medium text-[18px] text-ink leading-[1.4] tracking-[0.2px]">
									{item.title}
								</h3>
								<p className="mt-2 text-[14px] text-mute leading-[1.6]">
									{item.body}
								</p>
							</RevealOnScroll>
						))}
					</div>
				</section>

				{/* Boundaries */}
				<section
					id="boundaries"
					className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6 lg:py-24"
				>
					<RevealOnScroll className="rounded-xl border border-hairline bg-surface p-8 sm:p-12">
						<div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
							<div>
								<h2 className="font-medium text-[28px] text-ink leading-[1.2] tracking-[0.2px]">
									Boundaries that hold under audit.
								</h2>
								<p className="mt-4 text-[16px] text-mute leading-[1.6]">
									Each guarantee is enforced by the application server and
									covered by tests, not left to convention.
								</p>
								<Button
									asChild
									variant="primary"
									size="default"
									className="mt-7"
								>
									<Link href={workspaceHref}>
										Open the workspace
										<ArrowRight className="size-4" />
									</Link>
								</Button>
							</div>
							<ul className="space-y-4">
								{BOUNDARIES.map((item) => (
									<li
										key={item}
										className="flex gap-3 border-hairline border-b pb-4 text-[15px] text-body leading-[1.6] last:border-0 last:pb-0"
									>
										<ShieldCheck className="mt-0.5 size-4 shrink-0 text-ash" />
										{item}
									</li>
								))}
							</ul>
						</div>
					</RevealOnScroll>
				</section>
			</main>

			<MarketingFooter />
		</>
	);
}
