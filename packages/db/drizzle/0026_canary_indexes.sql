-- Migration 0026: indexes for the two queries an anonymous caller can trigger.
--
-- The honeytoken endpoint is unauthenticated by design: anyone who finds the URL
-- shape can call it. Each call ran two unindexed queries.
--
--   findCanaryByHoneytoken   -> Seq Scan on runtime_canaries
--   countRecentHoneytokenHits -> Index Scan on (project_id, detected_at) with only
--                                detected_at constrained, so it walked every
--                                project's events in the window before filtering
--
-- Both grow with the data the flood itself creates, which is the wrong direction
-- for an endpoint with no authentication in front of it.
--
-- honeytoken_path is globally unique: it is 12 random bytes and is the sole
-- lookup key, so a unique index is both the right constraint and the right index.
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_canaries_honeytoken_uq"
  ON "runtime_canaries" ("honeytoken_path");

CREATE INDEX IF NOT EXISTS "runtime_canary_events_canary_idx"
  ON "runtime_canary_events" ("canary_id", "detected_at" DESC);
