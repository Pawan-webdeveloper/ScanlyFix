import { Section, SectionHeading } from './section.tsx'
import { SAMPLE_EVIDENCE } from './sample-report.ts'

/**
 * The section the product's credibility rests on.
 *
 * A scanner is only worth reading if its claims can be checked, and the thing
 * that makes them checkable is showing the value the server actually sent.
 * The example is a DMARC record for a reason — the policy is strict, the
 * record is present, and the defect is a missing tag inside a string only a
 * DNS lookup could have produced. No checklist can generate that sentence;
 * only a measurement can.
 */
export function Evidence() {
  return (
    <Section tone="surface">
      <SectionHeading
        index={2}
        eyebrow="Evidence"
        title="We show you the value. Not our opinion of it."
        lead="Every finding carries the raw observation behind it — the header, the record, the certificate, the response code. Nothing is inferred, and nothing is a generic best-practice bullet dressed up as a result."
      />

      {/* Claim and observation are a pair, so they arrive as one cascade;
          the observed rows read in line by line — reading the raw response
          is the point of this section. */}
      <div data-motion="stagger" className="mt-12 grid gap-px overflow-hidden border border-line bg-line lg:grid-cols-2">
        <div className="min-w-0 bg-canvas p-6 sm:p-8">
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">The claim</p>
          <p className="mt-3 text-xl font-semibold tracking-tight text-balance sm:text-2xl">
            {SAMPLE_EVIDENCE.claim}
          </p>
          <p className="mt-4 max-w-[55ch] text-[15px] leading-relaxed text-ink/70 text-pretty">
            {SAMPLE_EVIDENCE.why}
          </p>
          <p className="mt-6 font-mono text-sm text-muted">{SAMPLE_EVIDENCE.checkId}</p>
        </div>

        <div className="min-w-0 bg-canvas p-6 sm:p-8">
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">Observed</p>
          <dl data-motion="rows" className="mt-3 overflow-x-auto border border-line bg-surface p-4 font-mono text-sm">
            {Object.entries(SAMPLE_EVIDENCE.observed).map(([key, value]) => (
              <div key={key} className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:gap-3">
                <dt className="shrink-0 text-muted sm:w-24">{key}</dt>
                <dd className="min-w-0 break-words text-ink">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 max-w-[50ch] text-[15px] leading-relaxed text-ink/70 text-pretty">
            Read it yourself:{' '}
            <code className="font-mono text-sm break-all text-ink">dig +short TXT _dmarc.example.com</code>{' '}
            returns the same string. Every finding in the report can be re-checked this way.
          </p>
        </div>
      </div>
    </Section>
  )
}
