'use client'

/**
 * The console's motion system, one invisible island per page.
 *
 * The contract with the server markup is what makes this safe:
 *
 *  - The server always renders the FINAL state — numbers at their value,
 *    meters at their width, every section visible. A visitor without
 *    JavaScript, with JavaScript still downloading, or with reduced motion
 *    requested sees the complete page, always.
 *  - Client-side motion hides an element only in the same tick it starts
 *    animating it back. Nothing is ever hidden by CSS and left waiting for
 *    JS that may not run.
 *  - Only transform, opacity and strokeDashoffset are animated, so the
 *    choreography cannot reflow the page it decorates.
 *
 * The markup contract, per page:
 *
 *  - `data-motion-scope="name"` on the page's content container, matched by
 *    the island's `scope` prop. The island renders nothing; it finds its
 *    scope in the document on mount. (It cannot wrap the content: the pages
 *    are server components, and a wrapper div would break their flex/gap
 *    rhythm.)
 *  - `data-reveal` on a section marks a choreography GROUP; `data-reveal-item`
 *    marks the elements inside it that stagger in. Groups are watched by an
 *    IntersectionObserver, so a section animates when the visitor reaches it,
 *    not on page load where the work is wasted below the fold.
 *  - `data-count="12"` on a number counts it up when its group appears.
 *  - `data-bar` on a meter fill grows it from the left edge (scaleX — the
 *    server-rendered width never changes, so nothing reflows).
 *  - `data-draw` on the score ring's arc sweeps it from empty to its
 *    server-rendered dash length.
 *  - `data-press` on a button or link gets the press/release feedback —
 *    handled by ONE delegated listener per page, not per element.
 *
 * Above-fold sections do NOT use data-reveal: they get the `.console-enter`
 * CSS animation (globals.css), which starts at first paint instead of at
 * hydration — a page that animates in from the first frame rather than
 * flashing its final state and dipping. See that file for the reduced-motion
 * opt-out; this island bails on reduced motion before touching anything.
 */

import { useEffect, useLayoutEffect } from 'react'
import anime from 'animejs'
import { capStagger, countTarget, motionAllowed } from './motion.ts'

/**
 * useLayoutEffect is what keeps the hidden state and the first animation
 * frame in the same paint on the client — but it does nothing on the server
 * and React warns about exactly that, so the server build gets useEffect.
 */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** First value of an SVG stroke-dasharray ("314 314" → 314), or 0 if unreadable. */
function arcDash(element: Element): number {
  const dash = element.getAttribute('stroke-dasharray') ?? ''
  const first = Number.parseFloat(dash.split(/[\s,]+/)[0] ?? '')
  return Number.isFinite(first) && first > 0 ? first : 0
}

/**
 * Press feedback for everything marked `data-press` under one root, from one
 * delegated pointerdown listener — micro-interaction that costs O(1) per
 * page rather than O(n) per button. Press shortens; release springs back,
 * which is what makes a click feel physical rather than acknowledged.
 */
export function attachPressFeedback(root: Element): () => void {
  if (!motionAllowed()) return () => {}

  let pressed: Element | null = null

  const onPointerDown = (event: PointerEvent) => {
    const target =
      event.target instanceof Element ? event.target.closest('[data-press]') : null
    if (!target) return
    pressed = target
    anime.remove(target)
    anime({ targets: target, scale: 0.97, duration: 110, easing: 'easeOutQuad' })
  }
  const release = () => {
    if (!pressed) return
    const target = pressed
    pressed = null
    anime.remove(target)
    anime({
      targets: target,
      scale: 1,
      duration: 340,
      easing: 'spring(1, 80, 10, 0)',
    })
  }

  root.addEventListener('pointerdown', onPointerDown as EventListener)
  window.addEventListener('pointerup', release as EventListener)
  window.addEventListener('pointercancel', release as EventListener)
  return () => {
    root.removeEventListener('pointerdown', onPointerDown as EventListener)
    window.removeEventListener('pointerup', release as EventListener)
    window.removeEventListener('pointercancel', release as EventListener)
    if (pressed) anime.remove(pressed)
  }
}

