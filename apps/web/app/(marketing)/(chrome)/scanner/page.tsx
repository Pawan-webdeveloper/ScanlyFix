import Link from 'next/link'

export const metadata = {
  title: 'Website Security Scanner | Free & Fast',
  description: 'Free website security scanner. Check for vulnerabilities, exposed secrets, insecure headers, and misconfigurations in 60 seconds. No signup required.',
  alternates: {
    canonical: '/scanner',
  },
}

const SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'Website Security Scanner',
  description: 'Free website security scanner that checks for vulnerabilities, exposed secrets, and misconfigurations.',
  applicationCategory: 'SecurityApplication',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
}

export default function ScannerPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Website Security Scanner</h1>
      <p className="mt-3 text-muted">
        Paste any URL and run 100+ read-only security checks. Find exposed secrets, insecure headers, and misconfigurations.
      </p>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        <section>
          <h2 className="font-medium">What we check</h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm text-muted">
            <li>Security headers (CSP, HSTS, X-Frame-Options)</li>
            <li>Exposed secrets and API keys</li>
            <li>CORS and CSRF protection</li>
            <li>SSL/TLS certificate status</li>
            <li>Directory listing and sensitive paths</li>
          </ul>
        </section>

        <section>
          <h2 className="font-medium">How it works</h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm text-muted">
            <li>1. Paste your URL</li>
            <li>2. Run the scan</li>
            <li>3. Get ranked findings</li>
            <li>4. Copy AI fix prompts</li>
          </ul>
        </section>
      </div>

      <div className="mt-10">
        <Link href="/scan" className="link">
          Run a free scan
        </Link>
      </div>

      <p className="mt-8 text-muted">
        Also check{' '}
        <Link href="/seo" className="link">
          SEO
        </Link>{' '}
        and{' '}
        <Link href="/aeo" className="link">
          AEO (AI visibility)
        </Link>
      </p>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(SCHEMA) }} />
    </div>
  )
}
