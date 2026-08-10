import 'server-only'

import { createAdminClient } from '@/lib/db/admin'

/**
 * The one entitlements authority (BRD F13, frozen pricing in
 * docs/DECISIONS.md 2026-08-07).
 *
 * Every feature gate in the app calls resolveEntitlements (pure, for code
 * that already holds a row) or getEntitlements (looks the row up by Clerk
 * org id). Nothing else reads org_billing columns to make a decision: a
 * feature check scattered as a raw column read is a pricing bug waiting for
 * the next plan change.
 *
 * Absence is free tier BY DEFINITION. Most orgs never touch Stripe, so most
 * orgs have no org_billing row, and that is the normal case, never an error.
 * The webhook denormalizes the plan matrix below onto the row at write time;
 * the resolver trusts those columns for a live row and falls back to the
 * matrix for absence and for canceled subscriptions.
 *
 * The read runs on the service role deliberately. The org_billing RLS grant
 * is select for the org's own admins only, but entitlements must resolve for
 * EVERY session (a member creating a monitor is limited by the same plan an
 * admin is), so the resolver reads past RLS server side and returns plan
 * facts, never Stripe identifiers, to non billing surfaces. See the
 * permitted caller list in src/lib/db/admin.ts.
 *
 * What this module never does: call Stripe. Entitlement state lives in
 * Postgres, written by the webhook; if Stripe is down, entitlements still
 * resolve.
 */

export type BillingPlan = 'free' | 'basic' | 'pro' | 'business'
export type BillingStatus = 'active' | 'past_due' | 'canceled'

/** Managed AI answers the add on buys per month (Basic only; Pro and
 * Business already include the same allowance in the plan). */
export const AI_ADDON_ANSWERS = 300

/**
 * The frozen pricing matrix, verbatim from docs/DECISIONS.md 2026-08-07.
 * monitorLimit null means unlimited. dailyDigest is the packaging decision
 * that the digest is a paid feature (Basic and up). Alerts are deliberately
 * absent from this matrix: incident alerts are ungated forever on every
 * tier, so there is nothing to resolve.
 */
export const PLAN_LIMITS: Record<
  BillingPlan,
  {
    orgLimit: number
    monitorLimit: number | null
    aiAnswersIncluded: number
    dailyDigest: boolean
  }
> = {
  free: { orgLimit: 1, monitorLimit: 2, aiAnswersIncluded: 0, dailyDigest: false },
  basic: { orgLimit: 1, monitorLimit: 15, aiAnswersIncluded: 0, dailyDigest: true },
  pro: { orgLimit: 1, monitorLimit: null, aiAnswersIncluded: 300, dailyDigest: true },
  business: { orgLimit: 10, monitorLimit: null, aiAnswersIncluded: 300, dailyDigest: true },
}

/**
 * The org_billing columns the resolver reads. Structural rather than the
 * generated Row type so tests build inputs without every bookkeeping column;
 * the real Row satisfies this shape.
 */
export type OrgBillingRow = {
  plan: string
  status: string
  ai_answers_included: number
  ai_addon: boolean
  org_limit: number
  monitor_limit: number | null
  current_period_end: string | null
  cancel_at_period_end: boolean
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  clickwrap_accepted_at: string | null
  clickwrap_terms_version: string | null
}

export type Entitlements = {
  plan: BillingPlan
  status: BillingStatus
  orgLimit: number
  /** null means unlimited. */
  monitorLimit: number | null
  /** Total managed AI answers per month, add on already folded in. Zero
   * means the managed path is closed. BYOK chat never consults this. */
  aiAnswersIncluded: number
  aiAddon: boolean
  dailyDigest: boolean
  currentPeriodEnd: string | null
  /** The subscription is scheduled to end at currentPeriodEnd: access
   * continues until then, nothing more is charged, the screen says so. */
  cancelAtPeriodEnd: boolean
  /** Present once the org has ever checked out; what "Manage billing" needs. */
  stripeCustomerId: string | null
  /** Present while a subscription exists; what the add on toggle edits. */
  stripeSubscriptionId: string | null
  clickwrapAcceptedAt: string | null
  clickwrapTermsVersion: string | null
}

