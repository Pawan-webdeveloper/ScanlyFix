CREATE TABLE "runtime_prober_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"target_id" uuid,
	"path" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"baseline_status" integer NOT NULL,
	"actual_status" integer NOT NULL,
	"severity" text DEFAULT 'high' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_prober_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"source" text DEFAULT 'default' NOT NULL,
	"baseline_status" integer,
	"baseline_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_actual_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_prober_findings" ADD CONSTRAINT "runtime_prober_findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_prober_findings" ADD CONSTRAINT "runtime_prober_findings_target_id_runtime_prober_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."runtime_prober_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_prober_targets" ADD CONSTRAINT "runtime_prober_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_prober_findings_project_idx" ON "runtime_prober_findings" USING btree ("project_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_prober_targets_uq" ON "runtime_prober_targets" USING btree ("project_id","path","method");