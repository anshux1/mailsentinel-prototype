import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export const createDb = (url: string) => drizzle(postgres(url), { schema });
export * from "./repositories";
export * from "./schema";
