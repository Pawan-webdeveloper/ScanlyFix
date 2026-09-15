import Link from 'next/link'

export const metadata = {
  title: 'Cursor AI Security Scanner | Check Apps Built with Cursor',
  description: 'Check apps built with Cursor AI for security vulnerabilities, SEO issues, and AI visibility. Free scanner for AI-generated code.',
  alternates: {
    canonical: '/tools/cursor',
  },
}

export default function CursorPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Cursor AI Security Scanner</h1>
      <p className="mt-3 text-muted">
        Apps built with Cursor AI need security checks too. Paste your Cursor-built app URL and run 100+ checks.
      </p>
      <div className="mt-10">
        <Link href="/scan" className="link">
          Scan your Cursor app
        </Link>
      </div>
    </div>
  )
}
