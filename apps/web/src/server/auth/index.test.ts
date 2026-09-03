import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@mailsentinel/auth", () => ({
	createAuth: vi.fn(() => ({})),
}));

import { resolveAuthConfig } from "./index";

describe("auth configuration resolution (resolveAuthConfig)", () => {
	const validConfig = {
		DATABASE_URL:
			"postgresql://prod-user:prod-pass@db.internal:5432/mailsentinel_prod",
		BETTER_AUTH_SECRET: "s".repeat(32),
		BETTER_AUTH_URL: "https://auth.mailsentinel.internal",
	};

	describe("when NODE_ENV === 'test'", () => {
		it("allows fallback defaults when values are omitted or empty", () => {
			const config = resolveAuthConfig({}, "test");
			expect(config.databaseUrl).toBe(
				"postgresql://user:password@localhost:5432/mailsentinel",
			);
			expect(config.secret).toBe(
				"default_auth_secret_for_development_32_chars",
			);
			expect(config.baseUrl).toBe("http://localhost:3000");
		});

		it("prefers explicitly provided environment values over defaults", () => {
			const config = resolveAuthConfig(validConfig, "test");
			expect(config.databaseUrl).toBe(validConfig.DATABASE_URL);
			expect(config.secret).toBe(validConfig.BETTER_AUTH_SECRET);
			expect(config.baseUrl).toBe(validConfig.BETTER_AUTH_URL);
		});
	});

	describe("when NODE_ENV !== 'test' (e.g. production, development)", () => {
		const nonTestEnvironments = [
			"production",
			"development",
			"staging",
			undefined,
		];

		for (const envName of nonTestEnvironments) {
			describe(`in ${envName ?? "undefined"} environment`, () => {
				it("rejects missing or empty DATABASE_URL and never returns hard-coded default", () => {
					expect(() =>
						resolveAuthConfig(
							{
								...validConfig,
								DATABASE_URL: undefined,
							},
							envName,
						),
					).toThrow(/DATABASE_URL is required outside test environment/);

					expect(() =>
						resolveAuthConfig(
							{
								...validConfig,
								DATABASE_URL: "",
							},
							envName,
						),
					).toThrow(/DATABASE_URL is required outside test environment/);

					expect(() =>
						resolveAuthConfig(
							{
								...validConfig,
								DATABASE_URL: "   ",
							},
							envName,
						),
					).toThrow(/DATABASE_URL is required outside test environment/);
				});

				it("rejects missing or empty BETTER_AUTH_SECRET and never returns hard-coded default", () => {
					expect(() =>
						resolveAuthConfig(
							{
								...validConfig,
								BETTER_AUTH_SECRET: undefined,
							},
							envName,
						),
					).toThrow(/BETTER_AUTH_SECRET is required outside test environment/);

					expect(() =>
						resolveAuthConfig(
							{
								...validConfig,
								BETTER_AUTH_SECRET: "",
							},
							envName,
						),
					).toThrow(/BETTER_AUTH_SECRET is required outside test environment/);

					expect(() =>
						resolveAuthConfig(
							{
								...validConfig,
								BETTER_AUTH_SECRET: "   ",
							},
							envName,
						),
					).toThrow(/BETTER_AUTH_SECRET is required outside test environment/);
				});

				it("rejects missing or empty BETTER_AUTH_URL and never returns hard-coded default", () => {
					expect(() =>
						resolveAuthConfig(
							{
								...validConfig,
								BETTER_AUTH_URL: undefined,
							},
							envName,
						),
					).toThrow(/BETTER_AUTH_URL is required outside test environment/);

					expect(() =>
						resolveAuthConfig(
							{
								...validConfig,
								BETTER_AUTH_URL: "",
							},
							envName,
						),
					).toThrow(/BETTER_AUTH_URL is required outside test environment/);
				});

				it("succeeds when all required variables are present", () => {
					const config = resolveAuthConfig(validConfig, envName);
					expect(config.databaseUrl).toBe(validConfig.DATABASE_URL);
					expect(config.secret).toBe(validConfig.BETTER_AUTH_SECRET);
					expect(config.baseUrl).toBe(validConfig.BETTER_AUTH_URL);
				});
			});
		}
	});
});
