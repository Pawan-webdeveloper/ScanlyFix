'use client'

import { useEffect, useRef } from 'react'

/**
 * The scanning field behind the hero.
 *
 * A grid of hex glyphs that shimmers slowly — a subset of cells swapping every
 * ~110ms, with a few brightening and decaying back as though something were
 * being caught. It reads as a machine reading a page, which is what the
 * product does; a fast cascade would read as a screensaver.
 *
 * The field also watches the pointer: cells under the cursor ignite and decay
 * through the same glow path, so the machine appears to look where the
 * visitor looks. It is the one interactive beat on a page of entrances, and
 * it reuses the tick's own decay rather than adding a loop.
 *
 * Deliberately not a requestAnimationFrame loop. Only a few dozen cells change
 * per tick, so a timer that clears and repaints just those rectangles costs a
 * fraction of a full-canvas repaint at 60fps — and this is decoration that
 * must never compete with the page it decorates.
 *
 * The loop is stopped, not merely skipped, whenever it cannot be seen: off
 * screen (IntersectionObserver), on a hidden tab, and on unmount. A timer that
 * outlives its canvas is a leak that only shows up as a warm laptop.
 */

/** Hex, because the field should look like a memory dump, plus a little punctuation. */
const GLYPHS = '0123456789ABCDEF0123456789ABCDEF/\\<>*:#'

const TICK_MS = 110
/** Share of cells that swap glyph on each tick. */
const FLIP_RATE = 0.025
/** Share of cells that begin glowing on each tick. Over GLOW_TICKS this settles near 2%. */
const IGNITE_RATE = 0.004
const GLOW_TICKS = 5

const CELL_PX = 15
const CELL_PX_NARROW = 12
const NARROW_PX = 640
/** On phones half the cells are left empty — half the glyphs, half the paint cost. */
const FILL_NARROW = 0.5

const MAX_DPR = 2
const RESIZE_DEBOUNCE_MS = 150
/** Above this the field is decoration nobody can see, and allocating for it is a bug. */
const MAX_CELLS = 20_000

interface Grid {
  cols: number
  rows: number
  cellW: number
  cellH: number
  /** Glyph per cell; an empty string is a deliberately blank cell. */
  chars: string[]
  /** Remaining glow ticks per cell, 0 when at rest. */
  glow: Uint8Array
}

