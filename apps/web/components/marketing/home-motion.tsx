'use client'

/**
 * The landing page's motion system, one island for the whole page.
 *
 * The motion thesis comes from the product: ScanlyFix is a scanner, and the
 * page already dresses like its own output — a terminal hero with a scanning
 * field, sections numbered `[ 01 ]`…`[ 08 ]` like readouts. So the page is
 * scanned as the visitor reads it:
 *
 *  - THE SCAN RAIL (the one authored moment): a fixed hairline on the left,
 *    after the hero, whose fill tracks reading progress and whose label names
 *    the section currently being read — the scanner's position in the report.
 *  - Sections "report in": headings and their content rise once as they are
 *    reached; lists cascade only where the content is genuinely a list.
 *  - The uptime strip's 90 bars grow in — ninety days of checks accumulating.
 *  - The evidence table's rows read in line by line — the section's whole
 *    point is reading a raw server response.
 *  - Safety crosses draw themselves; pillar check counts count up.
 *  - The FAQ answers expand with the accordion instead of snapping.
 *
 * What is deliberately absent: pinning, scroll hijacks, parallax layers,
 * SplitText, marquees. A terminal page reads linearly; the choreography must
 * never fight the copy for attention. The hero's entrance stays CSS
 * (first-paint, no-JS-safe) — GSAP never touches above the fold.
 *
 * Contract with the server markup, same as the console's motion island:
 * everything renders in its final state; hiding happens only in this effect,
 * in the same tick the reveal is scheduled. The engine loads through a
 * dynamic import — this page's Core Web Vitals are the product's own showcase,
 * and the choreography is worthless to a visitor who never scrolls. Reduced
 * motion gets the static page and no rail: a progress indicator nobody can
 * see move is dead chrome.
 */

import { useEffect, useRef } from 'react'

const SECTIONS_PLACEHOLDER = '08'

