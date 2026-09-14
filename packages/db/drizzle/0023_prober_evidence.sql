-- Migration 0023: Auth prober evidence, categories and per-target verdicts.
-- Findings gain a category, a plain-language reason and response evidence;
-- targets remember the last verdict so the UI can explain inconclusive probes.
ALTER TABLE "runtime_prober_findings" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "runtime_prober_findings" ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE "runtime_prober_findings" ADD COLUMN IF NOT EXISTS "evidence" jsonb;

ALTER TABLE "runtime_prober_targets" ADD COLUMN IF NOT EXISTS "last_verdict" text;
ALTER TABLE "runtime_prober_targets" ADD COLUMN IF NOT EXISTS "last_reason" text;
