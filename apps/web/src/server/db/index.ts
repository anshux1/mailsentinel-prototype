import "server-only";

import { createDb } from "@mailsentinel/db";
import { env } from "@/env";

const globalDatabase = globalThis as typeof globalThis & {
	mailsentinelDb?: ReturnType<typeof createDb>;
};

export const db = globalDatabase.mailsentinelDb ?? createDb(env.DATABASE_URL);
if (env.APP_ENV === "development") globalDatabase.mailsentinelDb = db;
