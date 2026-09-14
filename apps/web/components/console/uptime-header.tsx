import { ThemeToggle } from './theme-toggle.tsx'

/**
 * The uptime detail page's top bar — a breadcrumb rather than a page title,
 * because this page is always reached from somewhere.
 *
 * Every other signed-in page uses PageHeader; this one needs the trail back to
 * the project. It is otherwise the console's own surface — c-card on c-line,
 * the same tokens as the sidebar — so it follows the theme. It deliberately
 * does not fade or blur on scroll: a bar that disappears while you are reading
 * a 90-day timeline reads as a bug.
 */
export function UptimeHeader({
  breadcrumb,
  actions,
}: {
  breadcrumb: { label: string; href?: string }[]
  actions?: React.ReactNode
}) {
  return (
    <header className="flex h-14 items-center gap-2 border-b border-c-line bg-c-card px-6 text-sm text-c-ink">
      {/* Mobile opener reserved space — only present at <lg, but lg:pl-1 keeps
          the breadcrumb aligned with the desktop layout's main canvas. */}
      <h1 className="min-w-0 flex items-center gap-2 truncate pl-12 font-medium text-c-ink lg:pl-1">
        {breadcrumb.map((item, index) => (
          <span key={item.label} className="flex items-center gap-2">
            {index > 0 && (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="text-c-muted/70"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
            )}
            {item.href ? (
              <a href={item.href} className="text-c-muted hover:text-c-ink">
                {item.label}
              </a>
            ) : (
              <span className="text-c-ink">{item.label}</span>
            )}
          </span>
        ))}
      </h1>

      <div className="flex-1" />

      {actions}
    </header>
  )
}
