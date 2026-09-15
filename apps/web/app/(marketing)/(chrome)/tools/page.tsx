import Link from 'next/link'

export const metadata = {
  title: 'Free Web Tools',
  description: 'Free website tools: security scanner, SEO audit, AEO scanner, and uptime monitoring.',
  alternates: {
    canonical: '/tools',
  },
}

export default function ToolsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Free Web Tools</h1>
      <p className="mt-3 text-muted">
        Free tools to check your website health. No signup required.
      </p>

      <div className="mt-10 flex flex-col gap-4">
        <Link href="/scanner" className="border rounded p-4">
          <h3 className="font-medium">Security Scanner</h3>
          <p className="mt-1 text-sm text-muted">Check for vulnerabilities and misconfigurations</p>
        </Link>

        <Link href="/seo" className="border rounded p-4">
          <h3 className="font-medium">SEO Scanner</h3>
          <p className="mt-1 text-sm text-muted">Technical SEO audit and Core Web Vitals</p>
        </Link>

        <Link href="/aeo" className="border rounded p-4">
          <h3 className="font-medium">AEO Scanner</h3>
          <p className="mt-1 text-sm text-muted">AI visibility on ChatGPT and Perplexity</p>
        </Link>

        <Link href="/tools/lovable" className="border rounded p-4">
          <h3 className="font-medium">Lovable Security Scanner</h3>
          <p className="mt-1 text-sm text-muted">Check apps built with Lovable</p>
        </Link>

        <Link href="/tools/bolt" className="border rounded p-4">
          <h3 className="font-medium">Bolt Security Scanner</h3>
          <p className="mt-1 text-sm text-muted">Check apps built with Bolt</p>
        </Link>

        <Link href="/tools/v0" className="border rounded p-4">
          <h3 className="font-medium">v0 Security Scanner</h3>
          <p className="mt-1 text-sm text-muted">Check apps built with v0</p>
        </Link>

        <Link href="/tools/cursor" className="border rounded p-4">
          <h3 className="font-medium">Cursor AI Security Scanner</h3>
          <p className="mt-1 text-sm text-muted">Check apps built with Cursor AI</p>
        </Link>

        <Link href="/tools/supabase" className="border rounded p-4">
          <h3 className="font-medium">Supabase Security Scanner</h3>
          <p className="mt-1 text-sm text-muted">Check Supabase backends</p>
        </Link>
      </div>
    </div>
  )
}
