-- Migration 0025: AI calls record whether they succeeded.
--
-- A failed AI call is invisible today: the SDK wrappers refunded the firewall
-- reservation and rethrew without reporting, so a project whose calls are
-- failing looks identical to one making none. Error rate is one of the few
-- numbers that tells a developer the integration is broken rather than merely
-- expensive.
--
-- NULL status means success, so every existing row stays correct without a
-- backfill. error_kind holds a closed-set label, never the provider's message —
-- provider validation errors echo request content back, which can include
-- fragments of the prompt.
ALTER TABLE "runtime_ai_calls"
  ADD COLUMN IF NOT EXISTS "status" text,
  ADD COLUMN IF NOT EXISTS "error_kind" text;

-- The spend watch and the dashboard both scan one project's recent calls and
-- split them by status; this index serves that access pattern directly.
CREATE INDEX IF NOT EXISTS "runtime_ai_calls_project_status_created_idx"
  ON "runtime_ai_calls" ("project_id", "status", "created_at" DESC);
