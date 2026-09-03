import {
	DrizzleAuditRepository,
	DrizzleMailboxConnectionRepository,
	memberships,
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
	const error = url.searchParams.get("error");
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");

	if (error) {
		logger.warn("mailbox.oauth_callback_error", { error });
		return Response.redirect(
			new URL(`/settings?error=${encodeURIComponent(error)}`, request.url),
			302,
		);
	}

	if (!code || !state) {
		return Response.redirect(
			new URL("/settings?error=missing_code_or_state", request.url),
			302,
		);
	}

	// 1. Verify signed organization-scoped state and extract PKCE code_verifier
	let statePayload: ReturnType<typeof verifySignedOAuthState>;
	try {
		statePayload = verifySignedOAuthState(state);
	} catch (err) {
		logger.warn("mailbox.oauth_state_invalid", {
			reason: err instanceof Error ? err.message : "unknown",
		});
		return Response.redirect(
			new URL("/settings?error=invalid_state", request.url),
			302,
		);
	}

	// 2. Verify current user session matches state payload
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user || session.user.id !== statePayload.userId) {
		return Response.redirect(
			new URL("/settings?error=unauthorized_session", request.url),
			302,
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
		return Response.redirect(
			new URL("/settings?error=owner_role_required", request.url),
			302,
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
		return Response.redirect(
			new URL("/settings?error=token_exchange_failed", request.url),
			302,
		);
	}

	if (!tokenResponse.refreshToken) {
		logger.warn("mailbox.missing_refresh_token", {
			organizationId: statePayload.organizationId,
		});
		return Response.redirect(
			new URL("/settings?error=missing_refresh_token", request.url),
			302,
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
		return Response.redirect(
			new URL("/settings?error=profile_fetch_failed", request.url),
			302,
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

	return Response.redirect(
		new URL("/settings?mailbox_connected=true", request.url),
		302,
	);
}
