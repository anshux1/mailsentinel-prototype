import { Skeleton } from "@/components/ui/skeleton";

export default function WorkspaceLoading() {
	return (
		<div className="space-y-6" aria-busy>
			<Skeleton className="h-7 w-56" />
			<Skeleton className="h-4 w-80" />
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<Skeleton className="h-28 rounded-lg" />
				<Skeleton className="h-28 rounded-lg" />
				<Skeleton className="h-28 rounded-lg" />
				<Skeleton className="h-28 rounded-lg" />
			</div>
			<Skeleton className="h-64 rounded-lg" />
		</div>
	);
}
