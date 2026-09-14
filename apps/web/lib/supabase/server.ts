/**
 * The server-side Supabase client.
 *
 * One factory, one rule: it reads and writes cookies through Next's `cookies()`
 * helper using the `getAll`/`setAll` adapter that @supabase/ssr requires. The
 * older `get`/`set`/`remove` shape was deprecated because it cannot model
 * Set-Cookie writes from a Server Action — the Set-Cookie happens on the
 * response, not the request, and the per-cookie methods read from a request
 * store that does not exist there.
 *
 * `setAll` in a Server Component will throw, by design: writes from a render
 * are not propagated, and the right place for them is either this proxy or a
 * Server Action. The catch swallows the error in that case so a render that
 * incidentally creates the client does not crash — the proxy refreshes the
 * session on the next request, which is what the cookie write was going to do
 * anyway.
 *
 * Importable only from server code: this module carries `server-only` and any
 * client component that reaches for it fails the build.
 */

import 'server-only'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { serverEnv } from '@/lib/env.ts'
import { publicEnv } from '@/lib/public-env.ts'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(publicEnv.supabaseUrl(), publicEnv.supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, {
              ...options,
              sameSite: 'lax',
              secure: serverEnv.isProduction,
            })
          }
        } catch {
          // Called from a Server Component. The proxy refreshes the session on
          // the next request, so the write that was going to happen is the
          // write that will happen — just one tick later.
        }
      },
    },
  })
}
