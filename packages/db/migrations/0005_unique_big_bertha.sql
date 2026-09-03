CREATE TYPE "public"."ingestion_batch_source" AS ENUM('upload_single', 'upload_container', 'mailbox_sync');--> statement-breakpoint
CREATE TYPE "public"."ingestion_batch_status" AS ENUM('pending', 'segmenting', 'ready', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mailbox_connection_status" AS ENUM('connected', 'syncing', 'error', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."mailbox_provider" AS ENUM('gmail');--> statement-breakpoint
CREATE TABLE "ingestion_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"source" "ingestion_batch_source" NOT NULL,
	"status" "ingestion_batch_status" DEFAULT 'pending' NOT NULL,
	"container_evidence_id" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"ready_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" "mailbox_provider" DEFAULT 'gmail' NOT NULL,
	"account_email" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"token_nonce" text NOT NULL,
	"scopes" text,
	"sync_cursor" text,
	"status" "mailbox_connection_status" DEFAULT 'connected' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_failure_reason" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_container_evidence_id_evidence_metadata_id_fk" FOREIGN KEY ("container_evidence_id") REFERENCES "public"."evidence_metadata"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_org_case_fk" FOREIGN KEY ("organization_id","case_id") REFERENCES "public"."cases"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_batches_org_case_id_uidx" ON "ingestion_batches" USING btree ("organization_id","case_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_batches_org_id_uidx" ON "ingestion_batches" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "ingestion_batches_org_case_created_idx" ON "ingestion_batches" USING btree ("organization_id","case_id","created_at");--> statement-breakpoint
CREATE INDEX "ingestion_batches_org_case_idx" ON "ingestion_batches" USING btree ("organization_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_connections_org_provider_email_uidx" ON "mailbox_connections" USING btree ("organization_id","provider","account_email");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_connections_org_id_uidx" ON "mailbox_connections" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "mailbox_connections_org_idx" ON "mailbox_connections" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD CONSTRAINT "evidence_metadata_batch_id_ingestion_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ingestion_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD CONSTRAINT "evidence_metadata_org_case_batch_fk" FOREIGN KEY ("organization_id","case_id","batch_id") REFERENCES "public"."ingestion_batches"("organization_id","case_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_org_batch_seq_idx" ON "evidence_metadata" USING btree ("organization_id","batch_id","sequence");