"use client";

/**
 * The server never picks an active organization implicitly — every tenant
 * request must carry `x-organization-id`. This tiny store is the single place
 * the browser holds that choice, so both the oRPC link (which needs it
 * synchronously, outside React) and React components read the same value.
 */

const STORAGE_KEY = "mailsentinel.active-organization";

let activeOrganizationId: string | null = null;
const listeners = new Set<() => void>();

function readStorage(): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(STORAGE_KEY);
	} catch {
		// Private mode or blocked site data — fall back to in-memory only.
		return null;
	}
}

function writeStorage(value: string | null) {
	if (typeof window === "undefined") return;
	try {
		if (value === null) window.localStorage.removeItem(STORAGE_KEY);
		else window.localStorage.setItem(STORAGE_KEY, value);
	} catch {
		// Ignore: the in-memory value still drives this session.
	}
}

export function getActiveOrganizationId(): string | null {
	if (activeOrganizationId === null) activeOrganizationId = readStorage();
	return activeOrganizationId;
}

export function setActiveOrganizationId(organizationId: string | null): void {
	if (activeOrganizationId === organizationId) return;
	activeOrganizationId = organizationId;
	writeStorage(organizationId);
	for (const listener of listeners) listener();
}

export function subscribeToActiveOrganization(
	listener: () => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export { STORAGE_KEY as ACTIVE_ORGANIZATION_STORAGE_KEY };
