import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { router } from "./router";

const anonymous = {
	requestId: "request_test",
	userId: null,
	organizationId: null,
};

describe("application router", () => {
	it("returns typed health", async () => {
		const client = createRouterClient(router, { context: anonymous });
		await expect(client.system.health()).resolves.toMatchObject({
			ok: true,
			service: "web",
		});
	});

	it("protects tenant procedures", async () => {
		const client = createRouterClient(router, { context: anonymous });
		await expect(client.case.list()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});
