import { account, createDb, memberships, organizations, user } from "@mailsentinel/db";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { createAuth } from "./index";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel";
const secret = process.env.BETTER_AUTH_SECRET ?? "local-development-auth-secret-change-me";
const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const db = createDb(databaseUrl);
const auth = createAuth({ databaseUrl, secret, baseUrl, allowSignUp: true, database: db });

const email = process.env.DEMO_USER_EMAIL ?? "demo@mailsentinel.local";
const password = process.env.DEMO_USER_PASSWORD ?? "MailSentinel-Demo-2026!";

try {
	const existingUser = await db.query.user.findFirst({ where: eq(user.email, email) });
	let userId = existingUser?.id;

	if (!userId) {
		try {
			const result = await auth.api.signUpEmail({ body: { email, password, name: "Demo Investigator" } });
			userId = result.user.id;
		} catch (error) {
			// A concurrent seed may have created the user between the lookup and signup.
			const concurrentlyCreated = await db.query.user.findFirst({ where: eq(user.email, email) });
			if (!concurrentlyCreated) throw error;
			userId = concurrentlyCreated.id;
		}
	}

	if (!userId) throw new Error("Unable to determine the demo user id");

	const credential = await db.query.account.findFirst({
		where: and(eq(account.userId, userId), eq(account.providerId, "credential")),
	});
	if (!credential) {
		await db
			.insert(account)
			.values({
				id: `account_${userId}_credential`,
				accountId: userId,
				providerId: "credential",
				issuer: "local:credential",
				userId,
				password: await hashPassword(password),
			})
			.onConflictDoNothing();
	}

	await db.insert(organizations).values({ id: "org_demo", name: "MailSentinel Demo" }).onConflictDoNothing();
	await db
		.insert(memberships)
		.values({ id: `membership_${userId}`, organizationId: "org_demo", userId, role: "owner" })
		.onConflictDoNothing();
	console.log(`Seeded demo user ${email} and organization org_demo`);
} finally {
	await db.$client.end();
}
