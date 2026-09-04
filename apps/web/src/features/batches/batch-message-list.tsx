"use client";

import { Mail } from "lucide-react";

import { Stagger, StaggerItem } from "@/components/common/motion";
import {
	EmptyState,
	ErrorState,
	ListSkeleton,
} from "@/components/common/states";
import { useBatchEvidence } from "@/features/batches/queries";
import { EvidenceRow } from "@/features/evidence/evidence-row";
import { usePermissions } from "@/features/organization/use-permissions";

export function BatchMessageList({
	batchId,
	caseId,
	onAnalyze,
	analyzingEvidenceId,
}: {
	batchId: string;
	caseId?: string;
	onAnalyze?: (evidenceId: string) => void;
	analyzingEvidenceId?: string | null;
}) {
	const { can } = usePermissions();
	const messages = useBatchEvidence(batchId, { caseId });

	if (messages.isPending) return <ListSkeleton rows={4} />;

	if (messages.isError) {
		return (
			<ErrorState
				error={messages.error}
				onRetry={() => void messages.refetch()}
				title="Could not load the messages in this batch"
			/>
		);
	}

	const items = messages.data?.items ?? [];

	if (items.length === 0) {
		return (
			<EmptyState
				icon={Mail}
				title="No messages in this batch"
				description="Segmentation may still be running, or every child failed to store."
			/>
		);
	}

	return (
		<Stagger className="space-y-3">
			{items.map((item) => (
				<StaggerItem key={item.id}>
					<EvidenceRow
						item={item}
						isAnalyzing={analyzingEvidenceId === item.id}
						canAnalyze={item.status === "verified" && can("analysis:start")}
						onAnalyze={onAnalyze}
					/>
				</StaggerItem>
			))}
		</Stagger>
	);
}
