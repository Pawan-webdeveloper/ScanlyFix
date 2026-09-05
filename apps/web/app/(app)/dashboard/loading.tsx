import { Skeleton, SkeletonPage } from '@/components/ui/skeleton.tsx'

/**
 * Shaped to the dashboard's real card system — scan panel, stat tiles,
 * two-column rows, list rows — in the same order the page renders them, so
 * the page does not reflow when the data lands.
 */
export default function DashboardLoading() {
  return (
    <SkeletonPage label="your dashboard" className="console flex min-h-dvh flex-col bg-c-bg text-c-ink">
      <div className="flex h-16 items-center gap-3 border-b border-c-line bg-c-bg/80 px-4 sm:px-6">
        <div className="pl-12 lg:pl-1">
          <Skeleton className="h-4 w-24 rounded" />
        </div>
        <div className="flex-1" />
        <Skeleton className="h-8 w-24 rounded-lg" />
        <Skeleton className="h-8 w-8 rounded-full" />
      </div>

      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10">
        <div className="rounded-lg border border-c-line bg-c-card p-8 sm:p-10">
          <Skeleton className="h-7 w-40 rounded" />
          <Skeleton className="mt-3 h-4 w-80 rounded" />
          <Skeleton className="mt-6 h-11 w-full max-w-2xl rounded-lg" />
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((tile) => (
            <div key={tile} className="rounded-lg border border-c-line bg-c-card p-5">
              <Skeleton className="h-3.5 w-20 rounded" />
              <Skeleton className="mt-3 h-8 w-12 rounded" />
              <Skeleton className="mt-2 h-3 w-24 rounded" />
            </div>
          ))}
        </div>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-lg border border-c-line bg-c-card">
            <div className="border-b border-c-line px-6 py-4">
              <Skeleton className="h-4 w-28 rounded" />
            </div>
            <div className="px-6 py-6">
              <Skeleton className="h-2 w-full rounded-full" />
              <Skeleton className="mt-6 h-8 w-24 rounded" />
              <Skeleton className="mt-3 h-4 w-48 rounded" />
            </div>
          </div>
          <div className="overflow-hidden rounded-lg border border-c-line bg-c-card">
            <div className="border-b border-c-line px-6 py-4">
              <Skeleton className="h-4 w-24 rounded" />
            </div>
            <div className="flex flex-col items-center gap-3 px-6 py-8">
              <Skeleton className="h-11 w-11 rounded-lg" />
              <Skeleton className="h-4 w-48 rounded" />
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((tile) => (
            <div key={tile} className="rounded-lg border border-c-line bg-c-card p-4">
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="mt-3 h-4 w-full rounded" />
              <Skeleton className="mt-2 h-3 w-32 rounded" />
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-lg border border-c-line bg-c-card">
          {[0, 1, 2].map((row) => (
            <div key={row} className={`flex items-center gap-4 px-6 py-4 ${row > 0 ? 'border-t border-c-line' : ''}`}>
              <Skeleton className="h-9 w-9 rounded-md" />
              <div className="flex-1">
                <Skeleton className="h-4 w-40 rounded" />
                <Skeleton className="mt-1.5 h-3 w-56 rounded" />
              </div>
              <Skeleton className="h-6 w-8 rounded" />
            </div>
          ))}
        </div>
      </div>
    </SkeletonPage>
  )
}
