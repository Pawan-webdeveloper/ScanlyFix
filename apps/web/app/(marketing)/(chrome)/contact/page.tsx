import type { Metadata } from 'next'
import { LabeledRule } from '@/components/ui/labeled-rule.tsx'
import { legal } from '@/lib/legal.ts'

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'How to reach ScanlyFix for support, billing questions, or anything else.',
}

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <LabeledRule label="Contact" />

      <h1 className="mt-6 text-2xl font-semibold tracking-[-0.02em] text-balance sm:text-3xl">
        Get in touch
      </h1>

      <p className="mt-5 text-[15px] leading-relaxed text-muted text-pretty">
        For questions about the product, your account, billing, or anything
        else on this site, write to us at the address below.
      </p>

      <div className="mt-12 flex flex-col gap-10">
        <section>
          <h3 className="label text-ink">[ 01 ] Email</h3>
          <div className="mt-4 text-[15px] leading-relaxed text-pretty">
            <a
              className="link"
              href={`mailto:${legal.contactEmail}`}
            >
              {legal.contactEmail}
            </a>
            <p className="mt-2 text-muted">
              This is the fastest way to reach us. We aim to respond within
              one business day.
            </p>
          </div>
        </section>

        <section>
          <h3 className="label text-ink">[ 02 ] What to include</h3>
          <div className="mt-4 text-[15px] leading-relaxed text-pretty">
            <ul className="list-inside list-disc text-muted">
              <li>Your account email (if you have one)</li>
              <li>A clear description of the issue or question</li>
              <li>For billing: the date and amount of the charge in question</li>
              <li>For bugs: the URL you were scanning and what you expected</li>
            </ul>
          </div>
        </section>

        <section>
          <h3 className="label text-ink">[ 03 ] Response times</h3>
          <div className="mt-4 text-[15px] leading-relaxed text-pretty text-muted">
            <p>
              General queries: within one business day. Billing disputes:
              within 24 hours. Urgent security or availability issues:
              same-day.
            </p>
            <p className="mt-2">
              For privacy-related requests (data access, deletion), email{' '}
              <a
                className="link"
                href={`mailto:${legal.contactEmail}`}
              >
                {legal.contactEmail}
              </a>{' '}
              from the address on your account and we will respond within 30
              days.
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
