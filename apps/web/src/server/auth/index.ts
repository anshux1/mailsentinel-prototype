import "server-only";

import { createAuth } from "@mailsentinel/auth";
import { env } from "@/env";

if (!env.DATABASE_URL || !env.BETTER_AUTH_SECRET) {
	throw new Error(
		"DATABASE_URL and BETTER_AUTH_SECRET are required to initialize authentication",
	);
}

export const auth = createAuth({
	databaseUrl: env.DATABASE_URL,
	secret: env.BETTER_AUTH_SECRET,
	baseUrl: env.BETTER_AUTH_URL,
});
