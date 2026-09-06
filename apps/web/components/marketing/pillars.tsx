import { Section, SectionHeading } from './section.tsx'
import { PillarWaves } from './pillar-waves.tsx'
import { pillarSummaries, TOTAL_CHECKS } from '@/lib/pillars.ts'

/**
 * What a scan actually covers, one card per pillar.
 *
 * Counts and check names come from the registry, never from this file, so the
 * section cannot outlive the checks it advertises. The pillars are ordered by
 * size for the same reason the report orders them that way: security is where
 * most of the engine is, and pretending the six are equal would misrepresent
 * what a scan is.
 */
export function Pillars() {
  const pillars = pillarSummaries(4)

  return (
    <Section id="checks">
      <SectionHeading
        index={1}
        eyebrow="Coverage"
        title={`${TOTAL_CHECKS} checks, six pillars, one request`}
        lead="One fetch builds a shared picture of the page — headers, HTML, cookies, TLS, DNS, robots.txt — and every check is a pure function over it. That is why a full scan costs your server one page view."
      />

      <ul className="mt-12 grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
        {pillars.map((pillar) => (
          <li key={pillar.category} className="relative min-w-0 overflow-hidden bg-canvas">
            <PillarWaves />
            {/*
             * The card's content sits above the wave field: both are
             * positioned, so DOM order paints the copy on top — no z-index
             * contest to maintain.
             */}
            <div className="relative flex min-w-0 flex-col p-7">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-lg font-semibold tracking-tight">{pillar.label}</h3>
                <span className="font-mono text-lg font-semibold text-ink tabular-nums">{pillar.count}</span>
              </div>

              <p className="mt-2.5 text-[15px] leading-relaxed text-ink/70 text-pretty">{pillar.question}</p>

              <ul className="mt-5 flex flex-col gap-2 border-t border-line pt-5">
                {pillar.examples.map((example) => (
                  <li key={example} className="font-mono text-sm text-muted">
                    {example}
                  </li>
                ))}
                {pillar.count > pillar.examples.length && (
                  <li className="font-mono text-sm font-medium text-ink">
                    +{pillar.count - pillar.examples.length} more
                  </li>
                )}
              </ul>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}
