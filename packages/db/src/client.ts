/**
 * The database connection, on its own so query modules can import it without
 * going through the package barrel — `index.ts` re-exports the queries, and a
 * query importing the barrel back would be a cycle.
 *
 * ## Pool sizing
 *
 * The default `pg` Pool opens up to 10 sockets per worker process and keeps
 * them forever. When this client runs against Supabase's **session-mode**
 * pooler (port 5432) every Node worker pins a backend Postgres connection
 * for the lifetime of each socket, and Supabase caps that mode at 15
 * concurrent clients per database — so the very first dashboard reload that
 * fans out three concurrent API calls from each of three tabs trips
 * `EMAXCONNSESSION: max clients reached in session mode`.
 *
 * Three things here work together to keep us under that ceiling:
 *
 *   1. `max: 10` — caps the sockets this process will keep open. Without it,
 *      `pg` defaults to 10 too, but the default can be raised by a Node
 *      fork and the ceiling disappears silently. Pinning it makes the
 *      behaviour visible at the call site.
 *
 *   2. `idleTimeoutMillis: 30_000` — releases sockets that have not been
 *      used for 30s back to the server. The default is 10s; bumping it to
 *      30s matches typical Next.js request cadence without holding
 *      connections open across quiet periods.
 *
 *   3. `connectionTimeoutMillis: 10_000` — fails fast (with a typed error)
 *      instead of hanging the route handler for the default 30s when the
 *      pool is saturated. The route handler already has a try/catch that
 *      converts any throw into a 500, so this is the place to make the
 *      failure obvious rather than letting requests pile up.
 *
 * When this codebase is run against the **transaction-mode** pooler
 * (port 6543) the ceiling becomes irrelevant — that mode multiplexes many
 * client connections onto a small set of backends — so the numbers above
 * are tuned for the worst case (session mode) and stay safe in the best.
 *
 * ## Dead sockets
 *
 * Supabase's pooler (and any NAT/firewall in between) silently drops idle
 * TCP connections. When pg later reads from such a socket it gets
 * `ETIMEDOUT`, which it re-emits on the pool. Without a listener that
 * becomes an `uncaughtException` and Next.js dumps a whole pg client
 * object to the console; with the handler below it is one log line and the
 * pool simply discards the dead client. `keepAlive: true` makes the OS
 * detect half-open connections sooner instead of waiting for the read
 * timeout.
 *
 * ## TLS
 *
 * The DATABASE_URL carries `sslmode=no-verify`. Do NOT "upgrade" it to
 * `sslmode=require`: pg 8.x maps require/verify-ca/verify-full to strict CA
 * verification, and Supabase signs the pooler certificate with its own CA,
 * so `require` fails the handshake with "self-signed certificate in
 * certificate chain". `no-verify` still negotiates TLS 1.3 (the socket is
 * a TLSSocket) — it only skips pinning Supabase's CA. Pinning the CA
 * (prod-ca-2021.crt) is the stronger option if that ever matters.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.ts'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
})

// Idle pooled sockets that the Supabase pooler (or a NAT in between) has
// silently dropped read back `ETIMEDOUT`; pg re-emits that on the pool. With
// no listener the error escapes as an `uncaughtException` and Next.js prints
// a wall of client internals. Log one line instead — the pool discards the
// dead client and the next query opens a fresh connection.
pool.on('error', (err: NodeJS.ErrnoException) => {
  console.error(`[db] dropped an idle connection (${err.code ?? err.message})`)
})

export const db = drizzle(pool, { schema })

export type Database = typeof db