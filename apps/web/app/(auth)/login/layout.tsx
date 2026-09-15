import type { Metadata } from 'next'

/**
 * Metadata for the sign-in page, which cannot declare its own.
 *
 * page.tsx is a client component — it needs useSearchParams for the ?next and
 * ?error params, and useAuthActions for the providers — and Next only reads a
 * `metadata` export from a server component. A layout is the server half that
 * wraps it, so the title lives here.
 */
export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to ScanlyFix with Google, GitHub, or a code sent to your email.',
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children
}
