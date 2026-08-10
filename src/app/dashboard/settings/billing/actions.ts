'use server'

import { auth } from '@clerk/nextjs/server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { TERMS_EFFECTIVE } from '@/app/(legal)/_content/terms'
import {
  AI_ADDON_PRICE_LOOKUP_KEY,
  aiAddonChange,
  CheckoutValidationError,
  lookupKeysForSelection,
  parseCheckoutSelection,
} from '@/lib/billing/checkout-rules'
import { getEntitlements } from '@/lib/billing/entitlements'
import { ensurePortalConfiguration } from '@/lib/billing/portal-config'
import { createStripeClient } from '@/lib/billing/stripe'
import { createAdminClient } from '@/lib/db/admin'
import { billingOrgUuid, recordClickwrapAcceptance } from '@/lib/db/billing'
import { getActiveOrgViewer } from '@/lib/auth/org-viewer'
import { errorName, logError } from '@/lib/log'

/**
 * The two billing server actions (F13 PR 2): start a Stripe Checkout
 * session, and open the Stripe customer portal. No card field ever exists in
 * this app; both actions end in a redirect to a Stripe hosted page.
 *
 * THE CLICKWRAP GATE lives in startCheckoutAction and its order is the whole
 * point: validate the acceptance (refusing without it, whatever the browser
 * claimed), record it on the org's billing row with the terms version, and
 * only then create the checkout session. There is never a subscription whose
 * terms were not accepted first. See docs/DECISIONS.md 2026-08-07.
 *
 * Failures reach the screen through the query string (the settings actions
 * pattern); Stripe error text never does, because it can quote request
 * details. The generic copy is honest about what did not happen.
 */

const PAGE = '/dashboard/settings/billing'

/** Where Stripe sends the browser back. Built from the request's own host so
 * preview deployments return to themselves. */
async function returnBase(): Promise<string> {
  const h = await headers()
  const origin = h.get('origin')
  if (origin) return origin
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? 'https'
  return `${proto}://${host}`
}

const GENERIC_CHECKOUT_FAILURE =
  'Checkout could not be started and nothing was charged. Try again in a moment; if it keeps failing, tell us on the Get Help page.'

export async function startCheckoutAction(formData: FormData): Promise<void> {
  const viewer = await getActiveOrgViewer()
  if (!viewer.isAdmin) redirect(PAGE)
  const { orgId: clerkOrgId } = await auth()
  if (!clerkOrgId) redirect('/select-org')

  let failure: string | null = null
  let checkoutUrl: string | null = null
  try {
    const selection = parseCheckoutSelection({
      plan: String(formData.get('plan') ?? ''),
      aiAddon: formData.get('ai_addon') === 'on',
      termsAccepted: formData.get('accept_terms') === 'on',
    })

    const entitlements = await getEntitlements(clerkOrgId)
    if (entitlements.plan !== 'free') {
      throw new CheckoutValidationError(
        'This organization already has a plan. Plan changes and cancellation live in Manage billing.',
      )
    }

    const db = createAdminClient()
    const orgUuid = await billingOrgUuid(db, clerkOrgId)
    if (!orgUuid) {
      // The Clerk webhook has not landed this org yet; a retry moments later
      // succeeds. Refusing beats checking out an org we cannot entitle.
      throw new CheckoutValidationError(
        'Your organization is still being set up. Try again in a moment.',
      )
    }

    // The legal gate, recorded BEFORE any Stripe session exists.
    await recordClickwrapAcceptance(db, orgUuid, TERMS_EFFECTIVE)

    const stripe = createStripeClient()
    const keys = lookupKeysForSelection(selection)
    const { data: prices } = await stripe.prices.list({ lookup_keys: keys, limit: 10 })
    const priceByKey = new Map(prices.map((p) => [p.lookup_key, p.id]))
    const lineItems = keys.map((key) => {
      const priceId = priceByKey.get(key)
      if (!priceId) throw new Error(`price missing for lookup key ${key}`)
      return { price: priceId, quantity: 1 }
    })

    const base = await returnBase()
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: lineItems,
      // The org id rides on the session AND the subscription so the webhook
      // can attribute either event shape (stripe-sync.ts).
      client_reference_id: clerkOrgId,
      metadata: { clerk_org_id: clerkOrgId },
      subscription_data: { metadata: { clerk_org_id: clerkOrgId } },
      // Reuse the org's customer if one exists (a canceled subscriber coming
      // back), so their invoice history stays in one place.
      ...(entitlements.stripeCustomerId
        ? { customer: entitlements.stripeCustomerId }
        : {}),
      success_url: `${base}${PAGE}?checkout=success`,
      cancel_url: `${base}${PAGE}?checkout=canceled`,
    })
    if (!session.url) throw new Error('checkout session has no url')
    checkoutUrl = session.url
  } catch (err) {
    if (err instanceof CheckoutValidationError) {
      failure = err.message
    } else {
      logError('billing.checkout.failed', 'failed', { error: errorName(err) })
      failure = GENERIC_CHECKOUT_FAILURE
    }
  }

  if (failure !== null) {
    redirect(`${PAGE}?${new URLSearchParams({ error: failure })}`)
  }
  redirect(checkoutUrl!)
}

