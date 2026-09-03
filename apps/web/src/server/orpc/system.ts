import "server-only";

import { z } from "zod";
import { publicProcedure } from "./middleware";

export const systemHealthOutputSchema = z.object({
	ok: z.boolean(),
	service: z.literal("web"),
	timestamp: z.string(),
});

export type SystemHealthOutput = z.infer<typeof systemHealthOutputSchema>;

export const systemRouter = {
	health: publicProcedure
		.route({ method: "GET" })
		.output(systemHealthOutputSchema)
		.handler(() => ({
			ok: true,
			service: "web" as const,
			timestamp: new Date().toISOString(),
		})),
};
