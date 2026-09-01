import { createDb } from "@mailsentinel/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export type AuthConfig = {
	databaseUrl: string;
	secret: string;
	baseUrl: string;
	allowSignUp?: boolean;
};

/** Creates the installed Better Auth version against its reviewed Drizzle schema. */
export function createAuth(config: AuthConfig) {
	const db = createDb(config.databaseUrl);
	return betterAuth({
		appName: "MailSentinel",
		baseURL: config.baseUrl,
		secret: config.secret,
		database: drizzleAdapter(db, { provider: "pg" }),
		emailAndPassword: {
			enabled: true,
			disableSignUp: !config.allowSignUp,
			minPasswordLength: 12,
		},
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
			cookieCache: { enabled: false },
		},
		advanced: {
			cookiePrefix: "mailsentinel",
			useSecureCookies: config.baseUrl.startsWith("https://"),
		},
	});
}

export type MailSentinelAuth = ReturnType<typeof createAuth>;
