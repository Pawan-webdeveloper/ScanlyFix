import Link from 'next/link'

export const metadata = {
  title: 'Supabase Security Scanner',
  description: 'Check Supabase backends for RLS issues, exposed secrets, and security misconfigurations.',
  alternates: {
    canonical: '/tools/supabase',
  },
}

export default function SupabasePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Supabase Security Scanner</h1>
      <p className="mt-3 text-muted">
        Check your Supabase project for Row Level Security issues, exposed secrets, and security misconfigurations.
      </p>
      <div className="mt-10">
        <Link href="/scan" className="link">
          Scan your Supabase project
        </Link>
      </div>
    </div>
  )
}
