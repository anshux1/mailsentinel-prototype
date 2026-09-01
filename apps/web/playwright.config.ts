import { defineConfig, devices } from "@playwright/test";

const environment = {
	DATABASE_URL:
		process.env.DATABASE_URL ??
		"postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel",
	BETTER_AUTH_SECRET:
		process.env.BETTER_AUTH_SECRET ??
		"playwright-auth-secret-at-least-32-characters",
	BETTER_AUTH_URL: "http://127.0.0.1:3000",
	ANALYZER_INTERNAL_URL: "http://127.0.0.1:8000",
	ANALYZER_SERVICE_TOKEN: "playwright-analyzer-token",
	S3_ENDPOINT: "http://127.0.0.1:9000",
	S3_REGION: "us-east-1",
	S3_BUCKET: "mailsentinel-evidence",
	S3_ACCESS_KEY_ID: "mailsentinel",
	S3_SECRET_ACCESS_KEY: "mailsentinel-local-secret",
	S3_FORCE_PATH_STYLE: "true",
	APP_ENV: "test",
	WEB_DATA_MODE: "fixture",
};

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: { baseURL: "http://127.0.0.1:3000", trace: "on-first-retry" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: `DATABASE_URL='${environment.DATABASE_URL}' BETTER_AUTH_SECRET='${environment.BETTER_AUTH_SECRET}' BETTER_AUTH_URL='${environment.BETTER_AUTH_URL}' ANALYZER_INTERNAL_URL='${environment.ANALYZER_INTERNAL_URL}' ANALYZER_SERVICE_TOKEN='${environment.ANALYZER_SERVICE_TOKEN}' S3_ENDPOINT='${environment.S3_ENDPOINT}' S3_REGION='${environment.S3_REGION}' S3_BUCKET='${environment.S3_BUCKET}' S3_ACCESS_KEY_ID='${environment.S3_ACCESS_KEY_ID}' S3_SECRET_ACCESS_KEY='${environment.S3_SECRET_ACCESS_KEY}' S3_FORCE_PATH_STYLE='${environment.S3_FORCE_PATH_STYLE}' APP_ENV='${environment.APP_ENV}' WEB_DATA_MODE='${environment.WEB_DATA_MODE}' pnpm dev`,
		url: "http://127.0.0.1:3000",
		reuseExistingServer: !process.env.CI,
		env: environment,
	},
});
