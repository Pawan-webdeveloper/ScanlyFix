/**
 * The connection providers' marks, drawn inline.
 *
 * A console-side sibling of components/auth/provider-marks.tsx: same rules —
 * these are somebody else's trademark rendered as a mark beside its own text
 * label, single colour, `aria-hidden` (the label does the announcing), never a
 * runtime dependency for four paths.
 *
 * GITHUB reuses the exact path already drawn for the sign-in button, so the
 * two renderings of the Octocat on this site cannot drift.
 *
 * SUPABASE, GITLAB and CLOUDFLARE are simplified evocative shapes rather than
 * exact logo reproductions — a bolt, a fox mask, a two-lobe cloud — in the
 * stroke-free fill treatment GitHub's own guidelines prescribe for monochrome
 * UI. They identify the row, they do not impersonate the brand sheet.
 */

interface MarkProps {
  /** Rendered size in px. Each mark has its own viewBox. */
  size?: number
}

export function GitHubMark({ size = 18 }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

export function SupabaseMark({ size = 18 }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M14.9 1.6a.8.8 0 0 0-1.4-.2L4.9 12.1a.9.9 0 0 0 .6 1.4l5.3.9-2.3 7.1a.8.8 0 0 0 1.4.8l9.2-11.2a.9.9 0 0 0-.6-1.4l-5.3-.7 1.7-7.4Z" />
    </svg>
  )
}

export function GitLabMark({ size = 18 }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M6.6 2.9a.6.6 0 0 0-1.1.1L2.7 10 12 21.7 21.3 10l-2.8-7a.6.6 0 0 0-1.1-.1L12 7.4 6.6 2.9Z" />
    </svg>
  )
}

export function CloudflareMark({ size = 18 }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M8.2 19.5a3.7 3.7 0 0 1-.3-7.3 5.4 5.4 0 0 1 10.5-1 3.6 3.6 0 0 1-.7 8.3H8.2Z" />
    </svg>
  )
}
