"use client"

/**
 * The pillar cards' wave background, running the stock React Bits defaults —
 * violet horizon (#5227FF), pink wave bodies (#FF9FFC), white crests, full
 * opacity, pointer parallax on — exactly as documented on reactbits.dev.
 *
 * Every prop below is the component's own default, so nothing is repeated
 * here: the component's defaults and the documented settings cannot drift.
 * The `ogl` dependency is already declared in apps/web/package.json.
 */

import GradientWaves from '@/components/ui/gradient-waves.tsx'

export function PillarWaves() {
  return <GradientWaves className="absolute inset-0" />
}
