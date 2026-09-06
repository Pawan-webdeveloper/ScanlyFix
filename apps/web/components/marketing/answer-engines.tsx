import { Section, SectionHeading } from './section.tsx'
import { checkTitlesIn } from '@/lib/pillars.ts'

/**
 * The pillar nobody else leads with.
 *
 * Search Console will never tell a site owner that an answer engine could not
 * read their page, because the traffic that never arrives leaves no trace in
 * any dashboard they own. That absence of a feedback loop is the whole reason
 * this pillar is worth its own section rather than a card in the grid.
 */
export function AnswerEngines() {
  const checks = checkTitlesIn('aeo')

  return (
    <Section tone="surface">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16">
        <div>
          <SectionHeading
            index={4}
            eyebrow="AI answer engines"
            title="Can ChatGPT actually read your site?"
            lead="Search is becoming answers, and an answer engine that cannot parse a page does not rank it lower — it never mentions it. Nothing in Search Console reports the citation you did not get."
          />

          <p className="mt-6 max-w-[62ch] text-base leading-relaxed text-ink/70 text-pretty sm:text-lg">
            The failures are mundane and invisible: the text arrives only after JavaScript runs, the
            robots file blocks the crawlers by name, there is no schema tying the page to a real
            entity, and no date to tell a model whether any of it is still true.
          </p>
        </div>

        <div className="border border-line bg-canvas p-7">
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">
            {checks.length} checks in this pillar
          </p>
          <ul data-motion="stagger" className="mt-4 flex flex-col">
            {checks.map((title) => (
              <li
                key={title}
                className="flex items-center gap-3 border-b border-line py-3 text-[15px] last:border-0"
              >
                <span aria-hidden="true" className="size-1.5 shrink-0 bg-accent" />
                {title}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  )
}
