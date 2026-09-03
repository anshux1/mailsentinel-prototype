"use client";

import { ArrowUpRight, FolderClosed, Search } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { Stagger, StaggerItem } from "@/components/common/motion";
import { PageHeader } from "@/components/common/page-header";
import {
	EmptyState,
	ErrorState,
	ListSkeleton,
} from "@/components/common/states";
import { Input } from "@/components/ui/input";
import { CreateCaseDialog } from "@/features/cases/create-case-dialog";
import { useCases } from "@/features/cases/queries";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

function CasesView() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const [search, setSearch] = useState("");
	const [manualCreateOpen, setManualCreateOpen] = useState(false);

	const cases = useCases({ limit: 100 });

	// `?new=1` lets the command palette deep-link straight into case creation,
	// so the dialog's open state is derived rather than synchronised.
	const deepLinkedCreate = searchParams.get("new") === "1";
	const createOpen = manualCreateOpen || deepLinkedCreate;

	function setCreateOpen(next: boolean) {
		setManualCreateOpen(next);
		if (!next && deepLinkedCreate) router.replace("/cases");
	}

	const items = useMemo(() => cases.data?.items ?? [], [cases.data]);
	const filtered = useMemo(() => {
		const term = search.trim().toLowerCase();
		if (!term) return items;
		return items.filter(
			(item) =>
				item.title.toLowerCase().includes(term) ||
				item.id.toLowerCase().includes(term),
		);
	}, [items, search]);

	return (
		<div className="space-y-8">
			<PageHeader
				title="Cases"
				description="Each case groups the evidence, analysis runs, and reports for one investigation."
				actions={
					<CreateCaseDialog
						open={createOpen}
						onOpenChange={setCreateOpen}
						onCreated={(caseId) => router.push(`/cases/${caseId}`)}
					/>
				}
			/>

			{items.length > 0 ? (
				<div className="relative max-w-md">
					<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ash" />
					<Input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Filter cases by title or id…"
						className="pl-9"
						aria-label="Filter cases"
					/>
				</div>
			) : null}

			{cases.isPending ? (
				<ListSkeleton rows={4} />
			) : cases.isError ? (
				<ErrorState
					error={cases.error}
					onRetry={() => void cases.refetch()}
					title="Could not load cases"
				/>
			) : items.length === 0 ? (
				<EmptyState
					icon={FolderClosed}
					title="No cases yet"
					description="Open your first case to start collecting evidence and dispatching analysis."
					action={
						<CreateCaseDialog
							onCreated={(caseId) => router.push(`/cases/${caseId}`)}
						/>
					}
				/>
			) : filtered.length === 0 ? (
				<EmptyState
					icon={Search}
					title="No matching cases"
					description={`Nothing in this organization matches “${search}”.`}
				/>
			) : (
				<Stagger className="space-y-3">
					{filtered.map((item) => (
						<StaggerItem key={item.id}>
							<motion.div
								whileHover={{ y: -1 }}
								transition={{ duration: 0.15 }}
							>
								<Link
									href={`/cases/${item.id}`}
									className="group flex items-center gap-4 rounded-lg border border-hairline bg-surface p-4 transition-colors duration-200 hover:border-hairline-strong"
								>
									<span className="grid size-10 shrink-0 place-items-center rounded-md border border-hairline bg-surface-card">
										<FolderClosed className="size-4 text-body" />
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium text-[16px] text-ink leading-[1.4] tracking-[0.2px]">
											{item.title}
										</span>
										<span className="mt-1 block text-[13px] text-mute">
											Opened {formatRelativeTime(item.createdAt)} ·{" "}
											{formatDateTime(item.createdAt)}
										</span>
									</span>
									<ArrowUpRight className="size-4 shrink-0 text-stone transition-colors group-hover:text-on-dark" />
								</Link>
							</motion.div>
						</StaggerItem>
					))}
				</Stagger>
			)}
		</div>
	);
}

export default function CasesPage() {
	return (
		<Suspense fallback={<ListSkeleton rows={4} />}>
			<CasesView />
		</Suspense>
	);
}
