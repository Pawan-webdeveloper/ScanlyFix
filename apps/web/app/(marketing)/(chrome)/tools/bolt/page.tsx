import Link from 'next/link'

export const metadata = {
  title: 'Bolt Security Scanner',
  description: 'Check Bolt apps for security vulnerabilities, SEO issues, and AI visibility.',
  alternates: {
    canonical: '/tools/bolt',
  },
}

export default function BoltPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Bolt Security Scanner</h1>
      <p className="mt-3 text-muted">
        Vibe-coded apps from Bolt need security checks too. Paste your Bolt app URL and run 100+ checks.
      </p>
      <div className="mt-10">
        <Link href="/scan" className="link">
          Scan your Bolt app
        </Link>
      </div>
    </div>
  )
}
