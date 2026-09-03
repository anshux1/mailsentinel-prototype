"use client";

import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { CommandPaletteMock } from "@/components/brand/command-palette-mock";
import { HeroStripes } from "@/components/brand/hero-stripes";
import { Logo } from "@/components/brand/logo";
import { FadeUp } from "@/components/common/motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/features/auth/use-session";
import { authClient } from "@/lib/auth-client";
import { brandEase } from "@/lib/motion";

function SignInForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const { session, isPending: sessionPending } = useSession();

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const next = searchParams.get("next") ?? "/dashboard";

	// An already-authenticated visitor should never sit on the sign-in screen.
	useEffect(() => {
		if (!sessionPending && session) router.replace(next);
	}, [session, sessionPending, router, next]);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSubmitting(true);
		setError(null);

		const result = await authClient.signIn.email({ email, password });

		if (result.error) {
			// Auth failures stay deliberately generic.
			setError(result.error.message ?? "Those credentials were not accepted.");
			setSubmitting(false);
			return;
		}

		router.replace(next);
		router.refresh();
	}

	return (
		<form onSubmit={onSubmit} className="space-y-5" noValidate>
			<div className="space-y-2">
				<Label htmlFor="email">Work email</Label>
				<Input
					id="email"
					name="email"
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					placeholder="you@organization.example"
					aria-invalid={error ? true : undefined}
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor="password">Password</Label>
				<Input
					id="password"
					name="password"
					type="password"
					autoComplete="current-password"
					required
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					aria-invalid={error ? true : undefined}
				/>
			</div>

			{error ? (
				<motion.p
					initial={{ opacity: 0, y: -4 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.2, ease: brandEase }}
					role="alert"
					className="flex items-start gap-2 rounded-md bg-accent-red-soft px-3 py-2.5 text-[13px] text-accent-red leading-[1.5]"
				>
					<AlertCircle className="mt-0.5 size-3.5 shrink-0" />
					{error}
				</motion.p>
			) : null}

			<Button
				type="submit"
				variant="primary"
				size="lg"
				className="w-full"
				disabled={submitting}
			>
				{submitting ? (
					<>
						<Loader2 className="size-4 animate-spin" />
						Signing in…
					</>
				) : (
					<>
						Sign in
						<ArrowRight className="size-4" />
					</>
				)}
			</Button>

			<p aria-live="polite" className="sr-only">
				{submitting ? "Signing in" : error ? error : ""}
			</p>
		</form>
	);
}

export default function SignInPage() {
	return (
		<main className="relative flex flex-1 flex-col">
			<HeroStripes className="h-[320px]" />

			<div className="relative mx-auto grid w-full max-w-[1240px] flex-1 items-center gap-16 px-4 py-12 sm:px-6 lg:grid-cols-[0.95fr_1.05fr] lg:py-20">
				<FadeUp className="mx-auto w-full max-w-sm">
					<Link href="/" className="inline-block">
						<Logo />
					</Link>

					<h1 className="mt-8 font-medium text-[28px] text-ink leading-[1.2] tracking-[0.2px]">
						Sign in to your workspace
					</h1>
					<p className="mt-2.5 text-[14px] text-mute leading-[1.6]">
						Access is scoped to the organizations you belong to. Every action is
						recorded in a tenant-scoped audit trail.
					</p>

					<div className="mt-8">
						<Suspense
							fallback={
								<div className="h-64 animate-pulse rounded-lg bg-surface" />
							}
						>
							<SignInForm />
						</Suspense>
					</div>

					<p className="mt-8 text-[13px] text-stone leading-[1.5]">
						Need an account? An organization owner has to invite you — self
						sign-up is disabled by design.
					</p>
				</FadeUp>

				<FadeUp delay={0.1} className="hidden min-w-0 lg:block">
					<CommandPaletteMock />
					<p className="mt-4 text-[13px] text-stone leading-[1.5]">
						A completed run, exactly as it appears inside a case.
					</p>
				</FadeUp>
			</div>
		</main>
	);
}
