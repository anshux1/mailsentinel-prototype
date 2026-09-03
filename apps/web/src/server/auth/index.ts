import "server-only";

import { createAuth } from "@mailsentinel/auth";
import { env } from "@/env";

export interface AuthEnvConfig {
	DATABASE_URL?: string;
	BETTER_AUTH_SECRET?: string;
	BETTER_AUTH_URL?: string;
}

/**
 * Resolves authentication configuration with strictly guarded test fallbacks.
 *
 * Hard-coded database and auth secret defaults are permitted ONLY when NODE_ENV === 'test'.
 * Outside tests (development, production, etc.), missing, empty, or undefined values
 * must throw an explicit error rather than silently falling back to insecure defaults.
 */
export function resolveAuthConfig(
	envVars: AuthEnvConfig = env,
	...nodeEnvOverride: [string | undefined | null] | []
): {
	databaseUrl: string;
	secret: string;
	baseUrl: string;
} {
	const effectiveEnv =
		nodeEnvOverride.length > 0 ? nodeEnvOverride[0] : process.env.NODE_ENV;

	if (effectiveEnv === "test") {
		return {
			databaseUrl:
				envVars.DATABASE_URL ||
				"postgresql://user:password@localhost:5432/mailsentinel",
			secret:
				envVars.BETTER_AUTH_SECRET ||
				"default_auth_secret_for_development_32_chars",
			baseUrl: envVars.BETTER_AUTH_URL || "http://localhost:3000",
		};
	}

	const databaseUrl = envVars.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error(
			"DATABASE_URL is required outside test environment; fallback defaults are strictly prohibited outside NODE_ENV==='test'",
		);
	}

	const secret = envVars.BETTER_AUTH_SECRET?.trim();
	if (!secret) {
		throw new Error(
			"BETTER_AUTH_SECRET is required outside test environment; fallback defaults are strictly prohibited outside NODE_ENV==='test'",
		);
	}

	const baseUrl = envVars.BETTER_AUTH_URL?.trim();
	if (!baseUrl) {
		throw new Error(
			"BETTER_AUTH_URL is required outside test environment; fallback defaults are strictly prohibited outside NODE_ENV==='test'",
		);
	}

	return {
		databaseUrl,
		secret,
		baseUrl,
	};
}

export const auth = createAuth(resolveAuthConfig());
