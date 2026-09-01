import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const createDb = (url: string) => drizzle(postgres(url));
export * from "./repositories.js";
export * from "./schema.js";
