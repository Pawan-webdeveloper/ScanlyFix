"use client"

/**
 * The pillar cards' wave background, tuned to this design system.
 *
 * React Bits' defaults are violet-and-pink; this palette is the site's own:
 * ink waves fading into the horizon line-colour, theme-aware — the `dark`
 * class on <html> is the single source of truth (lib/theme.ts), watched via
 * MutationObserver so a live theme switch re-inks the waves without a
 * reload. At 35% opacity the field stays a texture: the card's headline and
 * copy must win over its decoration.
 *
 * prefers-reduced-motion stills the field (speed 0) and drops the pointer
 * parallax — motion is a delight, never a requirement.
 */

import { useEffect, useState } from 'react'
import GradientWaves from '@/components/ui/gradient-waves.tsx'

function useResolvedDark(): boolean {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    const sync = () => setDark(root.classList.contains('dark'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return dark
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  return reduced
}

export function PillarWaves() {
  const dark = useResolvedDark()
  const reducedMotion = usePrefersReducedMotion()

  return (
    <GradientWaves
      className="absolute inset-0"
      // Light: ink waves dissolving into the hairline grey. Dark: the same in
      // reverse — pale waves dissolving into the dark line colour.
      horizonColor={dark ? '#262d36' : '#d8dde3'}
      waveColor={dark ? '#e9edf2' : '#0f1115'}
      crestColor={dark ? '#949cab' : '#5b6270'}
      speed={reducedMotion ? 0 : 0.35}
      detail="low"
      opacity={0.35}
      fogDepth={18}
      mouseInteraction={!reducedMotion}
      parallaxStrength={0.35}
      grain
      grainIntensity={0.04}
    />
  )
}
