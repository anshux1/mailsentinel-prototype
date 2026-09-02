CREATE UNIQUE INDEX "cases_organization_id_uidx" ON "cases" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_org_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "public"."cases"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD CONSTRAINT "evidence_metadata_org_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "public"."cases"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
