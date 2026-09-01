"use client";

import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export function SessionControl() {
	const { data: session, isPending } = authClient.useSession();
	if (isPending)
		return <span className="text-xs text-slate-500">Checking session…</span>;
	if (!session)
		return (
			<Link href="/sign-in" className="text-sm text-cyan-300">
				Sign in
			</Link>
		);
	return (
		<div className="flex items-center gap-3 text-sm">
			<span className="text-slate-400">{session.user.email}</span>
			<button
				type="button"
				onClick={() => authClient.signOut()}
				className="rounded-lg border border-slate-700 px-3 py-1.5"
			>
				Sign out
			</button>
		</div>
	);
}
