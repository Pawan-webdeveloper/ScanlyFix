-- GitHub App installation health. `active` can be scanned; `suspended` means
-- the account owner (or GitHub) paused the app. `deleted` is deliberately NOT a
-- state — a deleted installation hard-deletes its row (cascading repos/scans).

CREATE TYPE "public"."installation_status" AS ENUM('active', 'suspended');--> statement-breakpoint

ALTER TABLE "github_installations" ADD COLUMN "status" "installation_status" DEFAULT 'active' NOT NULL;
