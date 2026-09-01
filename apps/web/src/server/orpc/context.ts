import "server-only";

import { memberships } from "@mailsentinel/db";
import { eq } from "drizzle-orm";
import { auth } from "@/server/auth";
import { db } from "@/server/db";

export type RpcContext = {
	requestId: string;
	userId: string | null;
	organizationId: string | null;
};

export async function createRpcContext(request: Request): Promise<RpcContext> {
	const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
	if (!request.headers.get("cookie")?.includes("mailsentinel.session_token")) {
		return { requestId, userId: null, organizationId: null };
	}
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) return { requestId, userId: null, organizationId: null };
	const membership = await db.query.memberships.findFirst({
		where: eq(memberships.userId, session.user.id),
	});
	return {
		requestId,
		userId: session.user.id,
		organizationId: membership?.organizationId ?? null,
	};
}
