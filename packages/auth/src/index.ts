/** Auth integration boundary. The Better Auth instance is created by the Node runtime,
 * where validated secrets and the database connection are available. */
export type SessionContext = { userId: string; organizationId: string };
export const authPackage = "@mailsentinel/auth" as const;
