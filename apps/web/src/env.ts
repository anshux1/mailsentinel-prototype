import "server-only";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const webServerSchema = z.object({
	DATABASE_URL: z.url(),
	BETTER_AUTH_SECRET: z.string().min(32),
	BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
	ANALYZER_INTERNAL_URL: z.url().default("http://localhost:8000"),
	ANALYZER_SERVICE_TOKEN: z.string().min(16),
	S3_ENDPOINT: z.url().default("http://localhost:9000"),
	S3_REGION: z.string().min(1).default("us-east-1"),
	S3_BUCKET: z.string().min(1).default("mailsentinel-evidence"),
	S3_ACCESS_KEY_ID: z.string().min(1),
	S3_SECRET_ACCESS_KEY: z.string().min(16),
	S3_FORCE_PATH_STYLE: z
		.enum(["true", "false"])
		.default("true")
		.transform((value) => value === "true"),
	MAX_EML_BYTES: z.coerce.number().int().positive().default(26_214_400),
	MAX_CONTAINER_BYTES: z.coerce
		.number()
		.int()
		.positive()
		.max(536_870_912)
		.default(104_857_600),
	APP_ENV: z
		.enum(["development", "test", "demo", "production"])
		.default("development"),
	WEB_DATA_MODE: z.enum(["live", "fixture", "offline"]).default("fixture"),
	MAILBOX_CONNECTORS_ENABLED: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),
	MAILBOX_TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),
	MAILBOX_SYNC_MAX_MESSAGES: z.coerce
		.number()
		.int()
		.min(1)
		.max(1000)
		.default(200),
	GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
	GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
	// Legacy aliases remain supported for existing deployments.
	GMAIL_CLIENT_ID: z.string().optional(),
	GMAIL_CLIENT_SECRET: z.string().optional(),
	GMAIL_REDIRECT_URI: z.url().optional(),
});

const publicSecretName =
	/(SECRET|TOKEN|PASSWORD|DATABASE|ACCESS_KEY|API_KEY|PRIVATE|CREDENTIAL)/;

function rejectPublicSecretNames(values: Record<string, string | undefined>) {
	for (const name of Object.keys(values)) {
		if (name.startsWith("NEXT_PUBLIC_") && publicSecretName.test(name)) {
			throw new Error(`Potential secret must not use NEXT_PUBLIC_: ${name}`);
		}
	}
}

export function validateWebEnvironment(
	values: Record<string, string | undefined>,
) {
	rejectPublicSecretNames(values);
	const parsed = webServerSchema.parse(values);
	assertMailboxConfiguration(parsed);
	return parsed;
}

function assertMailboxConfiguration(
	values: z.infer<typeof webServerSchema>,
): void {
	if (!values.MAILBOX_CONNECTORS_ENABLED) return;
	const encryptionKey = values.MAILBOX_TOKEN_ENCRYPTION_KEY;
	if (!encryptionKey || Buffer.byteLength(encryptionKey, "utf8") < 32) {
		throw new Error(
			"MAILBOX_TOKEN_ENCRYPTION_KEY must contain at least 32 bytes when mailbox connectors are enabled",
		);
	}
	if (!(values.GOOGLE_OAUTH_CLIENT_ID ?? values.GMAIL_CLIENT_ID)?.trim()) {
		throw new Error(
			"Google OAuth client ID is required when mailbox connectors are enabled",
		);
	}
	if (
		!(values.GOOGLE_OAUTH_CLIENT_SECRET ?? values.GMAIL_CLIENT_SECRET)?.trim()
	) {
		throw new Error(
			"Google OAuth client secret is required when mailbox connectors are enabled",
		);
	}
	if (!values.GMAIL_REDIRECT_URI) {
		throw new Error(
			"GMAIL_REDIRECT_URI is required when mailbox connectors are enabled",
		);
	}
	if (
		values.APP_ENV === "production" &&
		new URL(values.GMAIL_REDIRECT_URI).protocol !== "https:"
	) {
		throw new Error("GMAIL_REDIRECT_URI must use HTTPS in production");
	}
}

rejectPublicSecretNames(process.env);

export const env = createEnv({
	server: webServerSchema.shape,
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
		MAX_CONTAINER_BYTES: process.env.MAX_CONTAINER_BYTES,
		APP_ENV: process.env.APP_ENV,
		WEB_DATA_MODE: process.env.WEB_DATA_MODE,
		MAILBOX_CONNECTORS_ENABLED: process.env.MAILBOX_CONNECTORS_ENABLED,
		MAILBOX_TOKEN_ENCRYPTION_KEY: process.env.MAILBOX_TOKEN_ENCRYPTION_KEY,
		MAILBOX_SYNC_MAX_MESSAGES: process.env.MAILBOX_SYNC_MAX_MESSAGES,
		GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
		GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
		GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID,
		GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET,
		GMAIL_REDIRECT_URI: process.env.GMAIL_REDIRECT_URI,
	},
	skipValidation: process.env.NODE_ENV === "test",
});

if (process.env.NODE_ENV !== "test") {
	assertMailboxConfiguration(env);
}
