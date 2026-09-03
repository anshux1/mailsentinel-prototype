import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock env
vi.mock("@/env", () => ({
	env: {
		MAILBOX_CONNECTORS_ENABLED: false,
		MAILBOX_TOKEN_ENCRYPTION_KEY:
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		GMAIL_CLIENT_ID: "test_client_id_123",
		GMAIL_CLIENT_SECRET: "test_client_secret_456",
		GMAIL_REDIRECT_URI: "http://localhost:3000/api/mailbox/gmail/callback",
	},
}));

// Mock auth
const mockSession = {
	user: { id: "user_owner", email: "owner@example.com" },
};
let currentSession: typeof mockSession | null = mockSession;

vi.mock("@/server/auth", () => ({
	auth: {
		api: {
			getSession: vi.fn(async () => currentSession),
		},
	},
}));

// Mock db memberships and one-time OAuth state consumption
let memberRole = "owner";
let oauthStateAvailable = true;
vi.mock("@/server/db", () => ({
	db: {
		query: {
			memberships: {
				findFirst: vi.fn(async () => {
					if (!memberRole) return null;
					return {
						id: "mem_1",
						organizationId: "org_alpha",
						userId: "user_owner",
						role: memberRole,
					};
				}),
			},
		},
		delete: vi.fn(() => ({
			where: vi.fn(() => ({
				returning: vi.fn(async () => {
					if (!oauthStateAvailable) return [];
					oauthStateAvailable = false;
					return [{ expiresAt: new Date(Date.now() + 60_000) }];
				}),
			})),
		})),
		insert: vi.fn(() => ({
			values: vi.fn(() => ({
				onConflictDoUpdate: vi.fn(() => ({
					returning: vi.fn(async () => [
						{
							id: "conn_123",
							organizationId: "org_alpha",
							provider: "gmail",
							accountEmail: "user@gmail.com",
							encryptedRefreshToken: "enc_refresh_token",
							tokenNonce: "nonce",
							scopes: "https://www.googleapis.com/auth/gmail.readonly",
							syncCursor: "100",
							status: "connected",
							lastSyncedAt: null,
							lastFailureReason: null,
							createdByUserId: "user_owner",
							createdAt: new Date(),
							updatedAt: new Date(),
						},
					]),
				})),
				returning: vi.fn(async () => [
					{
						id: "audit_123",
						organizationId: "org_alpha",
						action: "mailbox.connected",
						resourceType: "mailbox_connection",
						resourceId: "conn_123",
						createdAt: new Date(),
					},
				]),
			})),
		})),
	},
}));

// Mock gmail client
vi.mock("@/server/mailbox/client", () => ({
	defaultGmailClient: {
		exchangeCode: vi.fn(async () => ({
			accessToken: "mock_access_token",
			refreshToken: "mock_refresh_token_to_encrypt",
			scope: "https://www.googleapis.com/auth/gmail.readonly",
		})),
		getProfile: vi.fn(async () => ({
			emailAddress: "user@gmail.com",
			historyId: "12345",
		})),
	},
}));

import { GET as callbackHandler } from "@/app/api/mailbox/gmail/callback/route";
import { GET as startHandler } from "@/app/api/mailbox/gmail/start/route";
import { env } from "@/env";
import { createSignedOAuthState, generateCodeVerifier } from "./oauth";

