import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

export const createDb = (url: string) => drizzle(postgres(url));
export * from "./schema.js";
