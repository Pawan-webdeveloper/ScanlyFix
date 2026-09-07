import Link from 'next/link'
import { LogoBadge } from '@/components/brand/logo.tsx'
import { LabeledRule } from '@/components/ui/labeled-rule.tsx'
import { LoginFormClient } from './login-form-client.tsx'

/**
 * The login page, as a server component.
 *
 * The form is a client-only island (see `./login-form-client.tsx`); the
 * server-rendered shell here provides the static chrome — the wordmark,
 * the labelled rule, the `max-w-sm` column — and reserves the slot the
 * island fills on the client. The island cannot be the default export of
 * this file because the page is statically prerendered, and a default
 * client component that mounts a context provider renders the form on
 * the server too, where the Supabase context is not in scope.
 *
 * Reading searchParams opts the page out of static prerender — accepted,
 * because the one thing worse than a bounce from the GitHub callback to
 * here is the same bounce with no word about why.
 */

const LOGIN_ERRORS: Record<string, string> = {
  'github-connect-requires-signin':
    'Your session ended during the GitHub setup, so the install was not saved. Sign in, then connect GitHub again.',
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const errorMessage = error ? LOGIN_ERRORS[error] ?? null : null

  return (
    <div className="mx-auto max-w-sm px-6 py-24">
      <Link href="/" className="flex items-center gap-2" aria-label="ScanlyFix — home">
        <LogoBadge size={22} />
        <span className="text-[15px] font-semibold tracking-tight">scanlyfix</span>
      </Link>
      <div className="mt-8">
        <LabeledRule label="Account" trailing="no password" />
      </div>
      {errorMessage && (
        <div
          role="alert"
          className="mt-5 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-900"
        >
          {errorMessage}
        </div>
      )}
      <div className="mt-5">
        <LoginFormClient />
      </div>
    </div>
  )
}
