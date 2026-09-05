/**
 * Motion policy and the feedback helpers, kept apart from the PageMotion
 * island in motion.tsx on purpose.
 *
 * This module imports NO animation library at the top level — shake() and
 * pop() load anime.js through a dynamic import, so a client component that
 * only ever wants a shake (the scan form, which the marketing pages render
 * too) does not put the animation engine in that page's first bundle. The
 * island and the sidebar, which animate on mount, import anime.js directly.
 *
 * What is testable here is the POLICY: whether motion may run at all, what
 * counts as a countable number, and how a stagger is bounded. The animation
 * calls themselves are not worth unit-testing.
 */

/**
 * True when the visitor asked the OS for reduced motion.
 *
 * The injectable matchMedia keeps this pure; production goes through
 * motionAllowed(), which answers "no preference" on the server and on any
 * failure, because for decoration the safe failure is to run, not to hide
 * content that was server-rendered visible.
 */
export function prefersReducedMotion(
  matchMedia?: (query: string) => { matches: boolean },
): boolean {
  if (!matchMedia) return false
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/**
 * The one guard every animation call site goes through. Server, odd browsers
 * and a missing matchMedia all answer "not allowed" — those are the
 * environments where scheduling an animation buys nothing and risks sticking
 * an element in its hidden state.
 */
export function motionAllowed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return !(
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
    )
  } catch {
    return false
  }
}

/**
 * Parses a `data-count` value into a count-up target. Only non-negative
 * integers animate; anything else (empty, malformed, '—') renders as written
 * and is skipped by the caller. Bounded at a billion so a corrupt attribute
 * cannot set an absurd tween length.
 */
export function countTarget(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 && value < 1e9 ? value : null
}

/**
 * Per-item delay for a staggered entrance, shrinking so the WHOLE stagger
 * never exceeds capMs. A fixed step on a long list (forty rows × 45ms) is
 * still revealing its first items when the visitor has finished reading the
 * page; a bounded total keeps every list's entrance under a beat.
 */
export function capStagger(count: number, stepMs: number, capMs: number): number {
  if (!Number.isFinite(count) || count <= 1 || stepMs <= 0 || capMs <= 0) return 0
  return Math.min(stepMs, capMs / (count - 1))
}

/** The engine, loaded once on first use. */
type Anime = typeof import('animejs')
type AnimeModule = Anime & { default?: Anime }
let animePromise: Promise<Anime> | null = null
function loadAnime(): Promise<Anime> {
  animePromise ??= import('animejs').then((module) => {
    const mod = module as AnimeModule
    // The ESM build exports the engine as its default; the CJS build IS the
    // engine. Accept whichever the bundler handed over.
    return mod.default ?? mod
  })
  return animePromise
}

/**
 * A horizontal shake for a control that just refused an input — the form
 * error already says what went wrong; the shake says WHERE without a second
 * glance. Runs once per call; call sites re-trigger it from an effect keyed
 * on the error value.
 */
export async function shake(element: HTMLElement | null): Promise<void> {
  if (!element || !motionAllowed()) return
  const anime = await loadAnime()
  anime.remove(element)
  anime({
    targets: element,
    translateX: [0, -7, 7, -5, 5, -2, 0],
    duration: 420,
    easing: 'easeInOutQuad',
  })
}

/**
 * A spring settle for a button that just changed the world a little — the
 * theme switch, where the click's result repaints the whole page and a
 * physical settle ties the before and after together.
 */
export async function pop(element: Element | null): Promise<void> {
  if (!element || !motionAllowed()) return
  const anime = await loadAnime()
  anime.remove(element)
  anime({
    targets: element,
    scale: [0.86, 1],
    duration: 260,
    easing: 'spring(1, 80, 10, 0)',
  })
}
