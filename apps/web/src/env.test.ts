import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateWebEnvironment, webServerSchema } from "./env";

const valid = {
	DATABASE_URL: "postgresql://user:password@localhost:5432/mailsentinel",
	BETTER_AUTH_SECRET: "a".repeat(32),
	BETTER_AUTH_URL: "http://localhost:3000",
	ANALYZER_INTERNAL_URL: "http://localhost:8000",
	ANALYZER_SERVICE_TOKEN: "b".repeat(24),
	S3_ENDPOINT: "http://localhost:9000",
	S3_REGION: "us-east-1",
	S3_BUCKET: "mailsentinel-evidence",
	S3_ACCESS_KEY_ID: "mailsentinel",
	S3_SECRET_ACCESS_KEY: "local-secret-value",
	S3_FORCE_PATH_STYLE: "true",
	MAX_EML_BYTES: "26214400",
	APP_ENV: "development",
	WEB_DATA_MODE: "fixture",
};

describe("web environment", () => {
	it("accepts development fixture configuration", () =>
		expect(validateWebEnvironment(valid)).toMatchObject({
			WEB_DATA_MODE: "fixture",
		}));
	it.each([
		["missing core secret", { ...valid, BETTER_AUTH_SECRET: undefined }],
		["short secret", { ...valid, BETTER_AUTH_SECRET: "short" }],
		["invalid URL", { ...valid, DATABASE_URL: "not-a-url" }],
		["invalid numeric limit", { ...valid, MAX_EML_BYTES: "0" }],
		["invalid mode", { ...valid, WEB_DATA_MODE: "maybe" }],
	])("rejects %s", (_name, input) =>
		expect(() => validateWebEnvironment(input)).toThrow());
	it("requires complete connector configuration when mailbox support is enabled", () => {
		expect(() =>
			validateWebEnvironment({ ...valid, MAILBOX_CONNECTORS_ENABLED: "true" }),
		).toThrow(/ENCRYPTION_KEY/i);
		expect(
			validateWebEnvironment({
				...valid,
				MAILBOX_CONNECTORS_ENABLED: "true",
				MAILBOX_TOKEN_ENCRYPTION_KEY: "k".repeat(32),
				GOOGLE_OAUTH_CLIENT_ID: "client-id",
				GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
				GMAIL_REDIRECT_URI: "http://localhost:3000/api/mailbox/gmail/callback",
			}),
		).toMatchObject({ MAILBOX_CONNECTORS_ENABLED: true });
	});
	it.each([
		["database URL", "NEXT_PUBLIC_DATABASE_URL"],
		["API key", "NEXT_PUBLIC_PROVIDER_API_KEY"],
	])("rejects browser-exposed %s", (_name, key) =>
		expect(() => validateWebEnvironment({ ...valid, [key]: "secret" })).toThrow(
			/NEXT_PUBLIC/,
		));
	it("documents every schema variable", () => {
		const documented = new Set(
			readFileSync(new URL("../.env.example", import.meta.url), "utf8").match(
				/^[A-Z][A-Z0-9_]*(?==)/gm,
			),
		);
		for (const key of webServerSchema.keyof().options)
			expect(documented.has(key)).toBe(true);
	});
});
