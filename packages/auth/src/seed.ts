import { account, createDb, memberships, organizations } from "@mailsentinel/db";
import { hashPassword } from "better-auth/crypto";
import { createAuth } from "./index";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel";
const secret = process.env.BETTER_AUTH_SECRET ?? "local-development-auth-secret-change-me";
const db = createDb(databaseUrl);
const auth = createAuth({ databaseUrl, secret, baseUrl: "http://localhost:3000", allowSignUp: true });

const email = process.env.DEMO_USER_EMAIL ?? "demo@mailsentinel.local";
const password = process.env.DEMO_USER_PASSWORD ?? "MailSentinel-Demo-2026!";
let userId = "user_demo";
try {
	const result = await auth.api.signUpEmail({ body: { email, password, name: "Demo Investigator" } });
	userId = result.user.id;
} catch (error) {
	if (!(error instanceof Error) || !error.message.toLowerCase().includes("exist")) throw error;
	const existing = await db.query.user.findFirst({ where: (table, { eq }) => eq(table.email, email) });
	if (!existing) throw error;
	userId = existing.id;
}

const passwordHash = await hashPassword(password);
await db
	.insert(account)
	.values({
		id: "account_demo_credential",
		accountId: userId,
		providerId: "credential",
		userId,
		password: passwordHash,
	})
	.onConflictDoNothing();
await db.insert(organizations).values({ id: "org_demo", name: "MailSentinel Demo" }).onConflictDoNothing();
await db
	.insert(memberships)
	.values({ id: "membership_demo", organizationId: "org_demo", userId, role: "owner" })
	.onConflictDoNothing();
console.log(`Seeded demo user ${email} and organization org_demo`);
await db.$client.end();
process.exit(0);
