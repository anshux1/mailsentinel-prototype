"use client";

import {
	MutationCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { safeErrorMessage } from "@/lib/errors";

function createQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				gcTime: 5 * 60_000,
				retry: (failureCount, error) => {
					// Authorisation and validation failures never succeed on retry.
					const status = (error as { status?: number } | null)?.status;
					if (status && status < 500 && status !== 429) return false;
					return failureCount < 2;
				},
				refetchOnWindowFocus: false,
			},
			mutations: { retry: 0 },
		},
		/**
		 * One place to surface mutation failures. Individual mutations can still
		 * opt out with `meta.silent` when they render their own error UI.
		 */
		mutationCache: new MutationCache({
			onError: (error, _variables, _context, mutation) => {
				if (mutation.meta?.silent) return;
				toast.error(safeErrorMessage(error), {
					description: requestIdOf(error),
				});
			},
		}),
	});
}

function requestIdOf(error: unknown): string | undefined {
	const data = (error as { data?: { requestId?: string } } | null)?.data;
	return data?.requestId ? `Request ${data.requestId}` : undefined;
}

export function Providers({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(createQueryClient);

	return (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider delayDuration={200} skipDelayDuration={400}>
				{children}
				<Toaster />
			</TooltipProvider>
		</QueryClientProvider>
	);
}
