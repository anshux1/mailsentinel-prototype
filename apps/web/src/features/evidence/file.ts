/**
 * Evidence is hostile input: the browser only ever measures and encodes it. It
 * is never parsed, rendered, or executed here — the analyzer does that behind
 * the application server.
 */

export const EVIDENCE_ACCEPT = ".eml,message/rfc822";

/** Mirrors the server's `MAX_EML_BYTES` default so the UI can fail fast. */
export const DEFAULT_MAX_EVIDENCE_BYTES = 26_214_400;

export type EvidenceFileError =
	| "empty"
	| "too-large"
	| "wrong-type"
	| "unreadable";

export const EVIDENCE_FILE_ERRORS: Record<EvidenceFileError, string> = {
	empty: "That file is empty.",
	"too-large": "That file is larger than the evidence size limit.",
	"wrong-type": "Evidence must be a raw .eml message (message/rfc822).",
	unreadable: "That file could not be read.",
};

export function validateEvidenceFile(
	file: File,
	maxBytes = DEFAULT_MAX_EVIDENCE_BYTES,
): EvidenceFileError | null {
	if (file.size === 0) return "empty";
	if (file.size > maxBytes) return "too-large";
	const looksLikeEml =
		file.name.toLowerCase().endsWith(".eml") ||
		file.type === "message/rfc822" ||
		file.type === "" ||
		file.type === "text/plain";
	return looksLikeEml ? null : "wrong-type";
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
