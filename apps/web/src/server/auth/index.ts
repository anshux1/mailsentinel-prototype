import "server-only";

import { createAuth } from "@mailsentinel/auth";
import { env } from "@/env";

export const auth = createAuth({
	databaseUrl: env.DATABASE_URL,
	secret: env.BETTER_AUTH_SECRET,
	baseUrl: env.BETTER_AUTH_URL,
});
