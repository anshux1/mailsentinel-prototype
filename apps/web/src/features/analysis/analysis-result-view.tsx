"use client";

import {
	AlertTriangle,
	Globe,
	Link2Off,
	Mailbox,
	Paperclip,
	Route,
	ShieldQuestion,
	Sparkles,
} from "lucide-react";
import { Field, FieldGrid } from "@/components/common/field";
import { Stagger, StaggerItem } from "@/components/common/motion";
import { ScoreMeter } from "@/components/common/score-meter";
import { SeverityBadge, VerdictBadge } from "@/components/common/status-badge";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes, formatDateTime, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AnalysisResultCompleted } from "@/server/orpc/analysis-schemas";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

function EmptyPanel({ label }: { label: string }) {
	return (
		<p className="rounded-lg border border-hairline border-dashed bg-surface/40 px-4 py-8 text-center text-[13px] text-ash">
			{label}
		</p>
	);
}

function PanelHeading({
	icon: Icon,
	title,
	count,
}: {
	icon: typeof Route;
	title: string;
	count?: number;
}) {
	return (
		<div className="flex items-center gap-2.5">
			<Icon className="size-4 text-ash" />
			<h3 className="font-medium text-[16px] text-ink tracking-[0.2px]">
				{title}
			</h3>
			{count !== undefined ? (
				<Badge variant="outline" className="tabular-nums">
					{count}
				</Badge>
			) : null}
		</div>
	);
}

