/**
 * The provider registry is the single source of truth for what can be
 * connected and in what order. Both the feed hub and the dashboard's bottom
 * section render from it, so the two pages can only agree if the array itself
 * is right — which is what these tests pin.
 */

import { describe, expect, it } from 'vitest'
import { PROVIDER_APPS } from '../lib/connection-providers.ts'

describe('PROVIDER_APPS', () => {
  it('renders GitHub first, Supabase second, then the rest', () => {
    expect(PROVIDER_APPS.map((app) => app.provider)).toEqual([
      'github',
      'supabase',
      'gitlab',
      'cloudflare',
    ])
  })

  it('has one entry per provider', () => {
    const providers = PROVIDER_APPS.map((app) => app.provider)
    expect(new Set(providers).size).toBe(providers.length)
  })

  it('only lists providers whose flows exist as connectable', () => {
    for (const app of PROVIDER_APPS) {
      if (app.provider === 'github' || app.provider === 'supabase') {
        expect(app.connectable, `${app.provider} should be connectable`).toBe(true)
      } else {
        expect(app.connectable, `${app.provider} is not built yet`).toBe(false)
      }
    }
  })

  it('gives every card copy that stands alone', () => {
    for (const app of PROVIDER_APPS) {
      expect(app.label.trim().length).toBeGreaterThan(0)
      expect(app.blurb.trim().length).toBeGreaterThan(0)
      expect(app.connectCta.trim().length).toBeGreaterThan(0)
    }
  })
})
