CREATE TYPE "public"."evidence_status" AS ENUM('pending', 'stored', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."report_format" AS ENUM('json', 'html', 'pdf', 'markdown', 'text');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('pending', 'generating', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"analysis_run_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "report_status" DEFAULT 'pending' NOT NULL,
	"format" "report_format" DEFAULT 'html' NOT NULL,
	"object_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_reason" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD COLUMN "status" "evidence_status" DEFAULT 'verified' NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD COLUMN "stored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD COLUMN "failure_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_runs_org_case_id_uidx" ON "analysis_runs" USING btree ("organization_id","case_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_runs_org_id_uidx" ON "analysis_runs" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "public"."cases"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_case_run_fk" FOREIGN KEY ("organization_id","case_id","analysis_run_id") REFERENCES "public"."analysis_runs"("organization_id","case_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_org_case_id_uidx" ON "reports" USING btree ("organization_id","case_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_org_id_uidx" ON "reports" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_org_run_version_format_uidx" ON "reports" USING btree ("organization_id","analysis_run_id","version","format");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_object_key_uidx" ON "reports" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "reports_org_case_idx" ON "reports" USING btree ("organization_id","case_id");--> statement-breakpoint
CREATE INDEX "reports_org_run_idx" ON "reports" USING btree ("organization_id","analysis_run_id");--> statement-breakpoint
CREATE INDEX "reports_org_status_idx" ON "reports" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "reports_org_created_idx" ON "reports" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "analysis_runs_verdict_idx" ON "analysis_runs" USING btree ("organization_id","verdict");--> statement-breakpoint
CREATE INDEX "analysis_runs_evidence_idx" ON "analysis_runs" USING btree ("organization_id","evidence_id");--> statement-breakpoint
CREATE INDEX "analysis_runs_org_created_idx" ON "analysis_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_records_resource_idx" ON "audit_records" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_records_created_idx" ON "audit_records" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "cases_org_created_idx" ON "cases" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_org_id_uidx" ON "evidence_metadata" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_org_idempotency_key_uidx" ON "evidence_metadata" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "evidence_org_status_idx" ON "evidence_metadata" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "evidence_org_created_idx" ON "evidence_metadata" USING btree ("organization_id","created_at");