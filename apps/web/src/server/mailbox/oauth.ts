import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { decryptToken, encryptToken } from "./crypto";

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

	const encrypted = encryptToken(JSON.stringify(fullPayload), secretKey);
	return `v1.${encrypted.tokenNonce}.${encrypted.encryptedRefreshToken}`;
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
	if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
		throw new OAuthStateError("Malformed encrypted state format");
	}

	let payload: OAuthStatePayload;
	try {
		const json = decryptToken(
			{ encryptedRefreshToken: parts[2], tokenNonce: parts[1] },
			secretKey,
		);
		payload = JSON.parse(json) as OAuthStatePayload;
	} catch (err) {
		throw new OAuthStateError("Invalid encrypted state", { cause: err });
	}

	if (
		!payload.organizationId ||
		!payload.userId ||
		!payload.codeVerifier ||
		!payload.timestamp ||
		!payload.nonce ||
		!/^[A-Za-z0-9_-]{1,200}$/.test(payload.organizationId) ||
		!/^[A-Za-z0-9_-]{1,200}$/.test(payload.userId) ||
		!/^[A-Za-z0-9_-]{43,128}$/.test(payload.codeVerifier) ||
		!/^[a-f0-9]{32}$/.test(payload.nonce)
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
