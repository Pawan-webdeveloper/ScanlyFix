import Link from 'next/link'

export const metadata = {
  title: 'AEO Scanner',
  description: 'Free AI visibility scanner. Check if ChatGPT, Perplexity, and Claude can find and cite your site.',
}

export default function AeoPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">AEO Scanner</h1>
      <p className="mt-3 text-muted">
        Answer Engine Optimization (AEO) scan. Check if ChatGPT, Perplexity, and Claude can find, understand, and cite your site.
      </p>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        <section>
          <h2 className="font-medium">AEO checks</h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm text-muted">
            <li>AI bot access (llms.txt)</li>
            <li>Structured content</li>
            <li>FAQ and HowTo schema</li>
            <li>Citations and outbound links</li>
            <li>Server-side rendering</li>
          </ul>
        </section>

        <section>
          <h2 className="font-medium">Why it matters</h2>
          <p className="mt-3 text-sm text-muted">
            Buyers ask ChatGPT and Perplexity for recommendations. If your site isn't cited, you're invisible to thousands of searches.
          </p>
        </section>
      </div>

      <div className="mt-10">
        <Link href="/scan" className="link">
          Run a free AEO scan
        </Link>
      </div>
    </div>
  )
}
