import 'server-only'

import type Stripe from 'stripe'

import {
  AI_ADDON_ANSWERS,
  PLAN_LIMITS,
  type BillingPlan,
  type BillingStatus,
} from '@/lib/billing/entitlements'
import type { createAdminClient } from './admin'

/**
 * Applies verified Stripe webhook events to org_billing (BRD F13).
 *
 * Runs on the service role for the same reason clerk-sync.ts does: a webhook
 * carries no user session, so there is no token to scope by. Signature
 * verification happens in the route handler BEFORE anything here runs; this
 * module trusts its input on that basis alone.
 *
 * The database client is a parameter rather than constructed here so the
 * isolation suite can drive these functions against the local stack with its
 * own service client; the route passes createAdminClient().
 *
 * Delivery semantics, ported from the HelpMe Hub predecessor and adapted to
 * PostgREST: the events ledger records "seen" and "done" as separate states
 * (recordEventSeen / markEventProcessed), and every handler is an idempotent
 * upsert, so processing is at least once and duplicates are harmless. The
 * predecessor used a row lock to force at most once; PostgREST has no
 * select for update, and idempotent handlers make the lock unnecessary.
 */

type Db = ReturnType<typeof createAdminClient>

/**
 * Price lookup keys, the contract between scripts/stripe-seed.ts (which
 * creates the prices) and this sync (which reads them off subscription
 * items). Mapping by lookup key rather than price id means no environment
 * variable per price and a catalog that is reproducible from zero.
 */
export const PLAN_LOOKUP_KEYS: Record<string, BillingPlan> = {
  talvext_basic_monthly: 'basic',
  talvext_pro_monthly: 'pro',
  talvext_business_monthly: 'business',
}

export const AI_ADDON_LOOKUP_KEY = 'talvext_ai_addon_monthly'

/** Everything org_billing needs, extracted from one Stripe subscription. */
export type SubscriptionFacts = {
  subscriptionId: string
  customerId: string | null
  clerkOrgId: string | null
  plan: BillingPlan
  status: BillingStatus
  aiAddon: boolean
  aiAnswersIncluded: number
  orgLimit: number
  monitorLimit: number | null
  currentPeriodEnd: string | null
  /** Scheduled to end when the period turns (migration 025): access
   * continues, nothing more is charged, and the screen must say so. */
  cancelAtPeriodEnd: boolean
}

/**
 * Stripe's subscription status vocabulary folded into ours. active and
 * trialing are entitled; past_due and unpaid keep entitlements while Stripe
 * retries the card (the resolver's grace rule); everything else (canceled,
 * incomplete, incomplete_expired, paused) resolves to canceled, which the
 * resolver treats as free.
 */
export function mapSubscriptionStatus(status: Stripe.Subscription.Status): BillingStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active'
    case 'past_due':
    case 'unpaid':
      return 'past_due'
    default:
      return 'canceled'
  }
}

/**
 * Reads the facts off a subscription, or null when no item carries a Talvext
 * plan lookup key (a subscription that is not ours; ignored, never an error).
 *
 * The AI allowance is computed here, at write time, from the plan matrix:
 * plan allowance plus the add on price when present. The add on is only
 * offered with Basic at checkout; if it ever appears alongside Pro or
 * Business the arithmetic stays honest and simply adds it.
 */
export function subscriptionFacts(sub: Stripe.Subscription): SubscriptionFacts | null {
  let plan: BillingPlan | null = null
  let planItem: Stripe.SubscriptionItem | null = null
  let aiAddon = false

  for (const item of sub.items.data) {
    const lookupKey = item.price.lookup_key
    if (!lookupKey) continue
    const mapped = PLAN_LOOKUP_KEYS[lookupKey]
    if (mapped) {
      plan = mapped
      planItem = item
    } else if (lookupKey === AI_ADDON_LOOKUP_KEY) {
      aiAddon = true
    }
  }
  if (!plan || !planItem) return null

  const limits = PLAN_LIMITS[plan]
  return {
    subscriptionId: sub.id,
    customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null),
    clerkOrgId: sub.metadata?.clerk_org_id ?? null,
    plan,
    status: mapSubscriptionStatus(sub.status),
    aiAddon,
    aiAnswersIncluded: limits.aiAnswersIncluded + (aiAddon ? AI_ADDON_ANSWERS : 0),
    orgLimit: limits.orgLimit,
    monitorLimit: limits.monitorLimit,
    currentPeriodEnd: new Date(planItem.current_period_end * 1000).toISOString(),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
  }
}

