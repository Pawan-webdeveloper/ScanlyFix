import { describe, expect, it } from 'vitest'
import {
  capStagger,
  countTarget,
  motionAllowed,
  prefersReducedMotion,
} from '@/components/console/motion.ts'

/**
 * The motion POLICY, not the animations: what may move, what counts as a
 * number, and how a stagger is bounded. These helpers decide whether the
 * choreography runs at all, which is exactly the part that must not silently
 * regress — a stuck hidden state is a content bug, not a style bug.
 */

describe('prefersReducedMotion', () => {
  it('answers no when there is no way to ask (server, old browser)', () => {
    expect(prefersReducedMotion(undefined)).toBe(false)
  })

  it('answers yes only when the media query matches', () => {
    expect(
      prefersReducedMotion((query) => ({
        matches: query === '(prefers-reduced-motion: reduce)' && true,
      })),
    ).toBe(true)
    expect(prefersReducedMotion(() => ({ matches: false }))).toBe(false)
  })

  it('answers no when the query mechanism throws', () => {
    expect(
      prefersReducedMotion(() => {
        throw new Error('unsupported')
      }),
    ).toBe(false)
  })
})

describe('motionAllowed', () => {
  it('is false outside a browser — no window, no animation scheduling', () => {
    expect(motionAllowed()).toBe(false)
  })
})

describe('countTarget', () => {
  it('accepts plain non-negative integers', () => {
    expect(countTarget('0')).toBe(0)
    expect(countTarget('42')).toBe(42)
    expect(countTarget('999999999')).toBe(999999999)
  })

  it('rejects everything a count-up cannot render honestly', () => {
    expect(countTarget(undefined)).toBeNull()
    expect(countTarget('')).toBeNull()
    expect(countTarget('   ')).toBeNull()
    expect(countTarget('abc')).toBeNull()
    expect(countTarget('-3')).toBeNull()
    expect(countTarget('3.5')).toBeNull()
    // '—' from an absent score is a dash in the markup, never a number to tween.
    expect(countTarget('—')).toBeNull()
  })

  it('caps absurd values so a corrupt attribute cannot set an endless tween', () => {
    expect(countTarget('1000000000')).toBeNull()
    expect(countTarget('1e21')).toBeNull()
  })
})

describe('capStagger', () => {
  it('keeps the configured step while the total fits the cap', () => {
    expect(capStagger(6, 45, 360)).toBe(45)
    expect(capStagger(9, 45, 360)).toBe(45) // 8 × 45 = 360, exactly the cap
  })

  it('shrinks the step once the list would overrun the cap', () => {
    expect(capStagger(10, 45, 360)).toBe(40) // 9 items of headroom → 40ms each
    expect(capStagger(40, 45, 360)).toBeCloseTo(360 / 39, 5)
  })

  it('is zero for degenerate inputs — one item, or no budget at all', () => {
    expect(capStagger(1, 45, 360)).toBe(0)
    expect(capStagger(0, 45, 360)).toBe(0)
    expect(capStagger(10, 0, 360)).toBe(0)
    expect(capStagger(10, 45, 0)).toBe(0)
    expect(capStagger(Number.NaN, 45, 360)).toBe(0)
  })
})
