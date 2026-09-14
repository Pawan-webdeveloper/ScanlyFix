import { randomBytes } from 'node:crypto';

import { CANARY_LOG_TABLE, CANARY_ROW_COUNT, CANARY_TABLE, SELFTEST_LABEL } from './types';

export type CanarySeed = { marker: string; honeytokenPath: string; payloadJson: string };

export type SetupScript = {
  /** Identifies this planting. Every seed in one script shares it. */
  plantId: string;
  /** The decoy rows an intruder might touch. */
  seeds: CanarySeed[];
  /**
   * The row this system rewrites on every check to prove the trigger still
   * fires. Planted alongside the decoys and never reported as a detection.
   */
  selfTest: CanarySeed;
  sql: string;
};

function shortToken(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

function canonicalPayload(honeyPath: string, appDomain: string): string {
  return JSON.stringify({
    note: 'legacy integration backup',
    api_key: `sk-live-cnf-${shortToken()}`,
    callback_url: `https://${appDomain}/api/runtime/honeytoken/${honeyPath}`,
    rotated_by: 'ops@internal',
  });
}

/**
 * Postgres string literals escape a quote by doubling it, and nothing else. The
 * payload is JSON we generate ourselves, but it is still interpolated into SQL a
 * customer pastes into their own console, so it is escaped rather than trusted.
 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Builds the decoy rows and the SQL that plants them.
 *
 * MARKERS MUST BE UNIQUE PER PLANTING. They used to be derived only from the
 * project id, which made every script for a project produce the same three
 * markers — and that quietly broke the entire compromise-recovery path:
 * `seedCanaries` upserts on (projectId, markerToken) with ON CONFLICT DO
 * NOTHING, so after `retireCanaries` marked the old rows retired, the "fresh"
 * rows collided with them and were dropped. The project was then left with zero
 * live canaries, while the SQL the customer pasted carried brand-new random
 * honeytoken paths that no longer matched any row we had stored — so every hit
 * on those honeytokens was silently discarded, and the verify step reported
 * success because there were no markers left to look for.
 *
 * A random plant id per call makes each planting a distinct generation, which is
 * both what the database needs and what the operator wants to see.
 */
export function buildSetupScript(params: { projectId: string; appDomain: string }): SetupScript {
  const { projectId, appDomain } = params;
  const short = projectId.slice(0, 8);
  const plantId = shortToken(6);
  const labels = ['A', 'B', 'C'];

  const seeds: CanarySeed[] = Array.from({ length: CANARY_ROW_COUNT }, (_, i) => {
    const marker = `CANARY::${short}::${plantId}::${labels[i] ?? String(i)}`;
    const honeyPath = shortToken();
    return { marker, honeytokenPath: honeyPath, payloadJson: canonicalPayload(honeyPath, appDomain) };
  });

  // The self-test row lives in the same table so it exercises the same trigger.
  const selfTestPath = shortToken();
  const selfTest: CanarySeed = {
    marker: `CANARY::${short}::${plantId}::${SELFTEST_LABEL}`,
    honeytokenPath: selfTestPath,
    payloadJson: canonicalPayload(selfTestPath, appDomain),
  };

  const all = [...seeds, selfTest];
  const values = all.map((s) => `  (${sqlLiteral(s.marker)}, ${sqlLiteral(s.payloadJson)}::jsonb)`).join(',\n');
  const markerList = all.map((s) => sqlLiteral(s.marker)).join(', ');

  const sql = `-- ScanlyFix Canaries — setup for project ${short} (planting ${plantId})
--
-- This script creates DECOY rows and watch triggers. Nothing is ever blocked:
-- the triggers only record that a decoy row was touched.
--
-- Your own tables and data are never read, written or altered by this script.
-- After running it, click "Verify setup" in the ScanlyFix dashboard.

create table if not exists public.${CANARY_TABLE} (
  id uuid primary key default gen_random_uuid(),
  marker text unique not null,
  payload jsonb not null,
  planted_at timestamptz not null default now()
);

create table if not exists public.${CANARY_LOG_TABLE} (
  id bigint generated always as identity primary key,
  canary_marker text,
  action text not null,
  old_payload jsonb,
  acted_at timestamptz not null default now()
);

-- Row level security ON with NO policy: only the service role, which bypasses
-- RLS, can reach these tables. Reading them with the anon key must be
-- impossible — if it ever succeeds, that itself is the alert.
alter table public.${CANARY_TABLE} enable row level security;
alter table public.${CANARY_LOG_TABLE} enable row level security;

-- PostgREST permissions. The SELECT grant to anon is deliberate: it lets us
-- test whether RLS is actually filtering, rather than whether the grant is
-- missing. With RLS on and no policy, the anon role sees zero rows.
grant all on table public.${CANARY_TABLE} to service_role;
grant all on table public.${CANARY_LOG_TABLE} to service_role;
grant select on table public.${CANARY_TABLE} to anon, authenticated;

-- SECURITY DEFINER is required. The log table has RLS on with no policy, so a
-- caller who is not the service role could not insert into it — the trigger's
-- insert would fail with an RLS violation and abort the statement, which would
-- both break the write and tell an intruder they had been noticed. Running as
-- the table owner keeps the trigger watch-only and silent.
--
-- OLD is unassigned during an INSERT, so the branch is required: reading
-- old.marker there raises "record old is not assigned yet" and would abort the
-- customer's own statement.
create or replace function public.${CANARY_TABLE}_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.${CANARY_LOG_TABLE} (canary_marker, action, old_payload)
    values (new.marker, tg_op, null);
  else
    insert into public.${CANARY_LOG_TABLE} (canary_marker, action, old_payload)
    values (old.marker, tg_op, to_jsonb(old));
  end if;
  return null; -- AFTER trigger: observe only, never interfere
end $$;

-- ── Planting happens with the trigger disarmed ──────────────────────────────
-- The trigger now watches INSERT as well, so arming it before the rows are
-- planted would record this script's own work as four intrusions. Dropping it
-- first is what keeps the log free of our own noise.
drop trigger if exists ${CANARY_TABLE}_guard_trg on public.${CANARY_TABLE};

-- Replacing a previous generation: its rows would otherwise stay behind and be
-- compared forever, so a later tidy-up by the owner would read as a deletion.
delete from public.${CANARY_TABLE}
where marker like ${sqlLiteral(`CANARY::${short}::%`)}
  and marker not in (${markerList});

-- One of these rows is a self-test: ScanlyFix rewrites it on every check and
-- confirms the trigger recorded the write. That is how "no alert tonight" is
-- distinguished from "the detector was switched off". It is the only row this
-- service ever writes to, and it is never reported as an intrusion.
insert into public.${CANARY_TABLE} (marker, payload) values
${values}
on conflict (marker) do nothing;

-- ── Armed from here on ─────────────────────────────────────────────────────
create trigger ${CANARY_TABLE}_guard_trg
after insert or update or delete on public.${CANARY_TABLE}
for each row execute function public.${CANARY_TABLE}_guard();

-- Ask PostgREST to reload so the new tables appear in the REST API immediately.
notify pgrst, 'reload config';
notify pgrst, 'reload schema';`;

  return { plantId, seeds, selfTest, sql };
}
