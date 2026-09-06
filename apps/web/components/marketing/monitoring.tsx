import { Section, SectionHeading } from './section.tsx'
import { UptimeChart } from '@/components/monitors/uptime-chart.tsx'

/**
 * Monitoring, shown with the real status-page component.
 *
 * The events below are made up and the caption says so. That is the line this
 * page holds everywhere: the scan report in the hero is real because it is
 * making a claim about what the engine finds, while this is illustrating a
 * layout, and pretending it were somebody's real uptime would be inventing a
 * customer.
 */

/**
 * Ninety days ending on a fixed date. Anchored to a constant rather than
 * today, so a rebuild does not silently change the picture — and because
 * nothing on a statically rendered page should depend on when it was built.
 */
const ANCHOR = Date.parse('2026-08-26T12:00:00Z')
const DAY = 86_400_000
const BAD_DAYS = new Set([37, 38])

const SAMPLE_EVENTS = Array.from({ length: 90 }, (_, index) => ({
  ts: new Date(ANCHOR - (89 - index) * DAY).toISOString(),
  ok: !BAD_DAYS.has(index),
}))

const CAPABILITIES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Uptime, from outside your network',
    body: 'A probe on a schedule, from somewhere that is not your own infrastructure — which is the only place an outage looks like an outage.',
  },
  {
    title: 'Certificates, before they expire',
    body: 'The expiry date is read on every probe and warned about with weeks to spare, not on the morning the renewal cron did not run.',
  },
  {
    title: 'A re-scan every day',
    body: 'Yesterday’s report is a snapshot; a deploy is what changes it. Score movement is reported against the same engine version, so the ruler never moves under the measurement.',
  },
  {
    title: 'A public status page',
    body: 'The strip above is a real component from a real status page, linkable during an incident.',
  },
]

export function Monitoring() {
  return (
    <Section>
      <SectionHeading
        index={5}
        eyebrow="Monitoring"
        title="Scan once, or watch it forever."
        lead="A scan is a photograph. Most of what this engine measures — a certificate, a DNS record, a header set by a deploy — changes on a day nobody was looking."
      />

      <figure className="mt-12 border border-line bg-surface p-6">
        {/* 90 bars have a hard minimum width, so the strip scrolls inside its
            own box. Without this the page itself scrolls sideways on a phone —
            which this product's own accessibility pillar would flag. */}
        <div className="overflow-x-auto">
          <UptimeChart events={SAMPLE_EVENTS} />
        </div>
        <figcaption className="mt-3 text-[15px] text-muted">
          Illustration — the status-page component with one bad day in it. Not a customer’s data.
        </figcaption>
      </figure>

      <dl data-motion="stagger" className="mt-10 grid gap-x-12 gap-y-10 sm:grid-cols-2">
        {CAPABILITIES.map(({ title, body }) => (
          <div key={title}>
            <dt className="text-lg font-semibold tracking-tight">{title}</dt>
            <dd className="mt-2 max-w-[48ch] text-[15px] leading-relaxed text-ink/70 text-pretty">{body}</dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}
