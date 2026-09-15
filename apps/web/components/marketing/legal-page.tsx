import type { ReactNode } from 'react'
import { LabeledRule } from '@/components/ui/labeled-rule.tsx'

/**
 * The shell the Privacy and Terms pages share.
 *
 * These are the two pages a reader arrives at already reluctant, so the reading
 * measure is narrow, the headings are plain, and nothing moves. The product's
 * `[ LABEL ]────` device heads them like every other screen, because a policy
 * that looks like it came from a different site is the one thing worse than not
 * having one.
 */
export function LegalPage({
  label,
  title,
  intro,
  effective,
  children,
}: {
  label: string
  title: string
  intro: string
  effective: string
  children: ReactNode
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <LabeledRule label={label} trailing={`in force ${effective}`} />

      <h1 className="mt-6 text-3xl font-semibold tracking-[-0.02em] text-balance">
        {title}
      </h1>

      <p className="mt-5 text-[15px] leading-relaxed text-muted text-pretty">{intro}</p>

      <div className="mt-12 flex flex-col gap-10">{children}</div>
    </div>
  )
}

/** One numbered section. The number is what a support email can point at. */
export function Clause({
  index,
  heading,
  children,
}: {
  index: number
  heading: string
  children: ReactNode
}) {
  return (
    <section>
      <h3 className="label text-ink">
        {`[ ${String(index).padStart(2, '0')} ] `}
        {heading}
      </h2>
      <div className="mt-4 flex flex-col gap-4 text-[15px] leading-relaxed text-pretty">
        {children}
      </div>
    </section>
  )
}

/** A two-column table of facts — what is stored, what a processor receives. */
export function FactTable({
  caption,
  rows,
}: {
  caption: string
  rows: ReadonlyArray<readonly [string, string]>
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="label pb-3 text-left text-muted">{caption}</caption>
        <tbody>
          {rows.map(([term, detail]) => (
            <tr key={term} className="border-t border-line align-top">
              <th scope="row" className="w-2/5 py-3 pr-4 font-mono text-xs font-normal text-ink">
                {term}
              </th>
              <td className="py-3 text-muted">{detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
