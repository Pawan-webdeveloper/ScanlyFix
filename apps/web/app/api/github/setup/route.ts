/**
 * The GitHub App's Setup URL — where GitHub returns the browser after an
 * install or an update.
 *
 * ## Why every connect landed on a 404
 *
 * The Connect button builds an install URL whose `redirect_url` points at
 * `/api/github/callback` (lib/github-connect.ts), but GitHub IGNORES that once
 * the App has a "Post installation → Setup URL" configured: the Setup URL wins
 * and is where the browser is sent. That URL is `…/api/github/setup`, and no
 * such route existed — so the person arrived on the app's 404 ("There is
 * nothing at this address") with the installation never recorded, and the feed
 * showed "Connect GitHub" again however many times they retried.
 *
 * ## What this route is
 *
 * An alias, nothing more. GitHub appends `installation_id`, `setup_action` and
 * the `state` we signed; /api/github/callback already owns the entire flow —
 * it verifies the signed state, records the installation, handles the
 * `request` / `install` / `update` cases and chooses the landing page — so the
 * parameters are handed over verbatim rather than a second copy of that logic
 * being kept here. Any param GitHub sends travels through unchanged, including
 * a `code` the callback warns about when the App still requests user
 * authorization during installation.
 */

import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const target = new URL('/api/github/callback', url.origin)
  // Copy the whole query string, not a hand-picked list: GitHub owns the
  // parameter names, and a new one must not need a change here.
  target.search = url.search
  return NextResponse.redirect(target)
}
