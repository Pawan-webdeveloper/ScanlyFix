import { ScanFormClient } from '@/components/scan/scan-form-client.tsx'
import { TOTAL_CHECKS } from '@/lib/pillars.ts'

/**
 * The same form as the hero, at the bottom.
 *
 * Literally the same component — a reader who scrolled the whole page should
 * not have to scroll back, and a second, subtly different form is how the two
 * drift until one of them stops validating the way the API does.
 *
 * The closing ask reveals as one beat (data-motion="heading" gives its
 * children the same arrival the numbered sections get), because it is the
 * last readout of the scan.
 */
export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-line">
      <div aria-hidden="true" className="bg-grid pointer-events-none absolute inset-0" />

      <div
        data-motion="heading"
        className="relative mx-auto max-w-5xl px-6 py-20 sm:py-28"
      >
        <h2 className="max-w-[22ch] text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Find out what yours is quietly getting wrong.
        </h2>
        <p className="mt-4 max-w-[52ch] text-lg leading-relaxed text-ink/70 text-pretty">
          {TOTAL_CHECKS} checks, the evidence behind every one, and a prompt that fixes them. About
          a second, and a free account.
        </p>

        <div className="mt-8 max-w-xl">
          <ScanFormClient />
        </div>
      </div>
    </section>
  )
}