export function HomeMotion() {
  const railRef = useRef<HTMLDivElement>(null)
  const indexRef = useRef<HTMLSpanElement>(null)
  const totalRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const rail = railRef.current
    if (!rail) return

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      rail.style.display = 'none'
      return
    }

    let disposed = false
    let cleanup: (() => void) | null = null

    void Promise.all([import('gsap'), import('gsap/ScrollTrigger')]).then(
      ([{ default: gsap }, { ScrollTrigger }]) => {
        if (disposed) return
        gsap.registerPlugin(ScrollTrigger)

        const faqRemovals: Array<() => void> = []

        const ctx = gsap.context(() => {
          /* ---------------------------------------------------------------- */
          /* The scan rail                                                    */
          /* ---------------------------------------------------------------- */

          const fill = rail.querySelector<HTMLElement>('.scan-rail-fill')
          const indexLabel = indexRef.current
          const totalLabel = totalRef.current
          if (fill && indexLabel && totalLabel) {
            const setFill = gsap.quickSetter(fill, 'scaleY') as (value: number) => void
            gsap.set(fill, { scaleY: 0 })

            // The rail exists only while there is something to read: it fades
            // in past the hero and goes with it when the visitor returns.
            ScrollTrigger.create({
              trigger: '.hero',
              start: 'bottom 66%',
              end: 'bottom 40%',
              onEnter: () => gsap.to(rail, { autoAlpha: 1, duration: 0.35, ease: 'power2.out' }),
              onLeaveBack: () => gsap.to(rail, { autoAlpha: 0, duration: 0.3, ease: 'power2.in' }),
            })

            // Reading progress, the scrub the rail exists for.
            ScrollTrigger.create({
              start: 0,
              end: 'max',
              onUpdate: (self) => setFill(self.progress),
            })
          }

          /* ---------------------------------------------------------------- */
          /* Section reveals + the current-section readout                    */
          /* ---------------------------------------------------------------- */

          const headings = gsap.utils.toArray<HTMLElement>('[data-motion="heading"]')

          if (totalLabel) {
            totalLabel.textContent = String(headings.length).padStart(2, '0')
          }

          // The numbered rule, the title and the lead arrive as one beat.
          headings.forEach((header) => {
            gsap.from(gsap.utils.toArray(header.children), {
              y: 24,
              opacity: 0,
              duration: 0.6,
              ease: 'power3.out',
              stagger: 0.09,
              scrollTrigger: { trigger: header, start: 'top 80%', once: true },
            })
          })

          if (fill && indexLabel) {
            // One contiguous range per section — each ends exactly where the
            // next begins — so ANY scroll position, including an instant jump
            // from the nav or the End key, lands in exactly one range and the
            // label is always the section on screen.
            headings.forEach((header, i) => {
              const next = headings[i + 1]
              const index = header.dataset.motionIndex
              const name = header.dataset.motionName
              if (index === undefined) return
              ScrollTrigger.create({
                trigger: header,
                start: 'top 55%',
                ...(next ? { endTrigger: next, end: 'top 55%' } : { end: 'max' }),
                onToggle: (self) => {
                  if (!self.isActive) return
                  indexLabel.textContent = `[ ${index.padStart(2, '0')} ]`
                  if (name) rail.title = name
                },
              })
            })
          }

          /* ---------------------------------------------------------------- */
          /* Lists cascade only where the content is a list                   */
          /* ---------------------------------------------------------------- */

          document.querySelectorAll<HTMLElement>('[data-motion="stagger"]').forEach((group) => {
            const items = gsap.utils.toArray(group.children)
            // A bounded total: long grids finish their cascade inside a beat.
            const step = items.length > 1 ? Math.min(0.08, 0.5 / (items.length - 1)) : 0
            gsap.from(items, {
              y: 16,
              opacity: 0,
              duration: 0.5,
              ease: 'power2.out',
              stagger: step,
              scrollTrigger: { trigger: group, start: 'top 82%', once: true },
            })
          })

          /* ---------------------------------------------------------------- */
          /* The evidence table reads in, line by line                        */
          /* ---------------------------------------------------------------- */

          document.querySelectorAll<HTMLElement>('[data-motion="rows"]').forEach((group) => {
            gsap.from(gsap.utils.toArray(group.children), {
              opacity: 0,
              x: -8,
              duration: 0.4,
              ease: 'power2.out',
              stagger: 0.05,
              scrollTrigger: { trigger: group, start: 'top 85%', once: true },
            })
          })

          /* ---------------------------------------------------------------- */
          /* Ninety days of checks accumulating                               */
          /* ---------------------------------------------------------------- */

          document.querySelectorAll<HTMLElement>('[data-motion="bars"]').forEach((group) => {
            gsap.from(gsap.utils.toArray(group.children), {
              scaleY: 0,
              transformOrigin: 'bottom',
              duration: 0.5,
              ease: 'power2.out',
              stagger: { amount: 0.8, from: 'start' },
              scrollTrigger: { trigger: group, start: 'top 85%', once: true },
            })
          })

          /* ---------------------------------------------------------------- */
          /* Counts: the numbers are the claims, so they land once, audibly   */
          /* ---------------------------------------------------------------- */

          document.querySelectorAll<HTMLElement>('[data-motion-count]').forEach((element) => {
            const target = Number.parseInt(element.textContent ?? '', 10)
            if (!Number.isInteger(target) || target <= 0) return
            const state = { value: 0 }
            gsap.to(state, {
              value: target,
              duration: 1,
              ease: 'power1.out',
              onUpdate: () => {
                element.textContent = String(Math.round(state.value))
              },
              scrollTrigger: { trigger: element, start: 'top 88%', once: true },
            })
          })

          /* ---------------------------------------------------------------- */
          /* Safety crosses draw themselves                                   */
          /* ---------------------------------------------------------------- */

          document.querySelectorAll<SVGSVGElement>('[data-motion="draw"]').forEach((svg) => {
            const strokes = svg.querySelectorAll<SVGGeometryElement>('circle, path')
            strokes.forEach((shape) => {
              const length = shape.getTotalLength()
              gsap.set(shape, { strokeDasharray: length, strokeDashoffset: length })
            })
            gsap.to(strokes, {
              strokeDashoffset: 0,
              duration: 0.5,
              ease: 'power2.inOut',
              stagger: 0.12,
              scrollTrigger: { trigger: svg, start: 'top 88%', once: true },
            })
          })

          /* ---------------------------------------------------------------- */
          /* FAQ: the accordion expands through a CSS grid row                */
          /* ---------------------------------------------------------------- */

          document.querySelectorAll<HTMLDetailsElement>('details[data-motion-faq]').forEach((details) => {
            const summary = details.querySelector('summary')
            const answer = details.querySelector<HTMLElement>('[data-motion-faq-answer]')
            if (!summary || !answer) return

            // The transition itself lives in globals.css on the wrapper; this
            // handler only pins the start value, forces a style flush, and
            // releases the end value — the browser owns the tween. (Tweening
            // grid-template-rows from JS crashed renderers; a CSS transition
            // on the same property does not.)
            let timer: number | undefined

            const onToggle = (event: Event) => {
              event.preventDefault()
              window.clearTimeout(timer)
              if (details.open) {
                answer.style.gridTemplateRows = '1fr'
                answer.getBoundingClientRect()
                answer.style.gridTemplateRows = '0fr'
                timer = window.setTimeout(() => {
                  details.open = false
                  answer.style.gridTemplateRows = ''
                }, 300)
              } else {
                details.open = true
                answer.style.gridTemplateRows = '0fr'
                answer.getBoundingClientRect()
                answer.style.gridTemplateRows = '1fr'
                timer = window.setTimeout(() => {
                  answer.style.gridTemplateRows = ''
                }, 300)
              }
            }
            summary.addEventListener('click', onToggle)
            faqRemovals.push(() => {
              window.clearTimeout(timer)
              summary.removeEventListener('click', onToggle)
            })
          })

          /* Font loading shifts every measured trigger position. */
          void document.fonts?.ready.then(() => ScrollTrigger.refresh())
        })

        cleanup = () => {
          for (const remove of faqRemovals) remove()
          ctx.revert()
        }
      },
    )

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [])

  return (
    <div
      ref={railRef}
      aria-hidden="true"
      className="invisible fixed inset-y-0 left-5 z-40 hidden flex-col items-center justify-center gap-3 opacity-0 lg:flex"
    >
      <span
        ref={indexRef}
        className="font-mono text-[10px] tracking-[0.14em] text-muted tabular-nums"
      >
        [ 00 ]
      </span>
      <span className="relative block h-44 w-px bg-line">
        <span className="scan-rail-fill absolute inset-0 origin-top scale-y-0 bg-ink" />
      </span>
      <span
        ref={totalRef}
        className="font-mono text-[10px] tracking-[0.14em] text-muted tabular-nums"
      >
        {SECTIONS_PLACEHOLDER}
      </span>
    </div>
  )
}
