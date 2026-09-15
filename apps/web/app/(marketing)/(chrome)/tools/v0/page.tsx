import Link from 'next/link'

export const metadata = {
  title: 'v0 Security Scanner',
  description: 'Check v0 apps for security vulnerabilities, SEO issues, and AI visibility.',
  alternates: {
    canonical: '/tools/v0',
  },
}

export default function V0Page() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">v0 Security Scanner</h1>
      <p className="mt-3 text-muted">
        Vibe-coded apps from v0 need security checks too. Paste your v0 app URL and run 100+ checks.
      </p>
      <div className="mt-10">
        <Link href="/scan" className="link">
          Scan your v0 app
        </Link>
      </div>
    </div>
  )
}
