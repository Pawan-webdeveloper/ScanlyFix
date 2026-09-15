import Link from 'next/link'

export const metadata = {
  title: 'Website Security Scanners Compared (2026)',
  description: 'Compare ScanlyFix with other website security scanners. Find the right tool for security, SEO, and AEO scanning.',
  alternates: {
    canonical: '/compare/scanners',
  },
}

const SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'Review',
  itemReviewed: {
    '@type': 'SoftwareApplication',
    name: 'Website Security Scanners',
  },
  reviewAspect: 'features, pricing, usability',
  author: {
    '@type': 'Organization',
    name: 'ScanlyFix',
  },
}

export default function CompareScannersPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Website Scanners Compared</h1>
      <p className="mt-3 text-muted">
        Compare ScanlyFix with other website security scanners.
      </p>

      <div className="mt-10">
        <h2>ScanlyFix</h2>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-muted">
          <li>100+ checks in 60 seconds</li>
          <li>Free tier with full scans</li>
          <li>SEO and AEO in one scan</li>
          <li>AI fix prompts</li>
        </ul>

        <h2 className="mt-6">Use when</h2>
        <p className="mt-2 text-muted">
          You want a fast, free scan that covers security, SEO, and AI visibility all at once.
        </p>

        <Link href="/scan" className="link">
          Try ScanlyFix
        </Link>
      </div>
    </div>

    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(SCHEMA) }} />
  )
}
