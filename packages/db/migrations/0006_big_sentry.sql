ALTER TABLE "ingestion_batches" DROP CONSTRAINT "ingestion_batches_container_evidence_id_evidence_metadata_id_fk";
--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_org_case_container_fk"
FOREIGN KEY ("organization_id", "case_id", "container_evidence_id")
REFERENCES "evidence_metadata" ("organization_id", "case_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
DROP INDEX "evidence_org_batch_seq_idx";--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD COLUMN "summary" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_org_batch_seq_uidx" ON "evidence_metadata" USING btree ("organization_id","batch_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_batches_org_container_uidx" ON "ingestion_batches" USING btree ("organization_id","container_evidence_id");--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD CONSTRAINT "evidence_sequence_check" CHECK ("evidence_metadata"."sequence" IS NULL OR "evidence_metadata"."sequence" >= 0);--> statement-breakpoint
ALTER TABLE "evidence_metadata" ADD CONSTRAINT "evidence_byte_size_check" CHECK ("evidence_metadata"."byte_size" > 0);--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_message_count_check" CHECK ("ingestion_batches"."message_count" >= 0);--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_ready_count_check" CHECK ("ingestion_batches"."ready_count" >= 0);--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_failed_count_check" CHECK ("ingestion_batches"."failed_count" >= 0);--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_count_total_check" CHECK ("ingestion_batches"."ready_count" + "ingestion_batches"."failed_count" <= "ingestion_batches"."message_count");