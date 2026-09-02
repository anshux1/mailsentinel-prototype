import { RPCHandler } from "@orpc/server/fetch";
import { createRpcContext } from "@/server/orpc/context";
import { router } from "@/server/orpc/router";

const handler = new RPCHandler(router);

async function handle(request: Request): Promise<Response> {
	const { response } = await handler.handle(request, {
		prefix: "/api/rpc",
		context: await createRpcContext(request),
	});
	return response ?? new Response("Not found", { status: 404 });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
