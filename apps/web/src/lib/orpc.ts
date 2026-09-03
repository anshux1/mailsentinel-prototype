"use client";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouter } from "@/server/orpc/router";
import { getActiveOrganizationId } from "./active-organization";

const link = new RPCLink({
	url: () => `${window.location.origin}/api/rpc`,
	/**
	 * Tenant context travels as a header on every call. It is resolved lazily so
	 * that switching organizations takes effect on the next request without
	 * rebuilding the client.
	 */
	headers: () => {
		const organizationId = getActiveOrganizationId();
		return organizationId ? { "x-organization-id": organizationId } : {};
	},
});

export const orpcClient: RouterClient<AppRouter> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(orpcClient);