export function HeroMatrix({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    /**
     * Re-read on every layout rather than once at mount: the hero inverts with
     * the OS theme, and a field still painting the old ink over the new fill
     * is either invisible or a smear.
     */
    let inkRgb = '5 5 5'
    let restAlpha = 0.14
    let glowAlpha = 0.82
    let fontFamily = 'monospace'

    function readTokens(): void {
      const styles = getComputedStyle(canvas!)
      inkRgb = styles.getPropertyValue('--hero-ink-rgb').trim() || inkRgb
      restAlpha = Number(styles.getPropertyValue('--hero-field-alpha')) || restAlpha
      glowAlpha = Number(styles.getPropertyValue('--hero-field-glow-alpha')) || glowAlpha
      fontFamily = styles.fontFamily
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const dark = window.matchMedia('(prefers-color-scheme: dark)')

    let grid: Grid | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let onScreen = true

    const randomGlyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0] ?? '0'

    function paintCell(g: Grid, index: number): void {
      const char = g.chars[index]
      const x = (index % g.cols) * g.cellW
      const y = ((index / g.cols) | 0) * g.cellH
      // The canvas is transparent over the brand fill, so clearing a cell
      // restores the background rather than painting over it.
      ctx!.clearRect(x, y, g.cellW, g.cellH)
      if (!char) return

      const lit = g.glow[index] ?? 0
      const alpha = restAlpha + (glowAlpha - restAlpha) * (lit / GLOW_TICKS)
      ctx!.fillStyle = `rgb(${inkRgb} / ${alpha})`
      ctx!.fillText(char, x + g.cellW / 2, y + g.cellH / 2)
    }

    function layout(): void {
      readTokens()
      const width = canvas!.clientWidth
      const height = canvas!.clientHeight
      if (width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height)) {
        grid = null
        return
      }

      const narrow = width < NARROW_PX
      const cell = narrow ? CELL_PX_NARROW : CELL_PX
      const cols = Math.ceil(width / cell)
      const rows = Math.ceil(height / cell)
      const fill = narrow ? FILL_NARROW : 1

      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      canvas!.width = Math.round(width * dpr)
      canvas!.height = Math.round(height * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.textAlign = 'center'
      ctx!.textBaseline = 'middle'
      ctx!.font = `${Math.round(cell * 0.76)}px ${fontFamily}`

      const count = cols * rows
      if (count > MAX_CELLS) {
        grid = null
        return
      }

      const chars = new Array<string>(count)
      for (let i = 0; i < count; i++) chars[i] = Math.random() < fill ? randomGlyph() : ''

      grid = { cols, rows, cellW: width / cols, cellH: height / rows, chars, glow: new Uint8Array(count) }
      ctx!.clearRect(0, 0, width, height)
      for (let i = 0; i < count; i++) paintCell(grid, i)
    }

    function tick(): void {
      const g = grid
      if (!g) return
      const count = g.chars.length

      // Decay every cell that is still lit, so a glow fades rather than snaps.
      for (let i = 0; i < count; i++) {
        const lit = g.glow[i] ?? 0
        if (lit > 0) {
          g.glow[i] = lit - 1
          paintCell(g, i)
        }
      }

      const flips = Math.max(1, Math.round(count * FLIP_RATE))
      for (let n = 0; n < flips; n++) {
        const i = (Math.random() * count) | 0
        if (!g.chars[i]) continue
        g.chars[i] = randomGlyph()
        paintCell(g, i)
      }

      const ignitions = Math.round(count * IGNITE_RATE)
      for (let n = 0; n < ignitions; n++) {
        const i = (Math.random() * count) | 0
        if (!g.chars[i]) continue
        g.glow[i] = GLOW_TICKS
        paintCell(g, i)
      }
    }

    function start(): void {
      // One static frame is the whole animation when motion is not wanted, and
      // it still looks like a field rather than like something that failed.
      if (timer !== null || reduced.matches) return
      timer = setInterval(tick, TICK_MS)
    }

    function stop(): void {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }

    function sync(): void {
      if (onScreen && !document.hidden) start()
      else stop()
    }

    /** Cells under the pointer ignite and decay through the normal tick. */
    const POINTER_RADIUS = 2

    function onPointerMove(event: PointerEvent): void {
      const g = grid
      // timer === null means the field is at rest (off screen, hidden tab, or
      // reduced motion) — a static field should not light up for a cursor.
      if (!g || timer === null) return
      const rect = canvas!.getBoundingClientRect()
      const col = Math.floor((event.clientX - rect.left) / g.cellW)
      const row = Math.floor((event.clientY - rect.top) / g.cellH)
      if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return

      for (let dr = -POINTER_RADIUS; dr <= POINTER_RADIUS; dr++) {
        const r = row + dr
        if (r < 0 || r >= g.rows) continue
        for (let dc = -POINTER_RADIUS; dc <= POINTER_RADIUS; dc++) {
          if (dc * dc + dr * dr > POINTER_RADIUS * POINTER_RADIUS + 1) continue
          const c = col + dc
          if (c < 0 || c >= g.cols) continue
          const index = r * g.cols + c
          if (!g.chars[index]) continue
          g.glow[index] = GLOW_TICKS
          paintCell(g, index)
        }
      }
    }

    layout()
    sync()

    const observer = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry?.isIntersecting ?? false
        sync()
      },
      { threshold: 0 },
    )
    observer.observe(canvas)

    // The PARENT is observed, never the canvas: writing canvas.width changes
    // the element's own intrinsic size, so an observer on the canvas feeds its
    // own trigger and the element doubles on every callback.
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        layout()
      }, RESIZE_DEBOUNCE_MS)
    })
    const measured = canvas.parentElement ?? canvas
    resizeObserver.observe(measured)
    measured.addEventListener('pointermove', onPointerMove)

    const onVisibility = () => sync()
    const onMotionChange = () => {
      stop()
      layout()
      sync()
    }
    const onThemeChange = () => layout()
    document.addEventListener('visibilitychange', onVisibility)
    reduced.addEventListener('change', onMotionChange)
    dark.addEventListener('change', onThemeChange)

    return () => {
      stop()
      if (resizeTimer !== null) clearTimeout(resizeTimer)
      observer.disconnect()
      resizeObserver.disconnect()
      measured.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)
      reduced.removeEventListener('change', onMotionChange)
      dark.removeEventListener('change', onThemeChange)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      // block + full size: the CSS box is fixed by the parent, so the width and
      // height attributes only ever change the backing store's resolution.
      className={`hero-field-in pointer-events-none absolute block h-full w-full select-none ${className ?? ''}`}
    />
  )
}
