import "server-only";

import { analysisRouter } from "./analysis";
import { caseRouter, caseShell } from "./case";
import { evidenceRouter } from "./evidence";
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

export const router = {
	system: systemRouter,
	case: caseRouter,
	evidence: evidenceRouter,
	analysis: analysisRouter,
	report: reportRouter,
};

export type AppRouter = typeof router;
