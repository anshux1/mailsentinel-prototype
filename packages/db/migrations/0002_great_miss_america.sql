CREATE TYPE "public"."analysis_verdict" AS ENUM('unknown', 'benign', 'suspicious', 'malicious');--> statement-breakpoint
ALTER TYPE "public"."analysis_run_status" ADD VALUE 'processing' BEFORE 'deferred';--> statement-breakpoint
ALTER TYPE "public"."analysis_run_status" ADD VALUE 'completed' BEFORE 'deferred';--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "evidence_id" text;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "verdict" "analysis_verdict";--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "score" integer;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "analysis_version" text;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "ruleset_version" text;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "result_schema_version" text;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "result_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "failure_message" text;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "retryable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_evidence_id_evidence_metadata_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_metadata"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_org_case_id_uidx" ON "evidence_metadata" USING btree ("organization_id","case_id","id");--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_org_case_evidence_fk" FOREIGN KEY ("organization_id","case_id","evidence_id") REFERENCES "public"."evidence_metadata"("organization_id","case_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_runs_status_idx" ON "analysis_runs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_runs_idempotency_key_uidx" ON "analysis_runs" USING btree ("organization_id","idempotency_key");