/**
 * signedInHomepageTarget is the routing rule behind "a signed-in session
 * never sees the landing page by accident": / forwards to the dashboard, the
 * ?home=1 escape hatch (the console sidebar logo's destination) opts out, and
 * every other request is untouched. A miss here is either a signed-out
 * visitor bounced to a login wall they never hit, or a signed-in one pinned
 * in place by a redirect loop between / and /dashboard.
 */

import { describe, expect, it } from 'vitest'
import { SIGNED_IN_HOMEPAGE_TARGET, signedInHomepageTarget } from '../lib/homepage-redirect.ts'

const ORIGIN = 'https://scanlyfix.test'
const url = (pathAndQuery: string) => new URL(pathAndQuery, ORIGIN)

describe('signedInHomepageTarget', () => {
  it('sends a signed-in visit to the bare homepage to the dashboard', () => {
    expect(signedInHomepageTarget(true, url('/'))).toBe(SIGNED_IN_HOMEPAGE_TARGET)
  })

  it('lets a signed-in visitor read the marketing page at /?home=1 — the console logo\'s destination', () => {
    expect(signedInHomepageTarget(true, url('/?home=1'))).toBeNull()
  })

  it('only accepts exactly home=1 as the escape hatch, so a sloppy default cannot smuggle it in', () => {
    expect(signedInHomepageTarget(true, url('/?home=0'))).toBe(SIGNED_IN_HOMEPAGE_TARGET)
    expect(signedInHomepageTarget(true, url('/?home=true'))).toBe(SIGNED_IN_HOMEPAGE_TARGET)
    expect(signedInHomepageTarget(true, url('/?homepage=1'))).toBe(SIGNED_IN_HOMEPAGE_TARGET)
  })

  it('ignores unrelated query params — only home is reserved', () => {
    expect(signedInHomepageTarget(true, url('/?ref=launch-email'))).toBe(SIGNED_IN_HOMEPAGE_TARGET)
    // The hatch still wins when other params ride along.
    expect(signedInHomepageTarget(true, url('/?ref=launch-email&home=1'))).toBeNull()
  })

  it('leaves every path other than / alone, signed in or not', () => {
    for (const path of ['/pricing', '/login', '/dashboard', '/api/health', '/projects/123']) {
      expect(signedInHomepageTarget(true, url(path))).toBeNull()
      expect(signedInHomepageTarget(false, url(path))).toBeNull()
    }
  })

  it('never redirects a signed-out visitor, including /?home=1', () => {
    expect(signedInHomepageTarget(false, url('/'))).toBeNull()
    expect(signedInHomepageTarget(false, url('/?home=1'))).toBeNull()
  })

  it('always resolves to a same-site path, so it cannot be aimed off-origin', () => {
    const target = signedInHomepageTarget(true, url('/')) ?? ''
    expect(target.startsWith('/')).toBe(true)
    expect(new URL(target, ORIGIN).origin).toBe(ORIGIN)
  })
})
