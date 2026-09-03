import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	buildGoogleAuthUrl,
	createSignedOAuthState,
	generateCodeChallenge,
	generateCodeVerifier,
	OAuthStateError,
	verifySignedOAuthState,
} from "./oauth";

describe("Mailbox OAuth (PKCE & Signed State)", () => {
	const secretKey =
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

	describe("PKCE helpers", () => {
		it("generates random high-entropy base64url code verifiers", () => {
			const v1 = generateCodeVerifier();
			const v2 = generateCodeVerifier();
			expect(v1).not.toBe(v2);
			expect(v1.length).toBeGreaterThanOrEqual(43);
			expect(/^[A-Za-z0-9_-]+$/.test(v1)).toBe(true);
		});

		it("generates deterministic base64url SHA-256 challenges from verifier", () => {
			const verifier = "sample_test_verifier_for_pkce_testing_12345";
			const c1 = generateCodeChallenge(verifier);
			const c2 = generateCodeChallenge(verifier);
			expect(c1).toBe(c2);
			expect(/^[A-Za-z0-9_-]+$/.test(c1)).toBe(true);
		});
	});

	describe("Signed State helpers", () => {
		it("creates and verifies signed state successfully", () => {
			const verifier = generateCodeVerifier();
			const state = createSignedOAuthState(
				{
					organizationId: "org_alpha",
					userId: "user_owner",
					codeVerifier: verifier,
				},
				secretKey,
			);

			expect(typeof state).toBe("string");
			expect(state.includes(".")).toBe(true);

			const payload = verifySignedOAuthState(state, 60_000, secretKey);
			expect(payload.organizationId).toBe("org_alpha");
			expect(payload.userId).toBe("user_owner");
			expect(payload.codeVerifier).toBe(verifier);
			expect(payload.nonce).toBeDefined();
			expect(payload.timestamp).toBeLessThanOrEqual(Date.now());
		});

		it("detects tampering in encrypted state ciphertext", () => {
			const state = createSignedOAuthState(
				{
					organizationId: "org_alpha",
					userId: "user_owner",
					codeVerifier: generateCodeVerifier(),
				},
				secretKey,
			);
			const parts = state.split(".");
			expect(parts).toHaveLength(3);
			const ciphertext = parts[2] ?? "";
			const replacement = ciphertext.startsWith("a") ? "b" : "a";
			parts[2] = `${replacement}${ciphertext.slice(1)}`;
			expect(() =>
				verifySignedOAuthState(parts.join("."), 60_000, secretKey),
			).toThrow(OAuthStateError);
		});

		it("does not expose organization, user, or PKCE verifier in state", () => {
			const verifier = generateCodeVerifier();
			const state = createSignedOAuthState(
				{
					organizationId: "org_alpha",
					userId: "user_owner",
					codeVerifier: verifier,
				},
				secretKey,
			);
			expect(state).not.toContain("org_alpha");
			expect(state).not.toContain("user_owner");
			expect(state).not.toContain(verifier);
		});

		it("rejects expired state", async () => {
			const verifier = generateCodeVerifier();
			const state = createSignedOAuthState(
				{
					organizationId: "org_alpha",
					userId: "user_owner",
					codeVerifier: verifier,
				},
				secretKey,
			);

			// maxAge 1ms, wait 10ms
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(() => verifySignedOAuthState(state, 1, secretKey)).toThrow(
				OAuthStateError,
			);
		});

		it("fails verification with a different secret key", () => {
			const verifier = generateCodeVerifier();
			const state = createSignedOAuthState(
				{
					organizationId: "org_alpha",
					userId: "user_owner",
					codeVerifier: verifier,
				},
				secretKey,
			);

			const differentKey =
				"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
			expect(() => verifySignedOAuthState(state, 60_000, differentKey)).toThrow(
				OAuthStateError,
			);
		});
	});

	describe("Google Auth URL builder", () => {
		it("constructs valid URL with gmail.readonly scope and offline access", () => {
			const urlStr = buildGoogleAuthUrl({
				clientId: "test-google-client-id",
				redirectUri: "http://localhost:3000/api/mailbox/gmail/callback",
				state: "test-signed-state",
				codeChallenge: "test-code-challenge",
			});

			const url = new URL(urlStr);
			expect(url.origin).toBe("https://accounts.google.com");
			expect(url.pathname).toBe("/o/oauth2/v2/auth");
			expect(url.searchParams.get("client_id")).toBe("test-google-client-id");
			expect(url.searchParams.get("redirect_uri")).toBe(
				"http://localhost:3000/api/mailbox/gmail/callback",
			);
			expect(url.searchParams.get("response_type")).toBe("code");
			expect(url.searchParams.get("scope")).toBe(
				"https://www.googleapis.com/auth/gmail.readonly",
			);
			expect(url.searchParams.get("access_type")).toBe("offline");
			expect(url.searchParams.get("prompt")).toBe("consent");
			expect(url.searchParams.get("state")).toBe("test-signed-state");
			expect(url.searchParams.get("code_challenge")).toBe(
				"test-code-challenge",
			);
			expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		});
	});
});
