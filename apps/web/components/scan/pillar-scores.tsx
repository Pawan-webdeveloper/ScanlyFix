/**
 * The breakdown that explains the ring.
 *
 * Only pillars the registry actually covers are listed. A pillar with no checks
 * scores 100 because nothing deducted from it, and printing that next to real
 * scores would be a lie of omission — the reader would think accessibility was
 * measured and passed.
 *
 * A degraded pillar is marked rather than printed bare. Its number is the best
 * reading available, but a check in it did not complete, so presenting it as
 * measured would repeat the exact mistake the scoring change was made to fix.
 */

import { allChecks, type Category, type ScanScores } from '@scanlyfix/checks'
import { scoreColor } from './score-ring.tsx'

const LABEL: Record<Category, string> = {
  security: 'Security',
  seo: 'SEO',
  aeo: 'AI answer engines',
  performance: 'Performance',
  accessibility: 'Accessibility',
  compliance: 'Compliance',
}

/** Derived from the live registry for the same reason the landing page is. */
function coveredPillars(): Category[] {
  const counts = new Map<Category, number>()
  for (const check of allChecks) counts.set(check.category, (counts.get(check.category) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([category]) => category)
}

export function PillarScores({ scores }: { scores: ScanScores }) {
  const degraded = new Set(scores.degraded)

  return (
    <dl className="flex flex-col gap-3">
      {coveredPillars().map((pillar) => {
        const value = scores[pillar]
        const isDegraded = degraded.has(pillar)

        return (
          <div key={pillar} className="flex items-center gap-4">
            <dt className="w-44 shrink-0 text-base">
              {LABEL[pillar]}
              {isDegraded && (
                <span className="ml-2 text-sm text-muted" title="A check in this pillar did not complete">
                  provisional
                </span>
              )}
            </dt>

            {/* The bar and the number are one <dd>: a <dl> may only pair <dt>
                with <dd>, and a bare <div> between them breaks the association
                a screen reader relies on to read the pillar and its score
                together. */}
            <dd className="flex flex-1 items-center gap-4">
              <div
                className="h-2.5 flex-1 overflow-hidden bg-surface"
                role="meter"
                aria-valuenow={value}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={LABEL[pillar]}
              >
                <div
                  {...(value > 0 ? { 'data-bar': '' } : {})}
                  className="h-full"
                  style={{ width: `${value}%`, backgroundColor: scoreColor(value) }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-base font-semibold tabular-nums">{value}</span>
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
