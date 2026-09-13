-- Migration 0022: Canary Events Acknowledged State
-- Adds acknowledged_at timestamp to runtime_canary_events for review tracking.

ALTER TABLE "runtime_canary_events"
  ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamptz;
