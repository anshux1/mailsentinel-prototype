import "server-only";

import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { getEncryptionKey } from "./crypto";

export interface OAuthStatePayload {
	organizationId: string;
	userId: string;
	codeVerifier: string;
	timestamp: number;
	nonce: string;
}

export class OAuthStateError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OAuthStateError";
	}
}

export function generateCodeVerifier(): string {
	return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

export function createSignedOAuthState(
	payload: { organizationId: string; userId: string; codeVerifier: string },
	secretKey?: string | Buffer,
): string {
	const fullPayload: OAuthStatePayload = {
		organizationId: payload.organizationId,
		userId: payload.userId,
		codeVerifier: payload.codeVerifier,
		timestamp: Date.now(),
		nonce: randomBytes(16).toString("hex"),
	};

	const json = JSON.stringify(fullPayload);
	const data = Buffer.from(json, "utf8").toString("base64url");
	const key = getEncryptionKey(secretKey);
	const sig = createHmac("sha256", key).update(data).digest("base64url");
	return `${data}.${sig}`;
}

export function verifySignedOAuthState(
	state: string,
	maxAgeMs = 15 * 60 * 1000,
	secretKey?: string | Buffer,
): OAuthStatePayload {
	if (!state || typeof state !== "string") {
		throw new OAuthStateError("Invalid or missing state parameter");
	}

	const parts = state.split(".");
	if (parts.length !== 2) {
		throw new OAuthStateError(
			"Malformed state format: expected payload.signature",
		);
	}

	const [data, sig] = parts;
	if (!data || !sig) {
		throw new OAuthStateError(
			"Malformed state format: empty payload or signature",
		);
	}

	const key = getEncryptionKey(secretKey);
	const expectedSig = createHmac("sha256", key)
		.update(data)
		.digest("base64url");

	const sigBuf = Buffer.from(sig);
	const expBuf = Buffer.from(expectedSig);

	if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
		throw new OAuthStateError("Invalid state signature: tampering detected");
	}

	let payload: OAuthStatePayload;
	try {
		const json = Buffer.from(data, "base64url").toString("utf8");
		payload = JSON.parse(json) as OAuthStatePayload;
	} catch (err) {
		throw new OAuthStateError("Malformed state JSON content", { cause: err });
	}

	if (
		!payload.organizationId ||
		!payload.userId ||
		!payload.codeVerifier ||
		!payload.timestamp
	) {
		throw new OAuthStateError("State payload is missing required fields");
	}

	const age = Date.now() - payload.timestamp;
	if (age > maxAgeMs) {
		throw new OAuthStateError("State has expired");
	}
	if (age < -60_000) {
		// Clock skew protection: reject states claiming to be from far in the future
		throw new OAuthStateError("State timestamp is in the future");
	}

	return payload;
}

export function buildGoogleAuthUrl(params: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	scopes?: string[];
}): string {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", params.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set(
		"scope",
		(params.scopes ?? ["https://www.googleapis.com/auth/gmail.readonly"]).join(
			" ",
		),
	);
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}
