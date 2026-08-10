import { afterEach, describe, expect, it, vi } from 'vitest'

import { stripeIsTestMode } from '@/lib/billing/stripe'

// The live switch (docs/DECISIONS.md 2026-08-07 gates): the billing screen's
// no real charge sentence must be derived from the key actually in use,
// never from a flag that could drift from it. What these pin is the
// derivation, so the claim disappears by itself the moment a live key lands
// and can never be shown alongside one.

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('stripeIsTestMode', () => {
  it('is test mode for test keys and for no key at all', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_abc')
    expect(stripeIsTestMode()).toBe(true)
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_abc')
    expect(stripeIsTestMode()).toBe(true)
    // Absent key: nothing can be charged, so the sentence stays true.
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(stripeIsTestMode()).toBe(true)
  })

  it('is live the moment a live key is in use, restricted or full', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_abc')
    expect(stripeIsTestMode()).toBe(false)
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_live_abc')
    expect(stripeIsTestMode()).toBe(false)
  })
})
