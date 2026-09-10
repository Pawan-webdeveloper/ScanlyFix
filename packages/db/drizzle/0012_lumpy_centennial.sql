CREATE TABLE "runtime_route_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"with_session" integer DEFAULT 0 NOT NULL,
	"without_session" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"method" text NOT NULL,
	"kind" text DEFAULT 'route' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_route_stats" ADD CONSTRAINT "runtime_route_stats_route_id_runtime_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."runtime_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_routes" ADD CONSTRAINT "runtime_routes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_route_stats_uq" ON "runtime_route_stats" USING btree ("route_id","hour");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_routes_identity_uq" ON "runtime_routes" USING btree ("project_id","pattern","method");