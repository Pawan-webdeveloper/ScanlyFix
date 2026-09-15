-- Migration 0024: Guard records what the middleware DID with logged-out requests.
--
-- Guard observes at the edge, before the application's auth check, so a
-- logged-out request arriving at a protected route is normal. What is evidence
-- is the response the wrapped middleware produced: a 401/403 or a redirect to a
-- sign-in page proves the route is enforced, a pass-through does not.
--
-- Both counters are subsets of without_session and default to 0, so existing
-- rows stay correct and simply carry no outcome breakdown.
ALTER TABLE "runtime_route_stats"
  ADD COLUMN IF NOT EXISTS "without_session_blocked" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "without_session_passed" integer NOT NULL DEFAULT 0;
