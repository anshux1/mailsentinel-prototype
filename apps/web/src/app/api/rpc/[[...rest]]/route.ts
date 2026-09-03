import { RPCHandler } from "@orpc/server/fetch";
import { logger } from "@/server/logger";
import { createRpcContext } from "@/server/orpc/context";
import { router } from "@/server/orpc/router";

const handler = new RPCHandler(router);

async function handle(request: Request): Promise<Response> {
	const startTime = Date.now();
	const context = await createRpcContext(request);

	const { response } = await handler.handle(request, {
		prefix: "/api/rpc",
		context,
	});

	const finalResponse = response ?? new Response("Not found", { status: 404 });
	finalResponse.headers.set("x-request-id", context.requestId);

	logger.info("rpc.request_completed", {
		requestId: context.requestId,
		organizationId: context.organizationId,
		userId: context.userId,
		status: finalResponse.status,
		durationMs: Date.now() - startTime,
	});

	return finalResponse;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
