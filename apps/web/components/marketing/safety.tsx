import { ENGINE_VERSION } from '@scanlyfix/checks'
import { Section, SectionHeading } from './section.tsx'

/**
 * The section that removes the reason not to type a domain into the box.
 *
 * Everything here is a property of the code rather than a promise: the socket
 * hook that refuses private addresses, the absent capability that makes active
 * probing impossible rather than merely discouraged, the version string that
 * makes two scores comparable. Written as constraints, because a list of what
 * a security tool will not do is more informative than a list of what it will.
 */

const NEVER: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Never logs in, never submits a form',
    body: 'A scan is a read. It requests pages the way a browser and a crawler would, and stops there — no credentials, no POST, no state changed on your side.',
  },
  {
    title: 'Never reaches a private address',
    body: 'Every socket resolves through a guard that validates the address at connect time, so a hostname that resolves to 127.0.0.1, a cloud metadata endpoint, or anything reserved is refused before a byte is sent. Redirects are re-checked at each hop.',
  },
  {
    title: 'Never probes a backend you have not proved you own',
    body: 'The two checks that touch someone else’s infrastructure — Supabase row-level security, Firebase rules — receive the capability to make that request only on a domain you have verified. A check that skips the gate does not compile.',
  },
  {
    title: 'Never reports our outage as your defect',
    body: 'A check that fails to complete is recorded as our error and its pillar is marked provisional. A broken instrument must never be published as a bad score.',
  },
  {
    title: 'Never moves the ruler quietly',
    body: `Every scan records the engine version it was measured with — currently ${ENGINE_VERSION} — and nothing compares two scans across a change in it. Otherwise the day we ship new checks, every monitored site gets an email saying it got worse.`,
  },
  {
    title: 'Never shows you a blurred rectangle',
    body: 'The free report withholds detail by not sending it, and tells you exactly what is missing: the count and the severities. A frosted panel over text the browser already has is a bluff, and the first reader to open dev tools finds out.',
  },
]

export function Safety() {
  return (
    <Section tone="surface">
      <SectionHeading
        index={6}
        eyebrow="Safety"
        title="What ScanlyFix will never do"
        lead="You are about to hand a security tool the address of something you own. These are the limits it is built to, not the ones it intends to keep."
      />

      <dl data-motion="stagger" className="mt-12 grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-2">
        {NEVER.map(({ title, body }) => (
          <div key={title} className="min-w-0 bg-canvas p-7">
            <dt className="flex items-start gap-3 text-lg font-semibold tracking-tight text-balance">
              <Cross />
              {title}
            </dt>
            <dd className="mt-2 pl-7 text-[15px] leading-relaxed text-ink/70 text-pretty">{body}</dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}

function Cross() {
  return (
    // data-motion="draw" lets the motion island draw the stroke on arrival;
    // inert on pages without the island.
    <svg
      data-motion="draw"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="mt-1 shrink-0 text-muted"
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 5.5l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
