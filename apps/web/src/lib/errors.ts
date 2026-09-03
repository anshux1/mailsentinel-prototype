import { ORPCError } from "@orpc/client";

/**
 * The server deliberately returns stable codes plus a request id and never raw
 * database/storage/analyzer detail. This maps those codes to copy an
 * investigator can act on, and never invents detail the server withheld.
 */
const MESSAGES: Record<string, string> = {
	UNAUTHORIZED: "Your session has expired. Sign in to continue.",
	FORBIDDEN: "You do not have permission to do this in this organization.",
	MISSING_ACTIVE_ORGANIZATION:
		"Select an organization before running this action.",
	INVALID_ORGANIZATION_HEADER: "That organization identifier is not valid.",
	NOT_FOUND: "That record no longer exists, or is not in this organization.",
	CONFLICT: "This conflicts with the current state of the record.",
	PAYLOAD_TOO_LARGE: "That file is larger than the configured evidence limit.",
	BAD_REQUEST: "Some of the details supplied are not valid.",
	DEPENDENCY_ERROR: "A required service is unavailable. Try again shortly.",
	BAD_GATEWAY: "A required service is unavailable. Try again shortly.",
	REPOSITORY_ERROR: "The workspace database is unavailable. Try again shortly.",
	INTERNAL_SERVER_ERROR: "Something went wrong. Try again.",
};

export function errorCode(error: unknown): string | undefined {
	if (error instanceof ORPCError) {
		const data = error.data as { code?: string } | undefined;
		return data?.code ?? error.code;
	}
	return undefined;
}

export function errorStatus(error: unknown): number | undefined {
	return error instanceof ORPCError ? error.status : undefined;
}

export function requestId(error: unknown): string | undefined {
	if (!(error instanceof ORPCError)) return undefined;
	const data = error.data as { requestId?: string } | undefined;
	return data?.requestId;
}

export function safeErrorMessage(
	error: unknown,
	fallback = "Something went wrong. Try again.",
): string {
	const code = errorCode(error);
	if (code && MESSAGES[code]) return MESSAGES[code];
	if (error instanceof ORPCError && error.message) return error.message;
	return fallback;
}

export function isUnauthorized(error: unknown): boolean {
	return errorStatus(error) === 401 || errorCode(error) === "UNAUTHORIZED";
}

export function isMissingOrganization(error: unknown): boolean {
	return errorCode(error) === "MISSING_ACTIVE_ORGANIZATION";
}

export function isForbidden(error: unknown): boolean {
	return errorStatus(error) === 403;
}

export function isNotFound(error: unknown): boolean {
	return errorStatus(error) === 404;
}
