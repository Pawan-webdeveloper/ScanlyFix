/**
 * The data behind the dashboard's score radar.
 *
 * Server-side on purpose: the axis list comes from the live check registry,
 * and importing that registry into a client component would ship all 80+
 * checks to the browser just to learn there are six pillars. The server
 * shapes the data here; the ScoreRadar island receives plain numbers.
 *
 * The rules are PillarScores' rules, for the same reason: only pillars the
 * registry actually covers get an axis (an uncovered pillar scores 100 by
 * doing nothing, and plotting that would be a lie of omission), and a
 * degraded pillar stays on the chart — its number is provisional, but it is
 * still the best reading, and hiding the axis would hide the weakness.
 */

import { allChecks, type Category, type ScanScores } from '@scanlyfix/checks'

const LABEL: Record<Category, string> = {
  security: 'Security',
  seo: 'SEO',
  aeo: 'AI answers',
  performance: 'Performance',
  accessibility: 'Accessibility',
  compliance: 'Compliance',
}

/** Derived from the live registry, exactly as the landing page derives it. */
function coveredPillars(): Category[] {
  const counts = new Map<Category, number>()
  for (const check of allChecks) counts.set(check.category, (counts.get(check.category) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([category]) => category)
}

export interface RadarAxis {
  pillar: Category
  label: string
  score: number
}

export function radarScoreData(scores: ScanScores): RadarAxis[] {
  return coveredPillars().map((pillar) => ({
    pillar,
    label: LABEL[pillar],
    score: scores[pillar],
  }))
}
