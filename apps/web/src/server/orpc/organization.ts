import "server-only";

import { memberships, organizations } from "@mailsentinel/db";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { MembershipRole } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { authedProcedure } from "./middleware";

/**
 * Memberships for the *calling user only*. The browser needs this to choose the
 * `x-organization-id` it sends on every tenant request — the server never picks
 * an active organization implicitly.
 */
export const membershipOutputSchema = z.object({
	organizationId: z.string(),
	name: z.string(),
	role: z.enum(["owner", "investigator", "viewer"]),
});

export const listMembershipsOutputSchema = z.object({
	items: z.array(membershipOutputSchema),
});

export type MembershipOutput = z.infer<typeof membershipOutputSchema>;

export const organizationRouter = {
	list: authedProcedure
		.output(listMembershipsOutputSchema)
		.handler(async ({ context }) => {
			const rows = await db
				.select({
					organizationId: memberships.organizationId,
					name: organizations.name,
					role: memberships.role,
				})
				.from(memberships)
				.innerJoin(
					organizations,
					eq(organizations.id, memberships.organizationId),
				)
				.where(eq(memberships.userId, context.userId))
				.orderBy(asc(organizations.name));

			return {
				items: rows.map((row) => ({
					organizationId: row.organizationId,
					name: row.name,
					role: row.role as MembershipRole,
				})),
			};
		}),
};
