import { ThemeToggle } from './theme-toggle.tsx'

/**
 * The console's one sticky header, shared by every signed-in page.
 *
 * Before this component, each console page drew its own top bar — two pages
 * had one, three had nothing, and the theme switch existed on exactly one.
 * A console is one tool, not five: the header is where that is said. Title
 * left, actions right, theme switch always present, and the mobile rail
 * button's corner always reserved for it by the padding.
 *
 * Server component on purpose: it renders props, it queries nothing, and the
 * ThemeToggle below it is already the client island.
 */
export function PageHeader({
  title,
  actions,
}: {
  title: string
  actions?: React.ReactNode
}) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-c-line bg-c-bg/80 px-4 backdrop-blur-md sm:px-6">
      <h1 className="min-w-0 truncate pl-12 text-sm font-semibold text-c-ink lg:pl-1">
        {title}
      </h1>

      <div className="flex-1" />

      {actions}
      <ThemeToggle />
    </header>
  )
}
