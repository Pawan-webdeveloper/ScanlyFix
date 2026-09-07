import { ThemeToggle } from './theme-toggle.tsx'

/**
 * The uptime page's top bar — a quiet white strip with a back chevron,
 * the workspace breadcrumb, and an icon cluster on the right.
 *
 * Lives in the (app) layout but only the uptime route renders it directly:
 * every other signed-in page keeps the old sticky console header. The new
 * uptime layout sits on a white canvas, so the header is white too — no
 * hairline border below, no backdrop blur, no scroll-driven opacity. A bar
 * that disappears on scroll on a 90-day timeline page reads as a bug.
 */
export function UptimeHeader({
  breadcrumb,
  actions,
}: {
  breadcrumb: { label: string; href?: string }[]
  actions?: React.ReactNode
}) {
  return (
    <header className="flex h-14 items-center gap-2 border-b border-gray-100 bg-white px-6 text-sm text-gray-700">
      {/* Mobile opener reserved space — only present at <lg, but lg:pl-1 keeps
          the breadcrumb aligned with the desktop layout's main canvas. */}
      <h1 className="min-w-0 flex items-center gap-2 truncate pl-12 font-medium text-gray-900 lg:pl-1">
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
                className="text-gray-400"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
            )}
            {item.href ? (
              <a href={item.href} className="text-gray-500 hover:text-gray-900">
                {item.label}
              </a>
            ) : (
              <span className="text-gray-900">{item.label}</span>
            )}
          </span>
        ))}
      </h1>

      <div className="flex-1" />

      {actions}
    </header>
  )
}
