import type Stripe from 'stripe'
import { describe, expect, it } from 'vitest'

import {
  AI_ADDON_LOOKUP_KEY,
  mapSubscriptionStatus,
  PLAN_LOOKUP_KEYS,
  subscriptionFacts,
} from '@/lib/db/stripe-sync'

// The pure half of the Stripe webhook sync (F13 PR 1): how a Stripe
// subscription becomes org_billing columns. The database half is proven in
// tests/isolation/billing-isolation.test.ts against the local stack.

/** A subscription as the webhook sees it, minimal and overridable. */
function subscription(opts: {
  lookupKeys: string[]
  status?: Stripe.Subscription.Status
  metadata?: Record<string, string>
  customer?: string
  periodEnd?: number
}): Stripe.Subscription {
  return {
    id: 'sub_123',
    object: 'subscription',
    status: opts.status ?? 'active',
    customer: opts.customer ?? 'cus_123',
    metadata: opts.metadata ?? {},
    items: {
      object: 'list',
      data: opts.lookupKeys.map((lookupKey, i) => ({
        id: `si_${i}`,
        object: 'subscription_item',
        current_period_end: opts.periodEnd ?? 1_790_000_000,
        price: { id: `price_${i}`, object: 'price', lookup_key: lookupKey },
      })),
    },
  } as unknown as Stripe.Subscription
}

describe('the lookup key contract', () => {
  it('names exactly the four prices the seed script creates', () => {
    expect(PLAN_LOOKUP_KEYS).toEqual({
      talvext_basic_monthly: 'basic',
      talvext_pro_monthly: 'pro',
      talvext_business_monthly: 'business',
    })
    expect(AI_ADDON_LOOKUP_KEY).toBe('talvext_ai_addon_monthly')
  })
})

describe('subscriptionFacts', () => {
  it('maps each plan price to its plan and denormalizes the matrix', () => {
    const basic = subscriptionFacts(subscription({ lookupKeys: ['talvext_basic_monthly'] }))
    expect(basic).toMatchObject({
      plan: 'basic',
      orgLimit: 1,
      monitorLimit: 15,
      aiAnswersIncluded: 0,
      aiAddon: false,
    })

    const pro = subscriptionFacts(subscription({ lookupKeys: ['talvext_pro_monthly'] }))
    expect(pro).toMatchObject({ plan: 'pro', monitorLimit: null, aiAnswersIncluded: 300 })

    const business = subscriptionFacts(
      subscription({ lookupKeys: ['talvext_business_monthly'] }),
    )
    expect(business).toMatchObject({ plan: 'business', orgLimit: 10 })
  })

  it('folds the add on into the total at write time', () => {
    const facts = subscriptionFacts(
      subscription({ lookupKeys: ['talvext_basic_monthly', AI_ADDON_LOOKUP_KEY] }),
    )
    expect(facts).toMatchObject({ plan: 'basic', aiAddon: true, aiAnswersIncluded: 300 })
  })

  it('returns null for a subscription carrying no talvext plan price', () => {
    expect(subscriptionFacts(subscription({ lookupKeys: [] }))).toBeNull()
    expect(subscriptionFacts(subscription({ lookupKeys: ['someone_elses_price'] }))).toBeNull()
    // The add on alone is not a plan: nothing to entitle against.
    expect(subscriptionFacts(subscription({ lookupKeys: [AI_ADDON_LOOKUP_KEY] }))).toBeNull()
  })

  it('carries the clerk org metadata, the customer, and the period end', () => {
    const facts = subscriptionFacts(
      subscription({
        lookupKeys: ['talvext_pro_monthly'],
        metadata: { clerk_org_id: 'org_abc' },
        customer: 'cus_abc',
        periodEnd: 1_790_000_000,
      }),
    )
    expect(facts).toMatchObject({
      clerkOrgId: 'org_abc',
      customerId: 'cus_abc',
      subscriptionId: 'sub_123',
      currentPeriodEnd: new Date(1_790_000_000 * 1000).toISOString(),
    })
  })

  it('reads the period end from the plan item, not the add on item', () => {
    const sub = subscription({ lookupKeys: [AI_ADDON_LOOKUP_KEY, 'talvext_basic_monthly'] })
    expect(subscriptionFacts(sub)?.plan).toBe('basic')
  })

  it('carries a scheduled cancellation, and its absence, faithfully', () => {
    const plain = subscription({ lookupKeys: ['talvext_basic_monthly'] })
    expect(subscriptionFacts(plain)?.cancelAtPeriodEnd).toBe(false)
    const ending = {
      ...plain,
      cancel_at_period_end: true,
    } as unknown as Parameters<typeof subscriptionFacts>[0]
    expect(subscriptionFacts(ending)?.cancelAtPeriodEnd).toBe(true)
  })
})

describe('mapSubscriptionStatus', () => {
  it('folds Stripe statuses into the three ours', () => {
    expect(mapSubscriptionStatus('active')).toBe('active')
    expect(mapSubscriptionStatus('trialing')).toBe('active')
    expect(mapSubscriptionStatus('past_due')).toBe('past_due')
    expect(mapSubscriptionStatus('unpaid')).toBe('past_due')
    expect(mapSubscriptionStatus('canceled')).toBe('canceled')
    expect(mapSubscriptionStatus('incomplete')).toBe('canceled')
    expect(mapSubscriptionStatus('incomplete_expired')).toBe('canceled')
    expect(mapSubscriptionStatus('paused')).toBe('canceled')
  })
})
