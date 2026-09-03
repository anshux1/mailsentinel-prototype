import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
	return (
		<main className="flex flex-1 items-center justify-center px-4 py-24">
			<div className="max-w-md text-center">
				<Logo className="mx-auto" />
				<p className="mt-10 font-mono text-[13px] text-stone tracking-[0.4px]">
					404
				</p>
				<h1 className="mt-3 font-medium text-[24px] text-ink leading-[1.3] tracking-[0.2px]">
					This page does not exist
				</h1>
				<p className="mt-3 text-[14px] text-mute leading-[1.6]">
					The link may be stale, or the record may belong to another
					organization.
				</p>
				<div className="mt-8 flex justify-center gap-3">
					<Button asChild variant="primary">
						<Link href="/dashboard">Go to dashboard</Link>
					</Button>
					<Button asChild variant="secondary">
						<Link href="/">Back home</Link>
					</Button>
				</div>
			</div>
		</main>
	);
}