/**
 * Runs one group's choreography: staggered entrance for its items, then the
 * counters, meters and ring draws inside it. Idempotent per group via the
 * data-revealed flag, so an IntersectionObserver callback and a re-running
 * effect can both call it without doubling an animation.
 */
function runGroup(group: HTMLElement): void {
  if (group.dataset.revealed === 'true') return
  group.dataset.revealed = 'true'

  const items = group.querySelectorAll<HTMLElement>('[data-reveal-item]')
  if (items.length > 0) {
    const step = capStagger(items.length, 45, 360)
    anime({
      targets: items,
      opacity: [0, 1],
      translateY: [10, 0],
      duration: 520,
      easing: 'easeOutExpo',
      delay: (_element: unknown, index: number) => index * step,
    })
  }

  const bars = group.querySelectorAll<HTMLElement>('[data-bar]')
  if (bars.length > 0) {
    const step = capStagger(bars.length, 70, 300)
    anime({
      targets: bars,
      scaleX: [0, 1],
      duration: 750,
      easing: 'easeOutExpo',
      delay: (_element: unknown, index: number) => index * step,
    })
  }

  group.querySelectorAll('[data-count]').forEach((element, index) => {
    const target = countTarget(element.getAttribute('data-count') ?? undefined)
    if (target === null || target === 0) return
    const state = { value: 0 }
    anime({
      targets: state,
      value: target,
      round: 1,
      duration: 900,
      easing: 'easeOutExpo',
      delay: 150 + index * 60,
      update: () => {
        element.textContent = String(state.value)
      },
    })
  })

  const arcs = group.querySelectorAll('[data-draw]')
  if (arcs.length > 0) {
    anime({
      targets: arcs,
      strokeDashoffset: (element: Element) => [arcDash(element), 0],
      duration: 1100,
      easing: 'easeOutExpo',
    })
  }
}

/**
 * The island: `<PageMotion scope="dashboard" />` anywhere inside the page's
 * `data-motion-scope="dashboard"` container. Renders nothing.
 */
export function PageMotion({ scope }: { scope: string }) {
  useIsoLayoutEffect(() => {
    if (!motionAllowed()) return
    const root = document.querySelector(`[data-motion-scope="${scope}"]`)
    if (!root) return

    const cleanups: Array<() => void> = []
    const groups = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'))

    if (groups.length > 0) {
      if (typeof IntersectionObserver === 'undefined') {
        // Very old browser: reveal everything now rather than never.
        groups.forEach(runGroup)
      } else {
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue
              observer.unobserve(entry.target)
              runGroup(entry.target as HTMLElement)
            }
          },
          // Fire slightly before a group is centred, so the entrance is
          // beginning as the visitor notices the section, not after.
          { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
        )
        groups.forEach((group) => {
          if (group.dataset.revealed === 'true') return
          observer.observe(group)
        })
        cleanups.push(() => observer.disconnect())
      }
    }

    cleanups.push(attachPressFeedback(root))

    return () => {
      for (const cleanup of cleanups) cleanup()
      // Stop in-flight tweens and clear what they wrote, and let the groups
      // run again — the strict-mode double effect (and any future remount)
      // must not inherit half-finished inline styles or a stale revealed flag.
      anime.remove(root.querySelectorAll('[data-reveal-item], [data-bar], [data-draw]'))
      for (const node of root.querySelectorAll<HTMLElement>('[data-reveal-item], [data-bar]')) {
        node.style.opacity = ''
        node.style.transform = ''
      }
      for (const node of root.querySelectorAll<SVGElement>('[data-draw]')) {
        node.style.strokeDashoffset = ''
      }
      for (const group of groups) {
        delete group.dataset.revealed
      }
    }
  }, [scope])

  return null
}
