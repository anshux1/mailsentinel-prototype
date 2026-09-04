/**
 * The Gmail callback cannot render UI — it is a redirect handler — so it
 * reports the outcome as a query parameter on `/settings`. These are the codes
 * `apps/web/src/app/api/mailbox/gmail/callback/route.ts` can produce. Anything
 * unrecognised falls back to generic copy rather than being echoed back into
 * the page.
 */
export const MAILBOX_OAUTH_ERRORS: Record<string, string> = {
	oauth_denied: "You declined the Google consent screen, so nothing changed.",
	missing_code_or_state: "Google returned an incomplete response. Try again.",
	invalid_state:
		"That authorization link expired or did not match this browser. Start the connection again.",
	unauthorized_session:
		"The sign-in that started this connection is no longer the active session.",
	owner_role_required:
		"Connecting a mailbox requires the owner role in this organization.",
	token_exchange_failed:
		"Google refused to issue tokens for this connection. Check the OAuth client configuration.",
	invalid_scope:
		"The consent screen did not grant exactly the read-only Gmail scope this connector requires.",
	missing_refresh_token:
		"Google did not return a refresh token. Remove the app's existing access in your Google account, then connect again.",
	profile_fetch_failed:
		"The mailbox connected, but its profile could not be read. Try again.",
};

export function mailboxOAuthErrorMessage(code: string): string {
	return (
		MAILBOX_OAUTH_ERRORS[code] ??
		"The mailbox connection could not be completed. Try again."
	);
}
