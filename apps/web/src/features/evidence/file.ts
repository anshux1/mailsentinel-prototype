/**
 * Evidence is hostile input: the browser only ever measures and encodes it. It
 * is never parsed, rendered, or executed here — the analyzer does that behind
 * the application server.
 */

export const EVIDENCE_ACCEPT = ".eml,.mbox,message/rfc822";

/** Mirrors the server's `MAX_EML_BYTES` default so the UI can fail fast. */
export const DEFAULT_MAX_EVIDENCE_BYTES = 26_214_400;

/**
 * Mirrors the server's `MAX_CONTAINER_BYTES` default. A multi-message container
 * is registered under the same `message/rfc822` content type as a single
 * message — the analyzer, not the browser, decides how it segments.
 */
export const DEFAULT_MAX_CONTAINER_BYTES = 104_857_600;

export type EvidenceFileError =
	| "empty"
	| "too-large"
	| "wrong-type"
	| "unreadable";

export const EVIDENCE_FILE_ERRORS: Record<EvidenceFileError, string> = {
	empty: "That file is empty.",
	"too-large": "That file is larger than the evidence size limit.",
	"wrong-type":
		"Evidence must be a raw .eml message or an .mbox container (message/rfc822).",
	unreadable: "That file could not be read.",
};

/**
 * A guess used only for copy and limits. The server re-derives the real shape
 * by segmenting the bytes, so a mislabelled file still ingests correctly — it
 * just gets a less specific progress message.
 */
export type EvidenceKind = "single" | "container";

export function evidenceKind(file: File): EvidenceKind {
	const name = file.name.toLowerCase();
	return name.endsWith(".mbox") || name.endsWith(".mbx")
		? "container"
		: "single";
}

export function maxBytesForFile(
	file: File,
	limits: { maxEmlBytes?: number; maxContainerBytes?: number } = {},
): number {
	const {
		maxEmlBytes = DEFAULT_MAX_EVIDENCE_BYTES,
		maxContainerBytes = DEFAULT_MAX_CONTAINER_BYTES,
	} = limits;
	return evidenceKind(file) === "container" ? maxContainerBytes : maxEmlBytes;
}

export function validateEvidenceFile(
	file: File,
	maxBytes = maxBytesForFile(file),
): EvidenceFileError | null {
	if (file.size === 0) return "empty";
	if (file.size > maxBytes) return "too-large";
	const name = file.name.toLowerCase();
	const looksLikeEvidence =
		name.endsWith(".eml") ||
		name.endsWith(".mbox") ||
		name.endsWith(".mbx") ||
		file.type === "message/rfc822" ||
		file.type === "application/mbox" ||
		file.type === "" ||
		file.type === "text/plain";
	return looksLikeEvidence ? null : "wrong-type";
}

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function toBase64(bytes: Uint8Array): string {
	// Chunked to stay well clear of the argument-count limit on large messages.
	const CHUNK = 0x8000;
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	}
	return btoa(binary);
}

export type PreparedEvidence = {
	sha256: string;
	base64: string;
	byteSize: number;
};

/** Computes the digest the server will verify, plus the transport encoding. */
export async function prepareEvidenceFile(
	file: File,
): Promise<PreparedEvidence> {
	const buffer = await file.arrayBuffer();
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	const bytes = new Uint8Array(buffer);
	return {
		sha256: toHex(digest),
		base64: toBase64(bytes),
		byteSize: bytes.byteLength,
	};
}
