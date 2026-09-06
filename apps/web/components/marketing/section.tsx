/**
 * The landing page's structural primitives.
 *
 * One place decides the container width, the vertical rhythm and the heading
 * scale, so nine sections cannot drift apart from each other.
 *
 * The header is a numbered rule rather than a coloured eyebrow, which is the
 * whole grammar of this design: with the accent gone, structure has to be
 * carried by hairlines and by labels that read like field names. The number
 * also tells a reader where they are in a long page without a progress bar.
 *
 * Type is monospace like everything else, so the scale is a step smaller than
 * a sans page would use — the same pixel size sets noticeably wider here.
 */

import { LabeledRule } from '@/components/ui/labeled-rule.tsx'

export function Section({
  id,
  tone = 'canvas',
  children,
}: {
  id?: string
  /** 'surface' lifts a band out of the page. Used sparingly. */
  tone?: 'canvas' | 'surface'
  children: React.ReactNode
}) {
  return (
    <section
      {...(id ? { id } : {})}
      className={`scroll-mt-4 border-t border-line ${tone === 'surface' ? 'bg-surface' : ''}`}
    >
      <div className="mx-auto max-w-5xl px-6 py-20 sm:py-24">{children}</div>
    </section>
  )
}

export function SectionHeading({
  index,
  eyebrow,
  title,
  lead,
}: {
  /** Position in the page, rendered as `[ 03 ]`. */
  index: number
  eyebrow: string
  title: string
  lead?: string
}) {
  return (
    // The data-motion attributes are the landing page's motion contract
    // (components/marketing/home-motion.tsx): the island reveals the header's
    // children as one beat and reads index/name for the scan rail's label.
    // They are inert wherever no island is mounted.
    <header data-motion="heading" data-motion-index={index} data-motion-name={eyebrow}>
      <LabeledRule index={index} label={eyebrow} />

      <h2 className="mt-6 max-w-[24ch] text-2xl font-semibold tracking-[-0.03em] text-balance sm:text-[34px] sm:leading-[1.1]">
        {title}
      </h2>

      {lead && (
        <p className="mt-5 max-w-[64ch] text-base leading-relaxed text-ink/70 text-pretty sm:text-lg">
          {lead}
        </p>
      )}
    </header>
  )
}

/** The micro-label used wherever a machine-readable value needs naming. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="label text-muted">{children}</p>
}
