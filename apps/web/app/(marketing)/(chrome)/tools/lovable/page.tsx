import Link from 'next/link'

export const metadata = {
  title: 'Lovable Security Scanner',
  description: 'Check Lovable apps for security vulnerabilities, SEO issues, and AI visibility.',
  alternates: {
    canonical: '/tools/lovable',
  },
}

export default function LovablePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Lovable Security Scanner</h1>
      <p className="mt-3 text-muted">
        Vibe-coded apps from Lovable need security checks too. Paste your Lovable app URL and run 100+ checks.
      </p>
      <div className="mt-10">
        <Link href="/scan" className="link">
          Scan your Lovable app
        </Link>
      </div>
    </div>
  )
}