export async function openPortalAction(): Promise<void> {
  const viewer = await getActiveOrgViewer()
  if (!viewer.isAdmin) redirect(PAGE)
  const { orgId: clerkOrgId } = await auth()
  if (!clerkOrgId) redirect('/select-org')

  let failure: string | null = null
  let portalUrl: string | null = null
  try {
    const entitlements = await getEntitlements(clerkOrgId)
    if (!entitlements.stripeCustomerId) {
      throw new CheckoutValidationError(
        'There is no billing account for this organization yet. Choosing a plan creates one.',
      )
    }
    const stripe = createStripeClient()
    const base = await returnBase()
    // The configuration is ours, in code (portal-config.ts): plan switching,
    // cancel at period end, invoices, card updates. Passing it explicitly
    // means the portal never depends on whatever the dashboard's default
    // happens to be.
    const configuration = await ensurePortalConfiguration(stripe)
    const session = await stripe.billingPortal.sessions.create({
      customer: entitlements.stripeCustomerId,
      configuration: configuration.id,
      return_url: `${base}${PAGE}`,
    })
    portalUrl = session.url
  } catch (err) {
    if (err instanceof CheckoutValidationError) {
      failure = err.message
    } else {
      logError('billing.portal.failed', 'failed', { error: errorName(err) })
      failure =
        'The billing portal could not be opened. Try again in a moment; if it keeps failing, tell us on the Get Help page.'
    }
  }

  if (failure !== null) {
    redirect(`${PAGE}?${new URLSearchParams({ error: failure })}`)
  }
  redirect(portalUrl!)
}

/**
 * Adds or removes the AI Chat add on on a Basic subscription, in app,
 * because Stripe's portal cannot manage a second subscription item. The
 * subscription is edited directly with prorations; the WEBHOOK remains the
 * entitlement writer (the edit fires customer.subscription.updated, and the
 * screen shows pending until it lands, the checkout pattern exactly).
 */
