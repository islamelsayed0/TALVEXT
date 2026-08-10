import { describe, expect, it } from 'vitest'

import {
  AI_ADDON_ANSWERS,
  FREE_ENTITLEMENTS,
  PLAN_LIMITS,
  resolveEntitlements,
  type OrgBillingRow,
} from '@/lib/billing/entitlements'

// The resolver is the one entitlements authority (F13 PR 1). What these
// tests pin down is the shape of the frozen pricing itself
// (docs/DECISIONS.md 2026-08-07): a change to a number here is a pricing
// change and must say so in a DECISIONS entry, not slip through a refactor.

/** A row as the webhook writes it, with overridable columns. */
function row(overrides: Partial<OrgBillingRow>): OrgBillingRow {
  return {
    plan: 'basic',
    status: 'active',
    ai_answers_included: 0,
    ai_addon: false,
    org_limit: 1,
    monitor_limit: 15,
    current_period_end: '2026-09-07T00:00:00Z',
    cancel_at_period_end: false,
    stripe_customer_id: 'cus_test',
    stripe_subscription_id: 'sub_test',
    clickwrap_accepted_at: '2026-08-07T12:00:00Z',
    clickwrap_terms_version: '2026-08-01',
    ...overrides,
  }
}

describe('the frozen pricing matrix', () => {
  it('matches docs/DECISIONS.md 2026-08-07 number for number', () => {
    expect(PLAN_LIMITS.free).toEqual({
      orgLimit: 1,
      monitorLimit: 2,
      aiAnswersIncluded: 0,
      dailyDigest: false,
    })
    expect(PLAN_LIMITS.basic).toEqual({
      orgLimit: 1,
      monitorLimit: 15,
      aiAnswersIncluded: 0,
      dailyDigest: true,
    })
    expect(PLAN_LIMITS.pro).toEqual({
      orgLimit: 1,
      monitorLimit: null,
      aiAnswersIncluded: 300,
      dailyDigest: true,
    })
    expect(PLAN_LIMITS.business).toEqual({
      orgLimit: 10,
      monitorLimit: null,
      aiAnswersIncluded: 300,
      dailyDigest: true,
    })
    expect(AI_ADDON_ANSWERS).toBe(300)
  })
})

describe('absence is free tier by definition', () => {
  it('resolves null and undefined to free without erroring', () => {
    expect(resolveEntitlements(null)).toEqual(FREE_ENTITLEMENTS)
    expect(resolveEntitlements(undefined)).toEqual(FREE_ENTITLEMENTS)
  })

  it('free means 1 org, 2 monitors, no managed AI, no digest', () => {
    const free = resolveEntitlements(null)
    expect(free.plan).toBe('free')
    expect(free.orgLimit).toBe(1)
    expect(free.monitorLimit).toBe(2)
    expect(free.aiAnswersIncluded).toBe(0)
    expect(free.dailyDigest).toBe(false)
  })
})

describe('live rows pass their denormalized columns through', () => {
  it('basic: 15 monitors, digest on, no managed AI without the add on', () => {
    const e = resolveEntitlements(row({}))
    expect(e.plan).toBe('basic')
    expect(e.monitorLimit).toBe(15)
    expect(e.dailyDigest).toBe(true)
    expect(e.aiAnswersIncluded).toBe(0)
  })

  it('basic with the add on carries the add on total the webhook wrote', () => {
    const e = resolveEntitlements(row({ ai_addon: true, ai_answers_included: 300 }))
    expect(e.aiAddon).toBe(true)
    expect(e.aiAnswersIncluded).toBe(300)
  })

  it('pro: unlimited monitors as null, 300 answers included', () => {
    const e = resolveEntitlements(
      row({ plan: 'pro', monitor_limit: null, ai_answers_included: 300 }),
    )
    expect(e.monitorLimit).toBeNull()
    expect(e.aiAnswersIncluded).toBe(300)
  })

  it('business: 10 organizations', () => {
    const e = resolveEntitlements(
      row({ plan: 'business', org_limit: 10, monitor_limit: null, ai_answers_included: 300 }),
    )
    expect(e.orgLimit).toBe(10)
  })
})

describe('status rules', () => {
  it('past_due keeps entitlements and says so honestly', () => {
    const e = resolveEntitlements(row({ status: 'past_due' }))
    expect(e.status).toBe('past_due')
    expect(e.monitorLimit).toBe(15)
    expect(e.dailyDigest).toBe(true)
  })

  it('canceled drops to free limits but keeps the customer and the clickwrap record', () => {
    const e = resolveEntitlements(row({ status: 'canceled', plan: 'basic' }))
    expect(e.plan).toBe('free')
    expect(e.status).toBe('canceled')
    expect(e.monitorLimit).toBe(2)
    expect(e.dailyDigest).toBe(false)
    expect(e.aiAnswersIncluded).toBe(0)
    expect(e.stripeCustomerId).toBe('cus_test')
    expect(e.stripeSubscriptionId).toBe('sub_test')
    expect(e.clickwrapAcceptedAt).toBe('2026-08-07T12:00:00Z')
    expect(e.clickwrapTermsVersion).toBe('2026-08-01')
  })

  it('a free plan row resolves to the free matrix, whatever its columns say', () => {
    // Such a row exists for real: the clickwrap stamp creates it before any
    // checkout completes, with columns at their defaults. Free means the
    // matrix says free; a NULL monitor_limit on it must never read as
    // unlimited.
    const e = resolveEntitlements(
      row({ plan: 'free', monitor_limit: null, org_limit: 5, ai_answers_included: 900 }),
    )
    expect(e.monitorLimit).toBe(2)
    expect(e.orgLimit).toBe(1)
    expect(e.aiAnswersIncluded).toBe(0)
    expect(e.dailyDigest).toBe(false)
    expect(e.stripeCustomerId).toBe('cus_test')
  })

  it('a scheduled ending passes through: access holds, the screen can say so', () => {
    // Migration 025: cancel at period end is a stored fact, not a status.
    // The plan stays fully entitled until the period turns; what changes is
    // what the screen says and what happens next.
    const e = resolveEntitlements(row({ cancel_at_period_end: true }))
    expect(e.cancelAtPeriodEnd).toBe(true)
    expect(e.plan).toBe('basic')
    expect(e.monitorLimit).toBe(15)
    expect(e.dailyDigest).toBe(true)
  })

  it('a hand shaped row with an unknown plan or status degrades to free, never up', () => {
    expect(resolveEntitlements(row({ plan: 'enterprise' }))).toEqual(FREE_ENTITLEMENTS)
    expect(resolveEntitlements(row({ status: 'trialing' }))).toEqual(FREE_ENTITLEMENTS)
  })
})
