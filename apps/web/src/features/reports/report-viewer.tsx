"use client";

import { Code2, Download, Eye } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { CopyButton } from "@/components/common/field";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const EXTENSIONS: Record<string, string> = {
	json: "json",
	html: "html",
	text: "txt",
	markdown: "md",
	pdf: "pdf",
};

function prettify(content: string, format: string): string {
	if (format !== "json") return content;
	try {
		return JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		return content;
	}
}

export function ReportViewer({
	content,
	format,
	fileName,
	className,
}: {
	content: string;
	format: string;
	fileName: string;
	className?: string;
}) {
	const isHtml = format === "html";
	const [mode, setMode] = useState<"preview" | "source">(
		isHtml ? "preview" : "source",
	);

	const source = useMemo(() => prettify(content, format), [content, format]);

	const download = useCallback(() => {
		const blob = new Blob([content], {
			type: isHtml
				? "text/html"
				: format === "json"
					? "application/json"
					: "text/plain",
		});
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${fileName}.${EXTENSIONS[format] ?? "txt"}`;
		document.body.append(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(url);
	}, [content, fileName, format, isHtml]);

	return (
		<div
			className={cn(
				"overflow-hidden rounded-lg border border-hairline bg-surface",
				className,
			)}
		>
			<div className="flex flex-wrap items-center gap-2 border-hairline border-b px-4 py-3">
				{isHtml ? (
					<div className="flex items-center gap-1 rounded-md bg-surface-elevated p-0.5">
						<button
							type="button"
							onClick={() => setMode("preview")}
							aria-pressed={mode === "preview"}
							className={cn(
								"flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[13px] transition-colors duration-150",
								mode === "preview"
									? "bg-surface-card text-on-dark"
									: "text-mute hover:text-body",
							)}
						>
							<Eye className="size-3.5" />
							Preview
						</button>
						<button
							type="button"
							onClick={() => setMode("source")}
							aria-pressed={mode === "source"}
							className={cn(
								"flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[13px] transition-colors duration-150",
								mode === "source"
									? "bg-surface-card text-on-dark"
									: "text-mute hover:text-body",
							)}
						>
							<Code2 className="size-3.5" />
							Source
						</button>
					</div>
				) : (
					<span className="text-[13px] text-mute uppercase tracking-[0.4px]">
						{format}
					</span>
				)}

				<div className="ml-auto flex items-center gap-1">
					<CopyButton value={content} label="Copy report" />
					<Button type="button" variant="tertiary" size="sm" onClick={download}>
						<Download className="size-3.5" />
						Download
					</Button>
				</div>
			</div>

			{isHtml && mode === "preview" ? (
				/*
				 * The server escapes every value and emits no active content, but the
				 * document is still rendered fully sandboxed: no scripts, no
				 * same-origin access, no forms, no navigation.
				 */
				<iframe
					title="Forensic report preview"
					srcDoc={content}
					sandbox=""
					referrerPolicy="no-referrer"
					className="h-[32rem] w-full border-0 bg-white"
				/>
			) : (
				<ScrollArea className="h-[32rem]">
					<pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] text-body leading-[1.6]">
						{source}
					</pre>
				</ScrollArea>
			)}
		</div>
	);
}
