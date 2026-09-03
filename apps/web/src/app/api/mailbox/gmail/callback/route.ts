import { createHash, timingSafeEqual } from "node:crypto";
import {
	DrizzleAuditRepository,
	DrizzleMailboxConnectionRepository,
	memberships,
	verification,
} from "@mailsentinel/db";
import { and, eq } from "drizzle-orm";
import { env } from "@/env";
import { recordAuditEvent } from "@/server/audit";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { defaultGmailClient } from "@/server/mailbox/client";
import { encryptToken } from "@/server/mailbox/crypto";
import { verifySignedOAuthState } from "@/server/mailbox/oauth";

export async function GET(request: Request): Promise<Response> {
	if (!env.MAILBOX_CONNECTORS_ENABLED) {
		return new Response(
			JSON.stringify({ error: "Mailbox connectors are disabled" }),
			{ status: 403, headers: { "Content-Type": "application/json" } },
		);
	}

	const url = new URL(request.url);
	const consumeStateAndRedirect = (target: URL): Response =>
		new Response(null, {
			status: 302,
			headers: {
				Location: target.toString(),
				"Set-Cookie":
					"mailbox_oauth_state=; Path=/api/mailbox/gmail/callback; HttpOnly; SameSite=Lax; Max-Age=0",
			},
		});
	const error = url.searchParams.get("error");
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");

	if (error) {
		logger.warn("mailbox.oauth_callback_denied");
		return consumeStateAndRedirect(
			new URL("/settings?error=oauth_denied", request.url),
		);
	}

	if (!code || !state) {
		return consumeStateAndRedirect(
			new URL("/settings?error=missing_code_or_state", request.url),
		);
	}

	const cookieBinding = request.headers
		.get("cookie")
		?.split(";")
		.map((part) => part.trim().split("="))
		.find(([name]) => name === "mailbox_oauth_state")?.[1];
	const expectedBinding = createHash("sha256")
		.update(state)
		.digest("base64url");
	const supplied = Buffer.from(cookieBinding ?? "", "utf8");
	const expected = Buffer.from(expectedBinding, "utf8");
	if (
		supplied.byteLength !== expected.byteLength ||
		!timingSafeEqual(supplied, expected)
	) {
		return consumeStateAndRedirect(
			new URL("/settings?error=invalid_state", request.url),
		);
	}
	const consumed = await db
		.delete(verification)
		.where(
			and(
				eq(verification.identifier, `mailbox-oauth:${expectedBinding}`),
				eq(verification.value, expectedBinding),
			),
		)
		.returning({ expiresAt: verification.expiresAt });
	if (!consumed[0] || consumed[0].expiresAt.getTime() < Date.now()) {
		return consumeStateAndRedirect(
			new URL("/settings?error=invalid_state", request.url),
		);
	}

	// 1. Decrypt organization-scoped state and extract PKCE code_verifier.
	let statePayload: ReturnType<typeof verifySignedOAuthState>;
	try {
		statePayload = verifySignedOAuthState(state);
	} catch (err) {
		logger.warn("mailbox.oauth_state_invalid", {
			reason: err instanceof Error ? err.message : "unknown",
		});
		return consumeStateAndRedirect(
			new URL("/settings?error=invalid_state", request.url),
		);
	}

	// 2. Verify current user session matches state payload
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user || session.user.id !== statePayload.userId) {
		return consumeStateAndRedirect(
			new URL("/settings?error=unauthorized_session", request.url),
		);
	}

	// 3. Verify user retains owner role in organization
	const member = await db.query.memberships.findFirst({
		where: and(
			eq(memberships.organizationId, statePayload.organizationId),
			eq(memberships.userId, session.user.id),
		),
	});

	if (!member || member.role !== "owner") {
		return consumeStateAndRedirect(
			new URL("/settings?error=owner_role_required", request.url),
		);
	}

	// 4. Exchange authorization code with PKCE for tokens
	const redirectUri =
		env.GMAIL_REDIRECT_URI ??
		new URL("/api/mailbox/gmail/callback", request.url).toString();

	let tokenResponse: Awaited<
		ReturnType<typeof defaultGmailClient.exchangeCode>
	>;
	try {
		tokenResponse = await defaultGmailClient.exchangeCode({
			code,
			codeVerifier: statePayload.codeVerifier,
			redirectUri,
		});
	} catch {
		logger.warn("mailbox.token_exchange_failed", {
			organizationId: statePayload.organizationId,
		});
		return consumeStateAndRedirect(
			new URL("/settings?error=token_exchange_failed", request.url),
		);
	}

	const grantedScopes = new Set(
		(tokenResponse.scope ?? "").split(/\s+/).filter(Boolean),
	);
	const requiredScope = "https://www.googleapis.com/auth/gmail.readonly";
	if (grantedScopes.size !== 1 || !grantedScopes.has(requiredScope)) {
		logger.warn("mailbox.oauth_scope_rejected", {
			organizationId: statePayload.organizationId,
		});
		return consumeStateAndRedirect(
			new URL("/settings?error=invalid_scope", request.url),
		);
	}

	if (!tokenResponse.refreshToken) {
		logger.warn("mailbox.missing_refresh_token", {
			organizationId: statePayload.organizationId,
		});
		return consumeStateAndRedirect(
			new URL("/settings?error=missing_refresh_token", request.url),
		);
	}

	// 5. Encrypt refresh token with AES-256-GCM
	const encrypted = encryptToken(tokenResponse.refreshToken);

	// 6. Fetch user profile from Gmail
	let profile: Awaited<ReturnType<typeof defaultGmailClient.getProfile>>;
	try {
		profile = await defaultGmailClient.getProfile({
			accessToken: tokenResponse.accessToken,
		});
	} catch {
		return consumeStateAndRedirect(
			new URL("/settings?error=profile_fetch_failed", request.url),
		);
	}

	// 7. Upsert connection in database
	const mailboxRepo = new DrizzleMailboxConnectionRepository(db);
	const auditRepo = new DrizzleAuditRepository(db);

	const connection = await mailboxRepo.upsertConnection({
		organizationId: statePayload.organizationId,
		provider: "gmail",
		accountEmail: profile.emailAddress,
		encryptedRefreshToken: encrypted.encryptedRefreshToken,
		tokenNonce: encrypted.tokenNonce,
		scopes:
			tokenResponse.scope ?? "https://www.googleapis.com/auth/gmail.readonly",
		syncCursor: profile.historyId ?? null,
		status: "connected",
		createdByUserId: session.user.id,
	});

	// 8. Record audit event (NEVER leak tokens or headers)
	await recordAuditEvent(auditRepo, {
		organizationId: statePayload.organizationId,
		actorUserId: session.user.id,
		action: "mailbox.connected",
		resourceType: "mailbox_connection",
		resourceId: connection.id,
		requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
		metadata: {
			provider: "gmail",
			accountEmail: profile.emailAddress,
		},
	});

	return consumeStateAndRedirect(
		new URL("/settings?mailbox_connected=true", request.url),
	);
}
