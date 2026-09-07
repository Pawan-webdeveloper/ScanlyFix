'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { useSupabaseClient } from '@/components/auth/supabase-provider.tsx'

/**
 * Signing out is a client action now, not a POST to a route.
 *
 * Supabase Auth holds the session in a cookie it manages from the client, and
 * `signOut()` is what clears it along with the refresh token on the server. A
 * route handler could delete the cookie but not the session behind it, which
 * would leave a token that still works if it were ever recovered.
 *
 * `router.refresh()` after it, because every signed-in page is server-rendered
 * against the old cookie until something re-fetches them.
 *
 * ## The confirmation
 *
 * Signing out is a one-click way to lose your place, and it lands you back on
 * the home page where scanning needs an account again — so it asks first. A
 * small dialog, not the browser's native confirm(), so it matches the product
 * and can be dismissed by Escape, by the Cancel button, or by clicking away.
 *
 * ## Why it renders through a portal
 *
 * The button lives in the app header, and that header sets `backdrop-filter`
 * for its blur. A `backdrop-filter` makes an element the containing block for
 * its `position: fixed` descendants — so an overlay rendered in place would
 * centre inside the 64px-tall header and clip, not over the viewport. The
 * portal moves it to <body>, out from under that containing block, where
 * `fixed inset-0` finally means the whole screen.
 */
export function SignOutButton({
  className,
  style,
}: {
  className?: string
  style?: React.CSSProperties
}) {
  const supabase = useSupabaseClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Close on Escape, move focus to the safe choice, and stop the page behind
  // the dialog from scrolling while it is open.
  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !pending) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [open, pending])

  async function confirmSignOut() {
    setPending(true)
    try {
      await supabase.auth.signOut()
      router.push('/')
      router.refresh()
    } finally {
      // The route change unmounts this, but if it somehow does not, do not
      // leave the button stuck mid-action.
      setPending(false)
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} style={style}>
        Sign out
      </button>

      {open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="signout-title"
            aria-describedby="signout-body"
            className="fixed inset-0 z-100 flex items-center justify-center p-4"
          >
            {/* Backdrop — clicking it cancels, a mouse convenience. Keyboard and
                assistive-tech users cancel with Escape or the Cancel button, so
                this is hidden from the accessibility tree rather than a second
                "Cancel" control competing with the real one. */}
            <div
              aria-hidden="true"
              onClick={() => {
                if (!pending) setOpen(false)
              }}
              // A fixed black scrim, not bg-ink: `ink` is near-white in dark
              // mode, so an ink overlay there washes the page to a grey haze
              // instead of dimming it. Black dims correctly in both themes, and
              // because it darkens the page below the modal's own canvas colour,
              // the modal reads as lifted above it.
              className="absolute inset-0 bg-black/60"
            />

            <div className="relative w-full max-w-md border border-line bg-canvas p-7 shadow-2xl sm:p-8">
              <h2 id="signout-title" className="text-2xl font-semibold tracking-tight">
                Sign out?
              </h2>
              <p id="signout-body" className="mt-3 text-base leading-relaxed text-muted text-pretty">
                You’ll go back to the home page. Scanning there needs an account, so you’ll sign in
                again to keep your reports.
              </p>

              <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  ref={cancelRef}
                  type="button"
                  disabled={pending}
                  onClick={() => setOpen(false)}
                  className="label inline-flex h-12 items-center justify-center border border-line px-6
                             text-sm text-ink transition-colors hover:bg-surface disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={confirmSignOut}
                  className="label inline-flex h-12 items-center justify-center border border-ink bg-ink px-6
                             text-sm text-canvas transition-colors hover:bg-transparent hover:text-ink
                             disabled:opacity-60"
                >
                  {pending ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
