export type AnalysisStatus = "accepted" | "queued" | "deferred" | "failed";
export type SystemHealth = { ok: boolean; service: string; timestamp: string };
export type CaseShell = { id: string; organizationId: string; title: string };
