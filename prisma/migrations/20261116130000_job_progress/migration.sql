-- Additive: per-stage ingestion telemetry.
ALTER TABLE "IngestionJob" ADD COLUMN "progress" JSONB;
