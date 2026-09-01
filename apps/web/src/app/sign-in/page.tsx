"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function SignInPage() {
	const [message, setMessage] = useState("");
	async function signIn(formData: FormData) {
		const email = String(formData.get("email"));
		const password = String(formData.get("password"));
		const result = await authClient.signIn.email({
			email,
			password,
			callbackURL: "/",
		});
		setMessage(result.error?.message ?? "Signed in");
	}
	return (
		<main className="grid min-h-screen place-items-center bg-[#08111f] p-6 text-slate-100">
			<form
				action={signIn}
				className="w-full max-w-sm space-y-5 rounded-3xl border border-slate-700 bg-slate-900 p-8"
			>
				<div>
					<p className="text-sm text-cyan-300">MailSentinel</p>
					<h1 className="mt-2 text-3xl font-semibold">Investigator sign in</h1>
				</div>
				<label className="block text-sm">
					Email
					<input
						name="email"
						type="email"
						defaultValue="demo@mailsentinel.local"
						required
						className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3"
					/>
				</label>
				<label className="block text-sm">
					Password
					<input
						name="password"
						type="password"
						required
						className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3"
					/>
				</label>
				<button
					type="submit"
					className="w-full rounded-xl bg-cyan-300 px-4 py-3 font-semibold text-slate-950"
				>
					Sign in securely
				</button>
				<p aria-live="polite" className="text-sm text-slate-400">
					{message}
				</p>
			</form>
		</main>
	);
}
