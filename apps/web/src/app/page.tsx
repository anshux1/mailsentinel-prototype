"use client";

import { useQuery } from "@tanstack/react-query";
import { SessionControl } from "@/components/session-control";
import { orpc } from "@/lib/orpc";

export default function Home() {
	const health = useQuery(orpc.system.health.queryOptions());
	return (
		<main className="min-h-screen bg-[#08111f] text-slate-100">
			<div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 lg:px-12">
				<nav className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="grid size-9 place-items-center rounded-xl bg-cyan-400 font-black text-[#08111f]">
							M
						</div>
						<span className="font-semibold tracking-tight">MailSentinel</span>
					</div>
					<SessionControl />
				</nav>
				<section className="grid flex-1 items-center gap-14 py-20 lg:grid-cols-[1.1fr_.9fr]">
					<div>
						<p className="mb-6 text-sm font-medium uppercase tracking-[.25em] text-cyan-300">
							Forensic intelligence, responsibly built
						</p>
						<h1 className="max-w-3xl text-5xl font-semibold leading-[1.05] tracking-tight sm:text-7xl">
							Understand every signal in an email.
						</h1>
						<p className="mt-7 max-w-xl text-lg leading-8 text-slate-400">
							A secure workspace for investigating suspicious messages. The
							foundation is ready for typed contracts, tenant-safe evidence and
							transparent analysis.
						</p>
						<div className="mt-10 flex flex-wrap gap-3">
							<a
								href="/sign-in"
								className="rounded-xl bg-cyan-300 px-5 py-3 font-semibold text-[#08111f]"
							>
								Open workspace
							</a>
							<button
								type="button"
								className="rounded-xl border border-slate-700 px-5 py-3 font-semibold text-slate-200"
							>
								Read the runbook
							</button>
						</div>
					</div>
					<div className="rounded-3xl border border-slate-700/70 bg-slate-900/70 p-6 shadow-2xl shadow-cyan-950/30">
						<div className="mb-7 flex items-center justify-between">
							<span className="text-sm text-slate-400">System overview</span>
							<span className="flex items-center gap-2 text-xs text-emerald-300">
								<i className="size-2 rounded-full bg-emerald-300" />
								{health.isLoading
									? "Checking"
									: health.data?.ok
										? "Operational"
										: "Unavailable"}
							</span>
						</div>
						<div className="space-y-3">
							{[
								"Typed application contracts",
								"Private evidence storage",
								"Protected analyzer boundary",
							].map((item, i) => (
								<div
									className="flex items-center justify-between rounded-2xl bg-slate-800/70 p-4"
									key={item}
								>
									<span className="text-sm text-slate-200">{item}</span>
									<span className="text-xs text-cyan-300">
										{i === 0 ? "Connected" : "Ready"}
									</span>
								</div>
							))}
						</div>
						<div className="mt-6 border-t border-slate-800 pt-5 text-xs text-slate-500">
							Health checked via TanStack Query ·{" "}
							{health.data?.timestamp
								? new Date(health.data.timestamp).toLocaleTimeString()
								: "pending"}
						</div>
					</div>
				</section>
			</div>
		</main>
	);
}
