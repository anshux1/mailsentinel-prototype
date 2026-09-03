import { memberships } from "@mailsentinel/db";
import { and, eq } from "drizzle-orm";
import { env } from "@/env";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import {
	buildGoogleAuthUrl,
	createSignedOAuthState,
	generateCodeChallenge,
	generateCodeVerifier,
} from "@/server/mailbox/oauth";

export async function GET(request: Request): Promise<Response> {
	if (!env.MAILBOX_CONNECTORS_ENABLED) {
		return new Response(
			JSON.stringify({ error: "Mailbox connectors are disabled" }),
			{ status: 403, headers: { "Content-Type": "application/json" } },
		);
	}

	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return new Response(JSON.stringify({ error: "Authentication required" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	const url = new URL(request.url);
	const organizationId =
		url.searchParams.get("organizationId") ||
		request.headers.get("x-organization-id") ||
		request.headers.get("x-org-id");

	if (!organizationId) {
		return new Response(
			JSON.stringify({ error: "organizationId query parameter is required" }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	// Owner role verification
	const member = await db.query.memberships.findFirst({
		where: and(
			eq(memberships.organizationId, organizationId),
			eq(memberships.userId, session.user.id),
		),
	});

	if (!member || member.role !== "owner") {
		return new Response(
			JSON.stringify({
				error: "Role 'owner' is required to connect a mailbox",
			}),
			{ status: 403, headers: { "Content-Type": "application/json" } },
		);
	}

	const clientId = env.GOOGLE_OAUTH_CLIENT_ID ?? env.GMAIL_CLIENT_ID;
	if (!clientId) {
		return new Response(
			JSON.stringify({ error: "GMAIL_CLIENT_ID is not configured" }),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}

	const codeVerifier = generateCodeVerifier();
	const codeChallenge = generateCodeChallenge(codeVerifier);
	const state = createSignedOAuthState({
		organizationId,
		userId: session.user.id,
		codeVerifier,
	});

	const redirectUri =
		env.GMAIL_REDIRECT_URI ??
		new URL("/api/mailbox/gmail/callback", request.url).toString();

	const googleAuthUrl = buildGoogleAuthUrl({
		clientId,
		redirectUri,
		state,
		codeChallenge,
	});

	return Response.redirect(googleAuthUrl, 302);
}
