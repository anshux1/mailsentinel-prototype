"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		// The digest is the only safe correlation handle the client is given.
		console.error("Unhandled UI error", { digest: error.digest });
	}, [error.digest]);

	return (
		<main className="flex flex-1 items-center justify-center px-4 py-24">
			<div className="max-w-md text-center">
				<Logo className="mx-auto" />
				<h1 className="mt-10 font-medium text-[24px] text-ink leading-[1.3] tracking-[0.2px]">
					Something went wrong
				</h1>
				<p className="mt-3 text-[14px] text-mute leading-[1.6]">
					The workspace hit an unexpected error. Nothing was submitted twice —
					every mutation here is idempotent.
				</p>
				{error.digest ? (
					<p className="mt-3 font-mono text-[12px] text-stone">
						Digest {error.digest}
					</p>
				) : null}
				<div className="mt-8 flex justify-center gap-3">
					<Button variant="primary" onClick={reset}>
						<RefreshCw className="size-4" />
						Try again
					</Button>
					<Button asChild variant="secondary">
						<Link href="/dashboard">Go to dashboard</Link>
					</Button>
				</div>
			</div>
		</main>
	);
}
