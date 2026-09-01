import "server-only";

import { headers } from "next/headers";
import { auth } from "./index";

export async function getServerSession() {
	return auth.api.getSession({ headers: await headers() });
}

export async function requireServerSession() {
	const session = await getServerSession();
	if (!session) throw new Error("Authentication required");
	return session;
}