/** Free tier, the resolver's floor and fallback. */
export const FREE_ENTITLEMENTS: Entitlements = {
  plan: 'free',
  status: 'active',
  orgLimit: PLAN_LIMITS.free.orgLimit,
  monitorLimit: PLAN_LIMITS.free.monitorLimit,
  aiAnswersIncluded: PLAN_LIMITS.free.aiAnswersIncluded,
  aiAddon: false,
  dailyDigest: PLAN_LIMITS.free.dailyDigest,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  clickwrapAcceptedAt: null,
  clickwrapTermsVersion: null,
}

function isBillingPlan(value: string): value is BillingPlan {
  return value === 'free' || value === 'basic' || value === 'pro' || value === 'business'
}

function isBillingStatus(value: string): value is BillingStatus {
  return value === 'active' || value === 'past_due' || value === 'canceled'
}

/**
 * Row to entitlements, pure. The rules, in order:
 *
 *   - No row: free. The normal case for every org that never opened billing.
 *   - Unrecognizable plan or status: free. The check constraints make this
 *     unreachable from the database; the guard is for a row shaped by hand.
 *   - Canceled: free LIMITS, but the row's Stripe customer id and clickwrap
 *     record survive, so a returning subscriber reuses their customer and
 *     their acceptance history is never erased.
 *   - Active and past_due: the row's denormalized columns as written by the
 *     webhook. past_due keeps its entitlements on purpose: Stripe is still
 *     retrying the card, the billing screen shows the state honestly, and
 *     cutting service over a bank hiccup is the kind of silent failure the
 *     frozen pricing forbids. The webhook flips status to canceled when
 *     Stripe gives up, and that is when the limits drop.
 */
export function resolveEntitlements(row: OrgBillingRow | null | undefined): Entitlements {
  if (!row) return FREE_ENTITLEMENTS
  if (!isBillingPlan(row.plan) || !isBillingStatus(row.status)) {
    return FREE_ENTITLEMENTS
  }

  // A canceled subscription resolves to free limits, and so does any row
  // whose plan IS free: a row can exist before checkout completes (the
  // clickwrap stamp creates one), and free means the matrix says free, never
  // whatever a partially written column happens to hold. Belt and braces
  // with migration 023, which defaults monitor_limit to 2 so the row itself
  // does not read as unlimited.
  if (row.status === 'canceled' || row.plan === 'free') {
    return {
      ...FREE_ENTITLEMENTS,
      status: row.status,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      clickwrapAcceptedAt: row.clickwrap_accepted_at,
      clickwrapTermsVersion: row.clickwrap_terms_version,
    }
  }

  return {
    plan: row.plan,
    status: row.status,
    orgLimit: row.org_limit,
    monitorLimit: row.monitor_limit,
    aiAnswersIncluded: row.ai_answers_included,
    aiAddon: row.ai_addon,
    dailyDigest: PLAN_LIMITS[row.plan].dailyDigest,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    clickwrapAcceptedAt: row.clickwrap_accepted_at,
    clickwrapTermsVersion: row.clickwrap_terms_version,
  }
}

/**
 * Effective entitlements for an org by Clerk org id. Two service role reads:
 * the org row, then its billing row. An org missing from Postgres entirely
 * (webhook lag on a brand new org) is free tier like any other absence;
 * gates degrade to the free experience rather than erroring a signup.
 */
export async function getEntitlements(clerkOrgId: string): Promise<Entitlements> {
  const db = createAdminClient()

  const { data: org, error: orgError } = await db
    .from('organizations')
    .select('id')
    .eq('clerk_org_id', clerkOrgId)
    .maybeSingle()
  if (orgError) throw orgError
  if (!org) return FREE_ENTITLEMENTS

  const { data: billing, error: billingError } = await db
    .from('org_billing')
    .select('*')
    .eq('org_id', org.id)
    .maybeSingle()
  if (billingError) throw billingError

  return resolveEntitlements(billing)
}
