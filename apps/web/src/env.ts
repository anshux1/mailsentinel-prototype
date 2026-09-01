import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
	server: {
		DATABASE_URL: z.string().url().optional(),
		BETTER_AUTH_SECRET: z.string().min(32).optional(),
		BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
		ANALYZER_INTERNAL_URL: z.string().url().default("http://localhost:8000"),
		ANALYZER_SERVICE_TOKEN: z.string().min(16).optional(),
		S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
		S3_REGION: z.string().min(1).default("us-east-1"),
		S3_BUCKET: z.string().min(1).default("mailsentinel-evidence"),
		S3_ACCESS_KEY_ID: z.string().min(1).optional(),
		S3_SECRET_ACCESS_KEY: z.string().min(8).optional(),
		S3_FORCE_PATH_STYLE: z
			.enum(["true", "false"])
			.default("true")
			.transform((value) => value === "true"),
		MAX_EML_BYTES: z.coerce.number().int().positive().default(26214400),
		APP_ENV: z
			.enum(["development", "test", "demo", "production"])
			.default("development"),
		WEB_DATA_MODE: z.enum(["live", "fixture", "offline"]).default("fixture"),
	},
	client: {},
	runtimeEnv: {
		DATABASE_URL: process.env.DATABASE_URL,
		BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
		BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
		ANALYZER_INTERNAL_URL: process.env.ANALYZER_INTERNAL_URL,
		ANALYZER_SERVICE_TOKEN: process.env.ANALYZER_SERVICE_TOKEN,
		S3_ENDPOINT: process.env.S3_ENDPOINT,
		S3_REGION: process.env.S3_REGION,
		S3_BUCKET: process.env.S3_BUCKET,
		S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
		S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
		S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
		MAX_EML_BYTES: process.env.MAX_EML_BYTES,
		APP_ENV: process.env.APP_ENV,
		WEB_DATA_MODE: process.env.WEB_DATA_MODE,
	},
	skipValidation: process.env.NODE_ENV === "test",
});
