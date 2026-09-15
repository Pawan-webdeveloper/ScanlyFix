import type { Metadata } from 'next'
import { LabeledRule } from '@/components/ui/labeled-rule.tsx'
import { legal, operator } from '@/lib/legal.ts'

export const metadata: Metadata = {
  title: 'About',
  description:
    'What ScanlyFix is, why it exists, and who is behind it.',
}

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <LabeledRule label="About" />

      <h1 className="mt-6 text-2xl font-semibold tracking-[-0.02em] text-balance sm:text-3xl">
        A scanner that reads only what a browser would
      </h1>

      <p className="mt-5 text-[15px] leading-relaxed text-muted text-pretty">
        {legal.service} is a website scanner built for people who care about
        their site&rsquo;s security, SEO, performance, accessibility, and
        AI-readiness — but do not have time to check each one by hand.
      </p>

      <div className="mt-12 flex flex-col gap-10">
        <section>
          <h3 className="label text-ink">[ 01 ] What it does</h3>
          <div className="mt-4 flex flex-col gap-4 text-[15px] leading-relaxed text-pretty">
            <p>
              You give it a URL. It fetches the page the way a browser would,
              runs over 100 read-only checks, and returns a report with severity
              ratings, evidence, and a copy-paste fix prompt for every finding.
            </p>
            <p>
              It never signs in, never submits a form, and never attempts to
              exploit what it finds. Everything it reports is what a visitor
              could already see.
            </p>
          </div>
        </section>

        <section>
          <h3 className="label text-ink">[ 02 ] Why it exists</h3>
          <div className="mt-4 flex flex-col gap-4 text-[15px] leading-relaxed text-pretty">
            <p>
              Most site owners know they should care about security headers,
              meta tags, and performance — but the list of things to check is
              long, the advice is scattered, and the tools that produce 50-page
              PDFs rarely say what to do next.
            </p>
            <p>
              {legal.service} is the opposite: a single page that tells you
              what is wrong, shows the evidence, and hands you the prompt to fix
              it. No jargon, no upsell, no seven-step onboarding flow.
            </p>
          </div>
        </section>

        <section>
          <h3 className="label text-ink">[ 03 ] Who runs it</h3>
          <div className="mt-4 flex flex-col gap-4 text-[15px] leading-relaxed text-pretty">
            <p>
              {legal.service} is operated by {operator()}. If you have a
              question about the product, the policy, or anything else on this
              site, write to{' '}
              <a
                className="link"
                href={`mailto:${legal.contactEmail}`}
              >
                {legal.contactEmail}
              </a>
              .
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
