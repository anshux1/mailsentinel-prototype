/**
 * Public analyzer contracts and generated TypeScript types.
 *
 * NULL VS. EMPTY-COLLECTION CONVENTION:
 * 1. Collections (arrays/lists):
 *    - All collection fields are strictly non-null arrays.
 *    - When no data is present, collections MUST be empty arrays (`[]`), NEVER `null`.
 *    - Passing `null` to any collection field is rejected as a contract violation.
 * 2. Optional scalar fields / sub-objects:
 *    - Optional scalar fields (e.g., `filename`, `domain`, `phase`, `failure`) use `null` when absent.
 */

import type { components } from "../generated/analyzer";

export type { components, operations, paths } from "../generated/analyzer";

// Re-exported forensic contract schemas
export type AddressObservation = components["schemas"]["AddressObservation"];
export type AnalysisFailure = components["schemas"]["AnalysisFailure"];
export type AnalysisFailureCode = components["schemas"]["AnalysisFailureCode"];
export type AnalysisPhase = components["schemas"]["AnalysisPhase"];
export type AnalysisIntakeAccepted = components["schemas"]["AnalysisIntakeAccepted"];
export type AnalysisIntakeRequest = components["schemas"]["AnalysisIntakeRequest"];
export type AnalysisResult = components["schemas"]["AnalysisResult"];
export type AnalysisStatus = components["schemas"]["AnalysisStatus"];
export type AnalysisStatusValue = components["schemas"]["AnalysisStatusValue"];
export type AnalysisStatusState = AnalysisStatusValue;
export type Artifact = components["schemas"]["Artifact"];
export type AuthConflictObservation = components["schemas"]["AuthConflictObservation"];
export type AuthenticationObservation = components["schemas"]["AuthenticationObservation"];
export type ContentIndicatorObservation = components["schemas"]["ContentIndicatorObservation"];
export type DateObservation = components["schemas"]["DateObservation"];
export type DigestAlgorithm = components["schemas"]["DigestAlgorithm"];
export type EnrichmentDetails = components["schemas"]["EnrichmentDetails"];
export type EnrichmentObservation = components["schemas"]["EnrichmentObservation"];
export type Finding = components["schemas"]["Finding"];
export type FindingCategory = components["schemas"]["FindingCategory"];
export type HeaderObservation = components["schemas"]["HeaderObservation"];
export type IdentityObservation = components["schemas"]["IdentityObservation"];
export type IndicatorObservation = components["schemas"]["IndicatorObservation"];
export type LinkMismatchObservation = components["schemas"]["LinkMismatchObservation"];
export type MessageIdObservation = components["schemas"]["MessageIdObservation"];
export type MimePartObservation = components["schemas"]["MimePartObservation"];
export type ReceivedHop = components["schemas"]["ReceivedHop"];
export type RoutingAnomalyObservation = components["schemas"]["RoutingAnomalyObservation"];
export type ScoreBreakdown = components["schemas"]["ScoreBreakdown"];
export type SeverityValue = components["schemas"]["SeverityValue"];
export type VerdictValue = components["schemas"]["VerdictValue"];

export type SystemHealth = { ok: boolean; service: string; timestamp: string };
export type CaseShell = { id: string; organizationId: string; title: string };
