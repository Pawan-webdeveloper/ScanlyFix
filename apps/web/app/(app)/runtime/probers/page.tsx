import { redirect } from 'next/navigation'

export default async function RuntimeProbersRedirect({
  searchParams,
}: {
  searchParams?: Promise<{ projectId?: string }>
}) {
  const sp = searchParams ? await searchParams : {}
  const q = sp.projectId ? `?projectId=${sp.projectId}` : ''
  redirect(`/runtime${q}`)
}
