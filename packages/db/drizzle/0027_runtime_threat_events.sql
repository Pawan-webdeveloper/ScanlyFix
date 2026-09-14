-- Live threat detection: attack attempts observed by the runtime SDK.
--
-- One row per (request, attack class). Carries no request body, no cookie and
-- no concrete URL — `pattern` is the normalised route shape and `evidence` is a
-- truncated, redacted window around the payload.

CREATE TABLE IF NOT EXISTS "runtime_threat_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "severity" text NOT NULL,
  "confidence" text NOT NULL,
  "rule_id" text DEFAULT '' NOT NULL,
  "surface" text NOT NULL,
  "method" text NOT NULL,
  "pattern" text NOT NULL,
  "evidence" text DEFAULT '' NOT NULL,
  "source_ip" text,
  "user_agent" text,
  "blocked" boolean DEFAULT false NOT NULL,
  "response_status" integer,
  "source" text DEFAULT 'sdk' NOT NULL,
  "event_count" integer DEFAULT 1 NOT NULL,
  "detected_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- The feed, newest first, for one project.
CREATE INDEX IF NOT EXISTS "runtime_threat_events_project_idx"
  ON "runtime_threat_events" ("project_id", "detected_at");

-- The brute-force rollup groups by source inside a time window. Without this it
-- is a sequential scan on a table an anonymous attacker chooses the size of.
CREATE INDEX IF NOT EXISTS "runtime_threat_events_source_idx"
  ON "runtime_threat_events" ("project_id", "source_ip", "detected_at");

-- Filtering the feed by attack class.
CREATE INDEX IF NOT EXISTS "runtime_threat_events_kind_idx"
  ON "runtime_threat_events" ("project_id", "kind", "detected_at");
