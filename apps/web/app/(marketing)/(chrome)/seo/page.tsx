import Link from 'next/link'

export const metadata = {
  title: 'Free SEO Scanner & Audit Tool',
  description: 'Free SEO audit tool. Check meta tags, structured data, sitemaps, Core Web Vitals, and technical SEO issues in one scan. No signup required.',
  alternates: {
    canonical: '/seo',
  },
}

export default function SeoPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">SEO Scanner</h1>
      <p className="mt-3 text-muted">
        Technical SEO audit that checks meta tags, structured data, sitemaps, and Core Web Vitals in one scan.
      </p>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        <section>
          <h2 className="font-medium">SEO checks</h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm text-muted">
            <li>Meta title and description</li>
            <li>Structured data (Schema.org)</li>
            <li>Sitemap and robots.txt</li>
            <li>Open Graph and Twitter cards</li>
            <li>Canonical tags and hreflang</li>
          </ul>
        </section>

        <section>
          <h2 className="font-medium">Performance</h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm text-muted">
            <li>Core Web Vitals</li>
            <li>Image optimization</li>
            <li>Compression (gzip/brotli)</li>
            <li>Caching headers</li>
            <li>Render-blocking resources</li>
          </ul>
        </section>
      </div>

      <div className="mt-10">
        <Link href="/scan" className="link">
          Run a free SEO audit
        </Link>
      </div>
    </div>
  )
}
