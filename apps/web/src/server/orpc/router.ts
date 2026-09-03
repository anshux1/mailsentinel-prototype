import "server-only";

import { analysisRouter } from "./analysis";
import { batchRouter } from "./batch";
import { caseRouter, caseShell } from "./case";
import { evidenceRouter } from "./evidence";
import { mailboxRouter } from "./mailbox";
import { organizationRouter } from "./organization";
import { reportRouter } from "./report";
import { systemRouter } from "./system";

export {
	authedProcedure,
	investigatorProcedure,
	ownerProcedure,
	protectedProcedure,
	publicProcedure,
	requirePermission,
	requireRole,
	tenantProcedure,
	viewerProcedure,
} from "./middleware";

export { caseShell };
export { batchRouter };
export { mailboxRouter };

export const router = {
	system: systemRouter,
	organization: organizationRouter,
	case: caseRouter,
	evidence: evidenceRouter,
	analysis: analysisRouter,
	report: reportRouter,
	batch: batchRouter,
	mailbox: mailboxRouter,
};

export type AppRouter = typeof router;