describe("Mailbox OAuth Routes (/start & /callback)", () => {
	describe("GET /api/mailbox/gmail/start", () => {
		it("returns 403 Forbidden when MAILBOX_CONNECTORS_ENABLED is false", async () => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = false;

			const request = new Request(
				"http://localhost:3000/api/mailbox/gmail/start?organizationId=org_alpha",
			);
			const response = await startHandler(request);
			expect(response.status).toBe(403);
			const body = await response.json();
			expect(body.error).toBe("Mailbox connectors are disabled");
		});

		it("returns 401 when user is not authenticated", async () => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = true;
			currentSession = null;

			const request = new Request(
				"http://localhost:3000/api/mailbox/gmail/start?organizationId=org_alpha",
			);
			const response = await startHandler(request);
			expect(response.status).toBe(401);
		});

		it("returns 400 when organizationId is missing", async () => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = true;
			currentSession = mockSession;

			const request = new Request(
				"http://localhost:3000/api/mailbox/gmail/start",
			);
			const response = await startHandler(request);
			expect(response.status).toBe(400);
		});

		it("returns 403 when user is not an owner in the organization", async () => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = true;
			currentSession = mockSession;
			memberRole = "viewer";

			const request = new Request(
				"http://localhost:3000/api/mailbox/gmail/start?organizationId=org_alpha",
			);
			const response = await startHandler(request);
			expect(response.status).toBe(403);
		});

		it("returns 302 redirect with PKCE and signed state for owner", async () => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = true;
			currentSession = mockSession;
			memberRole = "owner";

			const request = new Request(
				"http://localhost:3000/api/mailbox/gmail/start?organizationId=org_alpha",
			);
			const response = await startHandler(request);
			expect(response.status).toBe(302);
			const location = response.headers.get("location");
			expect(location).toBeDefined();
			if (!location) throw new Error("redirect location missing");

			const redirectUrl = new URL(location);
			expect(redirectUrl.origin).toBe("https://accounts.google.com");
			expect(redirectUrl.pathname).toBe("/o/oauth2/v2/auth");
			expect(redirectUrl.searchParams.get("client_id")).toBe(
				"test_client_id_123",
			);
			expect(redirectUrl.searchParams.get("state")).toBeDefined();
			expect(redirectUrl.searchParams.get("code_challenge")).toBeDefined();
		});
	});

	describe("GET /api/mailbox/gmail/callback", () => {
		it("returns 403 Forbidden when MAILBOX_CONNECTORS_ENABLED is false", async () => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = false;

			const request = new Request(
				"http://localhost:3000/api/mailbox/gmail/callback?code=abc&state=xyz",
			);
			const response = await callbackHandler(request);
			expect(response.status).toBe(403);
		});

		it("redirects to error when Google returns an error", async () => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = true;

			const request = new Request(
				"http://localhost:3000/api/mailbox/gmail/callback?error=access_denied",
			);
			const response = await callbackHandler(request);
			expect(response.status).toBe(302);
			const location = response.headers.get("location");
			expect(location).toContain("error=oauth_denied");
		});

		it("redirects to error when state is invalid or tampered", async () => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = true;

			const request = new Request(
				"http://localhost:3000/api/mailbox/gmail/callback?code=abc&state=tampered.state",
			);
			const response = await callbackHandler(request);
			expect(response.status).toBe(302);
			const location = response.headers.get("location");
			expect(location).toContain("error=invalid_state");
		});

		it("completes full OAuth callback flow: exchanges code, encrypts token, creates connection", async () => {
			(
				env as { MAILBOX_CONNECTORS_ENABLED: boolean }
			).MAILBOX_CONNECTORS_ENABLED = true;
			currentSession = mockSession;
			memberRole = "owner";
			oauthStateAvailable = true;

			const verifier = generateCodeVerifier();
			const validState = createSignedOAuthState(
				{
					organizationId: "org_alpha",
					userId: "user_owner",
					codeVerifier: verifier,
				},
				env.MAILBOX_TOKEN_ENCRYPTION_KEY,
			);

			const stateBinding = createHash("sha256")
				.update(validState)
				.digest("base64url");
			const request = new Request(
				`http://localhost:3000/api/mailbox/gmail/callback?code=valid_code_123&state=${validState}`,
				{ headers: { cookie: `mailbox_oauth_state=${stateBinding}` } },
			);
			const response = await callbackHandler(request);
			expect(response.status).toBe(302);
			const location = response.headers.get("location");
			expect(location).toContain("mailbox_connected=true");

			const replay = await callbackHandler(request);
			expect(replay.headers.get("location")).toContain("error=invalid_state");
		});
	});
});
