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
		command: "pnpm dev",
		url: "http://127.0.0.1:3000",
		reuseExistingServer: !process.env.CI,
		env: environment,
	},
});
