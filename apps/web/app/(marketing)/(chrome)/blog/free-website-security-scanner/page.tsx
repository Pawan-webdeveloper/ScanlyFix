import Link from 'next/link'

export const metadata = {
  title: 'Free Website Security Scanner: Check Your Site in 60 Seconds',
  description: 'Learn how to use a free website security scanner to check your site for vulnerabilities, SEO issues, and AI visibility.',
  alternates: {
    canonical: '/blog/free-website-security-scanner',
  },
}

const SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  headline: 'Free Website Security Scanner',
  description: 'Learn how to check your site for vulnerabilities in 60 seconds using a free website security scanner.',
  author: {
    '@type': 'Organization',
    name: 'ScanlyFix',
  },
  datePublished: '2026-09-15',
}

export default function BlogPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Free Website Security Scanner</h1>
      <p className="mt-2 text-muted">
        Learn how to check your site for vulnerabilities in 60 seconds.
      </p>

      <article className="mt-10 space-y-6">
        <p>
          Website security scanners check your site for vulnerabilities, misconfigurations, and SEO issues. ScanlyFix is a free tool that runs 100+ checks in 60 seconds.
        </p>

        <h2>What Does a Security Scanner Check?</h2>
        <p>
          Security scanners check for exposed secrets, insecure headers, CORS misconfigurations, and more. They also check SEO and AI visibility.
        </p>

        <h2>How to Use a Website Security Scanner</h2>
        <ol className="list-decimal ml-6 space-y-2">
          <li>Go to scanlyfix.com</li>
          <li>Paste your URL</li>
          <li>Run the scan</li>
          <li>Get ranked findings with fix prompts</li>
        </ol>

        <h2>Pricing</h2>
        <p>
          Free tier includes full scans with limited findings. Pro is $9/month for unlimited scans and monitoring.
        </p>

        <Link href="/scan" className="link">
          Run a free scan
        </Link>
      </article>

      <p className="mt-8 text-muted">
        Also check out our{' '}
        <Link href="/aeo" className="link">
          AEO guide
        </Link>
        .
      </p>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(SCHEMA) }} />
    </div>
  )
}
