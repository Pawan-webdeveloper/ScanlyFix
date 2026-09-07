/**
 * Shell for signed-in pages.
 *
 * requireUser() runs once here rather than in every page, and it returns the
 * account context so the nav can show it without a second query.
 *
 * ## Why this layout supplies the counts
 *
 * The sidebar is a client component; it displays what it is handed and queries
 * nothing. Counts for the asset badges come from this server component.
 * Repositories/containers/clouds are still on a `soon` row — counts are passed
 * so the badges light up the moment those features ship.
 */

import { listProjectSummaries, listRecentScansForUser, listReposForViewer } from '@scanlyfix/db'
import { getViewer, requireUser } from '@/lib/authz.ts'
import { SupabaseAuthProvider } from '@/components/auth/supabase-provider.tsx'
import { Sidebar } from '@/components/console/sidebar.tsx'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  const viewer = await getViewer()
  const [summaries, recentScans, repositories] = await Promise.all([
    listProjectSummaries(viewer),
    listRecentScansForUser(viewer),
    listReposForViewer(viewer),
  ])

  return (
    <SupabaseAuthProvider>
      <div className="flex min-h-dvh">
        <Sidebar
          email={user.email}
          plan={user.plan}
          sites={summaries.length}
          scans={recentScans.length}
          repositories={repositories.length}
          containers={0}
          clouds={0}
          domains={summaries.length}
        />
        <main className="min-w-0 flex-1 bg-white text-gray-900 dark:bg-white dark:text-gray-900">
          {children}
        </main>
      </div>
    </SupabaseAuthProvider>
  )
}