// ---------------------------------------------------------------------------
// The idempotency ledger (stripe_webhook_events, migration 022).

export type EventSeenResult = 'new' | 'seen_unprocessed' | 'already_processed'

/**
 * Records the event id, insert if absent. 'already_processed' means a
 * finished duplicate: return 200 without reapplying. 'seen_unprocessed'
 * means an earlier delivery died mid flight; process again, which is safe
 * because every handler is an idempotent upsert.
 */
export async function recordEventSeen(db: Db, evt: Stripe.Event): Promise<EventSeenResult> {
  const { data, error } = await db
    .from('stripe_webhook_events')
    .upsert(
      { id: evt.id, event_type: evt.type },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    .select('id')
  if (error) throw error
  if (data.length > 0) return 'new'

  const { data: existing, error: readError } = await db
    .from('stripe_webhook_events')
    .select('processed_at')
    .eq('id', evt.id)
    .single()
  if (readError) throw readError
  return existing.processed_at ? 'already_processed' : 'seen_unprocessed'
}

/** Stamps the event done. Only called after applyStripeEvent succeeds. */
export async function markEventProcessed(db: Db, eventId: string): Promise<void> {
  const { error } = await db
    .from('stripe_webhook_events')
    .update({ processed_at: new Date().toISOString() })
    .eq('id', eventId)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// Event application.

/** Result of handling one event; the route logs this, never the payload. */
export type StripeSyncResult = { action: string; clerkOrgId?: string }

export type StripeSyncDeps = {
  /**
   * Fetches the full subscription behind a checkout session, because the
   * checkout.session.completed payload carries only the subscription id.
   * Injected so tests exercise the handlers without a Stripe network call;
   * the route passes the real SDK retrieve.
   */
  retrieveSubscription: (subscriptionId: string) => Promise<Stripe.Subscription>
}

/** The subscription facts written to org_billing, column shaped. */
function entitlementColumns(facts: SubscriptionFacts) {
  return {
    stripe_subscription_id: facts.subscriptionId,
    plan: facts.plan,
    status: facts.status,
    ai_addon: facts.aiAddon,
    ai_answers_included: facts.aiAnswersIncluded,
    org_limit: facts.orgLimit,
    monitor_limit: facts.monitorLimit,
    current_period_end: facts.currentPeriodEnd,
    cancel_at_period_end: facts.cancelAtPeriodEnd,
  }
}

async function orgIdByClerkOrgId(db: Db, clerkOrgId: string): Promise<string | null> {
  const { data, error } = await db
    .from('organizations')
    .select('id')
    .eq('clerk_org_id', clerkOrgId)
    .maybeSingle()
  if (error) throw error
  return data?.id ?? null
}

/** Upserts the org's billing row with the subscription's facts. The upsert
 * only touches the columns provided, so the clickwrap record (written by the
 * checkout action, never by the webhook) survives every sync. */
async function writeEntitlements(
  db: Db,
  orgId: string,
  facts: SubscriptionFacts,
): Promise<void> {
  const { error } = await db.from('org_billing').upsert(
    {
      org_id: orgId,
      stripe_customer_id: facts.customerId,
      ...entitlementColumns(facts),
    },
    { onConflict: 'org_id' },
  )
  if (error) throw error
}

/** Resolves which org a subscription belongs to: the clerk_org_id metadata
 * stamped at checkout first, then the unique Stripe ids on org_billing,
 * subscription before customer. Sequential rather than one OR query so a
 * pathological state where the two ids point at different rows resolves to
 * the more specific match instead of erroring into a retry loop. */
async function orgIdForSubscription(db: Db, facts: SubscriptionFacts): Promise<string | null> {
  if (facts.clerkOrgId) {
    const orgId = await orgIdByClerkOrgId(db, facts.clerkOrgId)
    if (orgId) return orgId
  }
  const { data: bySub, error: subError } = await db
    .from('org_billing')
    .select('org_id')
    .eq('stripe_subscription_id', facts.subscriptionId)
    .maybeSingle()
  if (subError) throw subError
  if (bySub) return bySub.org_id

  if (!facts.customerId) return null
  const { data: byCustomer, error: customerError } = await db
    .from('org_billing')
    .select('org_id')
    .eq('stripe_customer_id', facts.customerId)
    .maybeSingle()
  if (customerError) throw customerError
  return byCustomer?.org_id ?? null
}

export async function applyStripeEvent(
  db: Db,
  evt: Stripe.Event,
  deps: StripeSyncDeps,
): Promise<StripeSyncResult> {
  switch (evt.type) {
    case 'checkout.session.completed': {
      const session = evt.data.object
      const clerkOrgId = session.metadata?.clerk_org_id
      if (!clerkOrgId) return { action: 'checkout ignored, no clerk_org_id metadata' }
      if (session.mode !== 'subscription') {
        return { action: 'checkout ignored, not a subscription', clerkOrgId }
      }
      const subscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : (session.subscription?.id ?? null)
      if (!subscriptionId) return { action: 'checkout ignored, no subscription', clerkOrgId }

      const sub = await deps.retrieveSubscription(subscriptionId)
      const facts = subscriptionFacts(sub)
      if (!facts) return { action: 'checkout ignored, no talvext price', clerkOrgId }

      const orgId = await orgIdByClerkOrgId(db, clerkOrgId)
      // The org must exist: checkout is only reachable from a signed in admin
      // whose org the Clerk webhook already synced. Throwing returns 500, and
      // Stripe's retry covers the race where that sync is still in flight.
      if (!orgId) throw new Error(`organization not synced for checkout: ${clerkOrgId}`)

      await writeEntitlements(db, orgId, facts)
      return { action: 'checkout applied', clerkOrgId }
    }

    // subscription.created is not in the F13 spec's four event list, but it
    // shares every byte of the updated handler and closes the ordering gap
    // where Stripe emits it before checkout.session.completed.
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const facts = subscriptionFacts(evt.data.object)
      if (!facts) return { action: 'subscription ignored, no talvext price' }
      const orgId = await orgIdForSubscription(db, facts)
      if (!orgId) {
        // Not attributable yet: no metadata and no row. The checkout handler
        // owns landing the first row, so this is a benign ordering artifact.
        return { action: 'subscription ignored, no owning org' }
      }
      await writeEntitlements(db, orgId, facts)
      return { action: 'subscription applied', clerkOrgId: facts.clerkOrgId ?? undefined }
    }

    case 'customer.subscription.deleted': {
      const sub = evt.data.object
      // The subscription is gone: free limits, canceled status. The customer
      // id and the clickwrap record survive so a returning subscriber reuses
      // both. Matched on the unique subscription id; a delete for a
      // subscription we never stored matches zero rows and that is the end
      // of it.
      const free = PLAN_LIMITS.free
      const { data, error } = await db
        .from('org_billing')
        .update({
          plan: 'free',
          status: 'canceled',
          ai_addon: false,
          ai_answers_included: free.aiAnswersIncluded,
          org_limit: free.orgLimit,
          monitor_limit: free.monitorLimit,
          stripe_subscription_id: null,
          current_period_end: null,
          cancel_at_period_end: false,
        })
        .eq('stripe_subscription_id', sub.id)
        .select('org_id')
      if (error) throw error
      return {
        action: data.length > 0 ? 'subscription canceled' : 'delete ignored, unknown subscription',
      }
    }

    case 'invoice.payment_failed': {
      const invoice = evt.data.object
      const customerId =
        typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? null)
      if (!customerId) return { action: 'payment failure ignored, no customer' }
      // Honest state, nothing revoked: the resolver keeps past_due entitled
      // and the billing screen names the situation. Entitlements drop when
      // Stripe gives up and sends subscription.deleted. A failure for a
      // customer we never stored matches zero rows.
      const { data, error } = await db
        .from('org_billing')
        .update({ status: 'past_due' })
        .eq('stripe_customer_id', customerId)
        .not('stripe_subscription_id', 'is', null)
        .select('org_id')
      if (error) throw error
      return {
        action: data.length > 0 ? 'payment failure recorded' : 'payment failure ignored, unknown customer',
      }
    }

    default:
      // Signed and valid, just not an event this sync cares about. Still
      // recorded in the ledger by the route, so a retry of it is a duplicate.
      return { action: `ignored ${evt.type}` }
  }
}
