import "server-only";

import { createAnalyzerClient } from "@mailsentinel/contracts/analyzer-client";
import { env } from "@/env";

/** Server-only client for the private FastAPI contract. */
export const analyzerClient = createAnalyzerClient({
	baseUrl: env.ANALYZER_INTERNAL_URL,
	serviceToken: env.ANALYZER_SERVICE_TOKEN,
});