export async function setAiAddonAction(formData: FormData): Promise<void> {
  const viewer = await getActiveOrgViewer()
  if (!viewer.isAdmin) redirect(PAGE)
  const { orgId: clerkOrgId } = await auth()
  if (!clerkOrgId) redirect('/select-org')

  const enable = formData.get('addon') === 'enable'

  let failure: string | null = null
  try {
    const entitlements = await getEntitlements(clerkOrgId)
    if (entitlements.plan !== 'basic' || !entitlements.stripeSubscriptionId) {
      throw new CheckoutValidationError(
        'The AI Chat add on attaches to an active Basic plan. Pro and Business already include managed AI answers.',
      )
    }
    if (entitlements.status !== 'active') {
      throw new CheckoutValidationError(
        'Sort the payment state out under Manage billing first, then change the add on.',
      )
    }

    const stripe = createStripeClient()
    const sub = await stripe.subscriptions.retrieve(entitlements.stripeSubscriptionId)
    const change = aiAddonChange(
      sub.items.data.map((item) => ({ id: item.id, lookupKey: item.price.lookup_key })),
      enable,
    )

    if (change.op === 'add') {
      const { data: prices } = await stripe.prices.list({
        lookup_keys: [AI_ADDON_PRICE_LOOKUP_KEY],
        limit: 1,
      })
      const price = prices[0]
      if (!price) throw new Error('add on price missing; run npm run stripe:seed')
      await stripe.subscriptions.update(sub.id, {
        items: [{ price: price.id, quantity: 1 }],
        proration_behavior: 'create_prorations',
      })
    } else if (change.op === 'remove') {
      await stripe.subscriptions.update(sub.id, {
        items: [{ id: change.itemId, deleted: true }],
        proration_behavior: 'create_prorations',
      })
    }
    // noop falls through: the subscription already matches, and the screen
    // simply shows the state it is in.
  } catch (err) {
    if (err instanceof CheckoutValidationError) {
      failure = err.message
    } else {
      logError('billing.addon.failed', 'failed', { error: errorName(err) })
      failure =
        'The add on change did not go through and nothing was charged. Try again in a moment; if it keeps failing, tell us on the Get Help page.'
    }
  }

  if (failure !== null) {
    redirect(`${PAGE}?${new URLSearchParams({ error: failure })}`)
  }
  redirect(`${PAGE}?addon=${enable ? 'adding' : 'removing'}`)
}

/**
 * Schedules or unschedules cancellation at period end (the in app cancel
 * door). Reached only through the confirmation page, which has already said
 * what happens and when in real dates and dollars: the no single click moves
 * money rule covers stopping and restarting money alike. The WEBHOOK remains
 * the entitlement writer: this edit fires customer.subscription.updated,
 * which lands cancel_at_period_end in org_billing (migration 025), and the
 * screen shows pending until it does. Stripe's portal cancel writes the very
 * same flag through the very same webhook, so both doors read back
 * identically.
 */
export async function setCancelAtPeriodEndAction(formData: FormData): Promise<void> {
  const viewer = await getActiveOrgViewer()
  if (!viewer.isAdmin) redirect(PAGE)
  const { orgId: clerkOrgId } = await auth()
  if (!clerkOrgId) redirect('/select-org')

  const op = String(formData.get('ending') ?? '')
  let failure: string | null = null
  let done: 'scheduled' | 'resumed' | null = null
  try {
    if (op !== 'schedule' && op !== 'resume') {
      throw new CheckoutValidationError('That is not a change this page can make.')
    }
    const entitlements = await getEntitlements(clerkOrgId)
    if (entitlements.plan === 'free' || !entitlements.stripeSubscriptionId) {
      throw new CheckoutValidationError(
        'There is no subscription on this organization to change.',
      )
    }
    const stripe = createStripeClient()
    await stripe.subscriptions.update(entitlements.stripeSubscriptionId, {
      cancel_at_period_end: op === 'schedule',
    })
    done = op === 'schedule' ? 'scheduled' : 'resumed'
  } catch (err) {
    if (err instanceof CheckoutValidationError) {
      failure = err.message
    } else {
      logError('billing.cancel.failed', 'failed', { error: errorName(err) })
      failure =
        'The change could not be made and nothing about your plan moved. Try again in a moment; if it keeps failing, tell us on the Get Help page.'
    }
  }

  if (failure !== null) {
    redirect(`${PAGE}?${new URLSearchParams({ error: failure })}`)
  }
  redirect(`${PAGE}?ending=${done}`)
}
