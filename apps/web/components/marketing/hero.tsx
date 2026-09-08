import { HeroMatrix } from './hero-matrix.tsx'
import { HeroScanFormClient } from '@/components/scan/hero-scan-form-client.tsx'
import { HeroNavClient } from './hero-nav.tsx'
import { LogoBadge } from '@/components/brand/logo.tsx'
import { Bot, Search, ShieldCheck } from './icons.tsx'
import { TOTAL_CHECKS } from '@/lib/pillars.ts'

/**
 * The hero.
 *
 * A security terminal: one saturated brand block, near-black monospace on top
 * of it, and nothing else. Every colour resolves through the HERO TOKENS block
 * in globals.css — CHANGE THE BRAND COLOUR THERE, and the headline copy in
 * HEADLINE below. No value in this file is a colour.
 *
 * The whole surface is one page-sized terminal window: a 1px frame insetting
 * the section, a nav band across the top, a scanning field in the space below
 * it, and a section label along the bottom edge. Square corners everywhere —
 * a radius anywhere in here reads as a different product.
 *
 * This is the only chrome on the landing page, which is why the nav lives
 * inside the frame rather than above it: the shared SiteHeader would be a
 * second navigation on a screen that already has one.
 */

/** Two lines, kept whole. The brackets are type, not decoration. */
const HEADLINE = ['[ Ship it.', 'Then actually check it. ]'] as const

const PILLARS = [
  { Icon: ShieldCheck, label: 'Security' },
  { Icon: Search, label: 'SEO' },
  { Icon: Bot, label: 'AEO' },
] as const

/** Fixed widths: a barcode drawn from Math.random would differ on every render. */
const BARCODE = [3, 1, 1, 2, 1, 4, 1, 1, 2, 3, 1, 1, 2, 4, 1, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 4, 1, 1] as const

const LABEL = 'font-mono text-[10px] uppercase tracking-[0.14em]'
/** The nav links' type style, shared with the nav band in hero-nav.tsx. */
const NAV_LABEL = 'font-mono text-sm uppercase tracking-[0.14em]'

export function Hero() {
  return (
    <section className="hero flex min-h-[100svh] bg-brand p-3 text-hero-ink sm:p-4">
      <div className="relative flex flex-1 flex-col">
        {/* The frame, as an overlay rather than a border on the flex column, so
            it can clip-reveal on load without clipping the content inside it. */}
        <div
          aria-hidden="true"
          className="hero-frame-in pointer-events-none absolute inset-0 z-20 border border-hero-ink"
        />

        <HeroNavClient />

        <div className="relative flex flex-1 flex-col justify-end">
          {/* The field owns the space between the nav and the wordmark, and
              fades out through the headline. It stops before the sub-copy:
              dimmed text over a glyph field is the one trade this design is
              not worth making. */}
          <div className="relative flex min-h-[12vh] flex-1 flex-col justify-end px-4 pt-[10vh] sm:px-8 lg:px-12">
            <HeroMatrix className="hero-field-mask inset-0" />

            <div className="relative z-10">
              <Wordmark />

              <h1
                className="mt-8 font-mono font-extrabold tracking-[-0.03em]"
                style={{ fontSize: 'clamp(40px, 7vw, 92px)', lineHeight: 0.98 }}
              >
                {HEADLINE.map((line, index) => (
                  <span
                    key={line}
                    className="hero-line-in block"
                    style={{ animationDelay: `${index * 90}ms` }}
                  >
                    {line}
                  </span>
                ))}
              </h1>
            </div>
          </div>

          <div className="relative z-10 px-4 pb-10 sm:px-8 sm:pb-12 lg:px-12">
            <p
              className={`hero-rise mt-7 max-w-[64ch] font-mono text-xs leading-relaxed tracking-[0.04em]
                          text-hero-ink-dim uppercase sm:text-sm`}
            >
              Paste a URL. In under a minute, get {TOTAL_CHECKS} security, SEO, and AEO checks —
              each with a copy-paste fix prompt for your AI editor.
            </p>
            {/* Stated before the box, not after the report. A gate a reader
                was warned about is an offer; the same gate unannounced is a
                bait-and-switch, and this product's whole pitch is that it does
                not bluff. */}
            <p className="hero-rise mt-3 font-mono text-xs tracking-[0.22em] text-hero-ink-dim uppercase">
              Free with an account. Pro opens every finding.
            </p>

            <div id="scan" className="hero-rise mt-9 max-w-3xl scroll-mt-24">
              <HeroScanFormClient />
            </div>
          </div>
        </div>

        <div
          className={`relative z-10 flex items-center justify-between gap-4 border-t border-hero-ink
                      px-4 py-2.5 sm:px-8 ${NAV_LABEL}`}
        >
          <span>
            [ 01 ] The checks
            <span className="hidden sm:inline"> — all {TOTAL_CHECKS}, across six pillars</span>
          </span>
          <a href="#checks" className="hero-link relative">
            Scroll ↓
          </a>
        </div>
      </div>
    </section>
  )
}

function Wordmark() {
  return (
    <div className="hero-rise flex items-center justify-between gap-4 border border-hero-ink bg-brand px-4 py-3">
      <div className="flex items-center gap-3">
        <LogoBadge size={30} />
        <span className="font-mono text-base font-semibold tracking-tight sm:text-lg">SCANLYFIX</span>
        <span className={`border border-hero-ink px-1.5 py-0.5 ${LABEL}`}>Beta</span>
      </div>

      {/* The three pillars — the one line that says WHAT gets checked. Icon
          and label only, no chip: bigger and bolder than fine print, but bare,
          so it reads as part of the wordmark rather than a row of buttons. */}
      <ul className="hidden items-center gap-6 font-mono text-sm font-semibold uppercase tracking-[0.1em] md:flex">
        {PILLARS.map(({ Icon, label }) => (
          <li key={label} className="flex items-center gap-2">
            <Icon size={17} />
            {label}
          </li>
        ))}
      </ul>

      <div aria-hidden="true" className="hidden h-6 items-stretch gap-[2px] sm:flex">
        {BARCODE.map((width, index) => (
          <span key={index} style={{ width: `${width}px` }} className="bg-hero-ink" />
        ))}
      </div>
    </div>
  )
}