/** Verdict, score, and the findings that produced them. */
export function AnalysisResultView({
	result,
}: {
	result: AnalysisResultCompleted;
}) {
	const findings = [...result.findings].sort((a, b) => {
		const bySeverity =
			SEVERITY_ORDER.indexOf(a.severity as (typeof SEVERITY_ORDER)[number]) -
			SEVERITY_ORDER.indexOf(b.severity as (typeof SEVERITY_ORDER)[number]);
		if (bySeverity !== 0) return bySeverity;
		return b.scoreContribution - a.scoreContribution;
	});

	return (
		<div className="space-y-6">
			<Stagger className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
				<StaggerItem className="flex flex-col rounded-lg border border-hairline bg-surface p-6">
					<div className="flex items-start justify-between gap-4">
						<div>
							<p className="text-[12px] text-ash uppercase tracking-[0.4px]">
								Verdict
							</p>
							<div className="mt-2">
								<VerdictBadge verdict={result.verdict} />
							</div>
						</div>
						<div className="text-right">
							<p className="text-[12px] text-ash uppercase tracking-[0.4px]">
								Analyzed
							</p>
							<p className="mt-2 text-[13px] text-mute">
								{formatDateTime(result.analyzedAt)}
							</p>
						</div>
					</div>

					<div className="mt-7 mb-auto">
						<ScoreMeter
							score={result.score.finalScore}
							confidence={result.confidence}
						/>
					</div>

					<div className="mt-6 flex flex-wrap gap-2 border-hairline border-t pt-5">
						{SEVERITY_ORDER.map((severity) => {
							const count = result.findings.filter(
								(finding) => finding.severity === severity,
							).length;
							if (count === 0) return null;
							return (
								<span key={severity} className="flex items-center gap-1.5">
									<SeverityBadge severity={severity} />
									<span className="text-[13px] text-mute tabular-nums">
										{count}
									</span>
								</span>
							);
						})}
						{result.findings.length === 0 ? (
							<span className="text-[13px] text-mute">
								No findings contributed to this score.
							</span>
						) : null}
					</div>
				</StaggerItem>

				<StaggerItem className="rounded-lg border border-hairline bg-surface-elevated p-6">
					<PanelHeading icon={Sparkles} title="Provenance" />
					<FieldGrid className="mt-5" columns={2}>
						<Field label="Ruleset">{result.rulesetVersion}</Field>
						<Field label="Analyzer">{result.analysisVersion}</Field>
						<Field label="Result schema">{result.schemaVersion}</Field>
						<Field label="Artifact size">
							{formatBytes(result.artifactByteSize)}
						</Field>
						<Field label="Digest" mono className="sm:col-span-2">
							<span className="break-all">
								{result.artifactDigestAlgorithm}:{result.artifactSha256}
							</span>
						</Field>
					</FieldGrid>
					<p className="mt-5 border-hairline border-t pt-4 text-[12px] text-stone leading-[1.5]">
						Authentication outcomes below are reported by message headers. They
						are not independently verified.
					</p>
				</StaggerItem>
			</Stagger>

			<Tabs defaultValue="findings" className="w-full">
				<TabsList className="w-full justify-start overflow-x-auto">
					<TabsTrigger value="findings">
						Findings
						<Badge variant="outline" className="ml-1.5 tabular-nums">
							{findings.length}
						</Badge>
					</TabsTrigger>
					<TabsTrigger value="authentication">Authentication</TabsTrigger>
					<TabsTrigger value="routing">Routing</TabsTrigger>
					<TabsTrigger value="content">Content</TabsTrigger>
					<TabsTrigger value="indicators">Indicators</TabsTrigger>
					<TabsTrigger value="attachments">Attachments</TabsTrigger>
					<TabsTrigger value="headers">Headers</TabsTrigger>
				</TabsList>

				{/* Findings ---------------------------------------------------- */}
				<TabsContent value="findings" className="pt-5">
					{findings.length === 0 ? (
						<EmptyPanel label="No rule produced a finding for this message." />
					) : (
						<Accordion type="multiple" className="space-y-2">
							{findings.map((finding, index) => (
								<AccordionItem
									key={`${finding.ruleId}-${index}`}
									value={`${finding.ruleId}-${index}`}
									className="rounded-lg border border-hairline bg-surface px-4"
								>
									<AccordionTrigger className="gap-3 py-4 hover:no-underline">
										<span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left">
											<SeverityBadge severity={finding.severity} />
											<span className="min-w-0 truncate font-mono text-[13px] text-ink">
												{finding.ruleId}
											</span>
											<Badge variant="outline">
												{titleCase(finding.category)}
											</Badge>
											<span
												className={cn(
													"ml-auto shrink-0 text-[13px] tabular-nums",
													finding.scoreContribution >= 0
														? "text-mute"
														: "text-accent-green",
												)}
											>
												{finding.scoreContribution >= 0 ? "+" : ""}
												{finding.scoreContribution}
											</span>
										</span>
									</AccordionTrigger>
									<AccordionContent className="pb-4">
										<p className="text-[14px] text-body leading-[1.6]">
											{finding.explanation}
										</p>
										{finding.evidenceRefs.length > 0 ? (
											<div className="mt-4">
												<p className="text-[12px] text-ash uppercase tracking-[0.4px]">
													Evidence
												</p>
												<ul className="mt-2 flex flex-wrap gap-1.5">
													{finding.evidenceRefs.map((reference) => (
														<li key={reference}>
															<code className="rounded-xs border border-hairline bg-surface-card px-2 py-0.5 font-mono text-[12px] text-mute">
																{reference}
															</code>
														</li>
													))}
												</ul>
											</div>
										) : null}
										<p className="mt-4 text-[12px] text-stone tracking-[0.4px]">
											Source: {finding.source}
										</p>
									</AccordionContent>
								</AccordionItem>
							))}
						</Accordion>
					)}
				</TabsContent>

				{/* Authentication ---------------------------------------------- */}
				<TabsContent value="authentication" className="space-y-6 pt-5">
					<section className="space-y-3">
						<PanelHeading
							icon={ShieldQuestion}
							title="Reported outcomes"
							count={result.authentication.length}
						/>
						{result.authentication.length === 0 ? (
							<EmptyPanel label="No authentication headers were present." />
						) : (
							<div className="overflow-x-auto rounded-lg border border-hairline">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Method</TableHead>
											<TableHead>Result</TableHead>
											<TableHead>Declaring host</TableHead>
											<TableHead>Verified</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{result.authentication.map((entry, index) => (
											<TableRow key={`${entry.method}-${index}`}>
												<TableCell className="font-mono text-[13px] text-ink uppercase">
													{entry.method}
												</TableCell>
												<TableCell>
													<Badge
														variant={
															entry.result === "pass"
																? "success"
																: entry.result === "fail"
																	? "danger"
																	: "default"
														}
													>
														{entry.result}
													</Badge>
												</TableCell>
												<TableCell className="text-mute">
													{entry.declaringHost ?? "—"}
												</TableCell>
												<TableCell className="text-mute">
													{entry.independentlyVerified
														? "Yes"
														: "Reported only"}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						)}
					</section>

					{result.authConflicts.length > 0 ? (
						<section className="space-y-3">
							<PanelHeading
								icon={AlertTriangle}
								title="Conflicting headers"
								count={result.authConflicts.length}
							/>
							<ul className="space-y-2">
								{result.authConflicts.map((conflict, index) => (
									<li
										key={`${conflict.method}-${index}`}
										className="rounded-lg border border-hairline bg-surface p-4"
									>
										<p className="font-mono text-[13px] text-ink uppercase">
											{conflict.method}
										</p>
										<p className="mt-1.5 text-[14px] text-body leading-[1.6]">
											{conflict.explanation}
										</p>
										<p className="mt-2 text-[12px] text-ash tracking-[0.4px]">
											Outcomes: {conflict.outcomes.join(", ") || "—"} · Sources:{" "}
											{conflict.sources.join(", ") || "—"}
										</p>
									</li>
								))}
							</ul>
						</section>
					) : null}

					{result.identityObservations.length > 0 ? (
						<section className="space-y-3">
							<PanelHeading
								icon={Mailbox}
								title="Identity inconsistencies"
								count={result.identityObservations.length}
							/>
							<ul className="space-y-2">
								{result.identityObservations.map((identity, index) => (
									<li
										key={`${identity.address}-${index}`}
										className="rounded-lg border border-hairline bg-surface p-4"
									>
										<div className="flex flex-wrap items-center gap-2">
											<Badge variant="warning">
												{titleCase(identity.inconsistencyType)}
											</Badge>
											<span className="font-mono text-[13px] text-ink">
												{identity.address}
											</span>
										</div>
										<p className="mt-2 text-[14px] text-body leading-[1.6]">
											{identity.explanation}
										</p>
										<p className="mt-2 text-[12px] text-ash tracking-[0.4px]">
											Display name “{identity.displayName}” claims{" "}
											{identity.claimedIdentity}
										</p>
									</li>
								))}
							</ul>
						</section>
					) : null}
				</TabsContent>

				{/* Routing ------------------------------------------------------ */}
				<TabsContent value="routing" className="space-y-6 pt-5">
					<section className="space-y-3">
						<PanelHeading
							icon={Route}
							title="Received hops"
							count={result.receivedHops.length}
						/>
						{result.receivedHops.length === 0 ? (
							<EmptyPanel label="No routing hops were recorded." />
						) : (
							<ol className="space-y-2">
								{result.receivedHops.map((hop) => (
									<li
										key={hop.position}
										className="rounded-lg border border-hairline bg-surface p-4"
									>
										<div className="flex flex-wrap items-center gap-2">
											<span className="grid size-6 place-items-center rounded-xs bg-surface-card font-mono text-[11px] text-mute">
												{hop.position}
											</span>
											<span className="font-mono text-[13px] text-ink">
												{hop.fromHost ?? "unknown"} → {hop.byHost ?? "unknown"}
											</span>
											{hop.privateToPublic ? (
												<Badge variant="warning">Private → public</Badge>
											) : null}
											{hop.latencyJumpSeconds ? (
												<Badge variant="info">
													+{Math.round(hop.latencyJumpSeconds)}s
												</Badge>
											) : null}
										</div>
										<p className="mt-2 text-[12px] text-ash tracking-[0.4px]">
											{hop.sourceIp ? `Source ${hop.sourceIp} · ` : ""}
											{hop.timestamp
												? formatDateTime(hop.timestamp)
												: "no timestamp"}
										</p>
										{hop.parseWarning ? (
											<p className="mt-1.5 text-[13px] text-accent-yellow">
												{hop.parseWarning}
											</p>
										) : null}
									</li>
								))}
							</ol>
						)}
					</section>

					{result.routingAnomalies.length > 0 ? (
						<section className="space-y-3">
							<PanelHeading
								icon={AlertTriangle}
								title="Routing anomalies"
								count={result.routingAnomalies.length}
							/>
							<ul className="space-y-2">
								{result.routingAnomalies.map((anomaly, index) => (
									<li
										key={`${anomaly.anomalyType}-${index}`}
										className="rounded-lg border border-hairline bg-surface p-4"
									>
										<Badge variant="warning">
											{titleCase(anomaly.anomalyType)}
										</Badge>
										<p className="mt-2 text-[14px] text-body leading-[1.6]">
											{anomaly.explanation}
										</p>
										{anomaly.details ? (
											<p className="mt-1.5 text-[13px] text-mute">
												{anomaly.details}
											</p>
										) : null}
									</li>
								))}
							</ul>
						</section>
					) : null}
				</TabsContent>

				{/* Content ------------------------------------------------------ */}
				<TabsContent value="content" className="space-y-6 pt-5">
					<section className="space-y-3">
						<PanelHeading
							icon={Link2Off}
							title="Link mismatches"
							count={result.linkMismatches.length}
						/>
						{result.linkMismatches.length === 0 ? (
							<EmptyPanel label="No display text disagreed with its link target." />
						) : (
							<ul className="space-y-2">
								{result.linkMismatches.map((mismatch, index) => (
									<li
										key={`${mismatch.actualHref}-${index}`}
										className="rounded-lg border border-hairline bg-surface p-4"
									>
										<p className="text-[14px] text-body leading-[1.6]">
											{mismatch.explanation}
										</p>
										<dl className="mt-3 grid gap-3 sm:grid-cols-2">
											<div>
												<dt className="text-[12px] text-ash uppercase tracking-[0.4px]">
													Displayed
												</dt>
												{/* Never a live link — evidence is not followed. */}
												<dd className="mt-1 break-all font-mono text-[13px] text-mute">
													{mismatch.displayText}
												</dd>
											</div>
											<div>
												<dt className="text-[12px] text-ash uppercase tracking-[0.4px]">
													Actual target
												</dt>
												<dd className="mt-1 break-all font-mono text-[13px] text-accent-red">
													{mismatch.actualHref}
												</dd>
											</div>
										</dl>
									</li>
								))}
							</ul>
						)}
					</section>

					<section className="space-y-3">
						<PanelHeading
							icon={AlertTriangle}
							title="Social-engineering indicators"
							count={result.contentIndicators.length}
						/>
						{result.contentIndicators.length === 0 ? (
							<EmptyPanel label="No bounded content indicators matched." />
						) : (
							<ul className="space-y-2">
								{result.contentIndicators.map((indicator, index) => (
									<li
										key={`${indicator.matchedPhrase}-${index}`}
										className="rounded-lg border border-hairline bg-surface p-4"
									>
										<div className="flex flex-wrap items-center gap-2">
											<Badge variant="warning">
												{titleCase(indicator.category)}
											</Badge>
											<span className="text-[12px] text-ash tracking-[0.4px]">
												from {indicator.source}
											</span>
										</div>
										<p className="mt-2 font-mono text-[13px] text-ink">
											“{indicator.matchedPhrase}”
										</p>
										<p className="mt-1.5 text-[13px] text-mute leading-[1.5]">
											{indicator.snippet}
										</p>
									</li>
								))}
							</ul>
						)}
					</section>

					{result.parserWarnings.length > 0 ? (
						<section className="space-y-3">
							<PanelHeading
								icon={AlertTriangle}
								title="Parser warnings"
								count={result.parserWarnings.length}
							/>
							<ul className="space-y-1.5">
								{result.parserWarnings.map((warning) => (
									<li
										key={warning}
										className="rounded-md bg-accent-yellow-soft px-3 py-2 text-[13px] text-accent-yellow leading-[1.5]"
									>
										{warning}
									</li>
								))}
							</ul>
						</section>
					) : null}
				</TabsContent>

				{/* Indicators --------------------------------------------------- */}
				<TabsContent value="indicators" className="space-y-6 pt-5">
					<section className="space-y-3">
						<PanelHeading
							icon={Globe}
							title="Extracted indicators"
							count={result.indicators.length}
						/>
						{result.indicators.length === 0 ? (
							<EmptyPanel label="No indicators were extracted." />
						) : (
							<div className="overflow-x-auto rounded-lg border border-hairline">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Kind</TableHead>
											<TableHead>Value</TableHead>
											<TableHead>Source</TableHead>
											<TableHead>Scope</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{result.indicators.map((indicator, index) => (
											<TableRow key={`${indicator.normalizedValue}-${index}`}>
												<TableCell>
													<Badge variant="outline">{indicator.kind}</Badge>
												</TableCell>
												<TableCell className="break-all font-mono text-[13px] text-ink">
													{indicator.value}
												</TableCell>
												<TableCell className="text-mute">
													{indicator.source}
												</TableCell>
												<TableCell className="text-mute">
													{indicator.privateOrReserved
														? "Private / reserved"
														: "Public"}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						)}
					</section>

					<section className="space-y-3">
						<PanelHeading
							icon={Sparkles}
							title="Enrichment"
							count={result.enrichment.length}
						/>
						{result.enrichment.length === 0 ? (
							<EmptyPanel label="Enrichment was disabled or returned nothing. A missing lookup never raises the verdict on its own." />
						) : (
							<ul className="space-y-2">
								{result.enrichment.map((entry, index) => (
									<li
										key={`${entry.indicator}-${entry.provider}-${index}`}
										className="rounded-lg border border-hairline bg-surface p-4"
									>
										<div className="flex flex-wrap items-center gap-2">
											<span className="break-all font-mono text-[13px] text-ink">
												{entry.indicator}
											</span>
											<Badge variant="outline">{entry.provider}</Badge>
											<Badge variant="default">{entry.mode}</Badge>
											{entry.reputation ? (
												<Badge
													variant={
														entry.reputation === "risky" ? "danger" : "success"
													}
												>
													{entry.reputation}
												</Badge>
											) : null}
										</div>
										{entry.details ? (
											<p className="mt-2 text-[12px] text-ash tracking-[0.4px]">
												{[
													entry.details.asn ? `ASN ${entry.details.asn}` : null,
													entry.details.country,
													entry.details.category,
													entry.score !== null && entry.score !== undefined
														? `score ${entry.score}`
														: null,
												]
													.filter(Boolean)
													.join(" · ") || "No additional detail"}
											</p>
										) : null}
									</li>
								))}
							</ul>
						)}
					</section>
				</TabsContent>

				{/* Attachments -------------------------------------------------- */}
				<TabsContent value="attachments" className="pt-5">
					<section className="space-y-3">
						<PanelHeading
							icon={Paperclip}
							title="MIME parts"
							count={result.mimeParts.length}
						/>
						<p className="text-[13px] text-stone leading-[1.5]">
							Attachments are inspected as bounded metadata only. Nothing is
							opened, extracted, or executed.
						</p>
						{result.mimeParts.length === 0 ? (
							<EmptyPanel label="No MIME parts were recorded." />
						) : (
							<div className="overflow-x-auto rounded-lg border border-hairline">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Part</TableHead>
											<TableHead>Content type</TableHead>
											<TableHead>Filename</TableHead>
											<TableHead>Size</TableHead>
											<TableHead>Flags</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{result.mimeParts.map((part) => (
											<TableRow key={part.partId}>
												<TableCell className="font-mono text-[13px] text-mute">
													{part.partId}
												</TableCell>
												<TableCell className="font-mono text-[13px] text-ink">
													{part.contentType}
												</TableCell>
												<TableCell className="text-mute">
													{part.filename ?? "—"}
												</TableCell>
												<TableCell className="text-mute tabular-nums">
													{formatBytes(part.byteSize)}
												</TableCell>
												<TableCell>
													<span className="flex flex-wrap gap-1.5">
														{part.isAttachment ? (
															<Badge variant="outline">Attachment</Badge>
														) : null}
														{part.dangerousExtension ? (
															<Badge variant="danger">Dangerous ext</Badge>
														) : null}
														{part.typeExtensionMismatch ? (
															<Badge variant="warning">Type mismatch</Badge>
														) : null}
													</span>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						)}
					</section>
				</TabsContent>

				{/* Headers ------------------------------------------------------ */}
				<TabsContent value="headers" className="space-y-6 pt-5">
					<section className="space-y-3">
						<PanelHeading
							icon={Mailbox}
							title="Addresses"
							count={result.addresses.length}
						/>
						{result.addresses.length === 0 ? (
							<EmptyPanel label="No addresses were parsed." />
						) : (
							<ul className="space-y-2">
								{result.addresses.map((address, index) => (
									<li
										key={`${address.source}-${address.value}-${index}`}
										className="flex flex-wrap items-baseline gap-2 rounded-lg border border-hairline bg-surface px-4 py-3"
									>
										<Badge variant="outline">{address.source}</Badge>
										<span className="break-all font-mono text-[13px] text-ink">
											{address.address ?? address.value}
										</span>
										{address.displayName ? (
											<span className="text-[13px] text-mute">
												“{address.displayName}”
											</span>
										) : null}
									</li>
								))}
							</ul>
						)}
					</section>

					<section className="space-y-3">
						<PanelHeading
							icon={Mailbox}
							title="Raw header observations"
							count={result.headers.length}
						/>
						{result.headers.length === 0 ? (
							<EmptyPanel label="No headers were recorded." />
						) : (
							<div className="overflow-x-auto rounded-lg border border-hairline">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead className="w-52">Name</TableHead>
											<TableHead>Value</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{result.headers.map((header, index) => (
											<TableRow
												key={`${header.name}-${header.occurrence}-${index}`}
											>
												<TableCell className="align-top font-mono text-[13px] text-ink">
													{header.name}
													{header.malformed ? (
														<Badge variant="warning" className="ml-2">
															Malformed
														</Badge>
													) : null}
												</TableCell>
												<TableCell className="break-all font-mono text-[13px] text-mute">
													{header.value}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						)}
					</section>
				</TabsContent>
			</Tabs>
		</div>
	);
}
