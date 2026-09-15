import Link from 'next/link'

export const metadata = {
  title: 'AEO (Answer Engine Optimization) Guide 2026',
  description: 'Learn what AEO is and how to optimize your site for ChatGPT, Perplexity, and other AI answer engines.',
}

export default function AeoGuidePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">AEO Guide 2026</h1>
      <p className="mt-2 text-muted">
        Answer Engine Optimization (AEO) helps your site get cited by AI assistants like ChatGPT and Perplexity.
      </p>

      <article className="mt-10 space-y-6">
        <p>
          Answer Engine Optimization (AEO) is the practice of optimizing your content for AI answer engines like ChatGPT, Perplexity, and Google SGE.
        </p>

        <h2>Why AEO Matters</h2>
        <p>
          Buyers ask ChatGPT and Perplexity for recommendations. If your site isn't cited, you're invisible to thousands of searches.
        </p>

        <h2>How to Optimize for AEO</h2>
        <ul className="list-disc ml-6 space-y-2">
          <li>Create structured content with clear headings</li>
          <li>Add FAQ and HowTo schema</li>
          <li>Include citations and outbound links</li>
          <li>Use server-side rendering</li>
          <li>Add a llms.txt file for AI crawlers</li>
        </ul>

        <Link href="/scan" className="link">
          Run a free AEO scan
        </Link>
      </article>
    </div>
  )
}
