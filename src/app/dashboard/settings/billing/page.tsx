import { auth } from '@clerk/nextjs/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { requireAdmin } from '@/lib/auth/org-viewer'
import {
  getEntitlements,
  type BillingPlan,
  type Entitlements,
} from '@/lib/billing/entitlements'
import { stripeIsTestMode } from '@/lib/billing/stripe'
import { StatusText } from '@/components/status-mark'

import { Card } from '../../_overview/ui'
import { formatUtc, ghostButton, primaryButton } from '../../monitors/ui'
import { FormError } from '../../tickets/ui'
import { SettingsNav } from '../nav'
import { openPortalAction, startCheckoutAction } from './actions'
import { PendingRefresh } from './pending-refresh'
import { ADDON_DOLLARS, Eyebrow, PLAN_DOLLARS, PLAN_NAMES, PriceMark } from './ui'

export const metadata = { title: 'Settings — Talvext' }

/**
 * The billing screen (F13 PR 2). Admin gated like every settings tab; the
 * page renders what the RESOLVER says, never what a redirect claimed: after
 * a successful checkout the entitlement state is whatever the webhook has
 * written, and until it lands the screen says pending and refreshes itself.
 *
 * Deliberately absent: card fields (Stripe hosts every payment surface),
 * plan change buttons for subscribers (the Stripe portal owns changes and
 * cancellation), and any owner only distinction. Billing is admin gated for
 * v1; owner activation is recorded as deferred in docs/DECISIONS.md
 * 2026-08-07 (PR 2 note).
 */

/** What each plan includes, the frozen pricing said out loud. */
const PLAN_INCLUDES: Record<BillingPlan, string[]> = {
  free: ['1 organization', '2 monitors', 'Tickets and incident alerts', 'BYOK AI chat'],
  basic: [
    '1 organization',
    '15 monitors',
    'Status page',
    'Daily digest',
    'SSL expiry warnings',
    'Maintenance windows',
  ],
  pro: [
    '1 organization',
    'Unlimited monitors',
    'Documents with audience targeting, inventory, audit log',
    '300 managed AI answers a month',
  ],
  business: [
    'Up to 10 organizations',
    'Everything in Pro',
    'Manage every client or location from one account',
  ],
}

const TIER_CARDS: Array<{
  plan: 'basic' | 'pro' | 'business'
  blurb: string
  features: string[]
}> = [
  {
    plan: 'basic',
    blurb: 'For offices up to around 20 staff.',
    features: [
      '15 monitors',
      'Status page and daily digest',
      'SSL expiry warnings',
      'Maintenance windows',
    ],
  },
  {
    plan: 'pro',
    blurb: 'The whole platform, no limits.',
    features: [
      'Unlimited monitors',
      'Documents, inventory, audit log',
      '300 managed AI answers a month',
    ],
  },
  {
    plan: 'business',
    blurb: 'Every client or location, one account.',
    features: [
      'Up to 10 organizations',
      'Everything in Pro',
      'AI answers included',
    ],
  },
]

function planStatus(entitlements: Entitlements) {
  if (entitlements.status === 'past_due') {
    return <StatusText tone="down" label="Payment past due" />
  }
  if (entitlements.status === 'canceled') {
    return <StatusText tone="paused" label="Subscription ended" />
  }
  if (entitlements.cancelAtPeriodEnd && entitlements.plan !== 'free') {
    return <StatusText tone="paused" label="Ending" />
  }
  if (entitlements.plan !== 'free') {
    return <StatusText tone="up" label="Active" />
  }
  return null
}

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  await requireAdmin()
  const { orgId } = await auth()
  if (!orgId) redirect('/select-org')

  const params = await searchParams
  const error = typeof params.error === 'string' ? params.error : undefined
  const checkout = typeof params.checkout === 'string' ? params.checkout : undefined
  const addon = typeof params.addon === 'string' ? params.addon : undefined

  const entitlements = await getEntitlements(orgId)
  const onPaidPlan = entitlements.plan !== 'free'
  // Success redirect but the webhook has not written entitlements yet: the
  // redirect is not trusted, the database is. Show pending and poll briefly.
  const awaitingWebhook = checkout === 'success' && !onPaidPlan
  // Same rule for the add on toggle: the redirect said what was REQUESTED,
  // the row says what is true, and pending is the honest word in between.
  const awaitingAddon =
    (addon === 'adding' && !entitlements.aiAddon) ||
    (addon === 'removing' && entitlements.aiAddon)
  // And for the cancellation schedule, the same honesty: the flag in the row
  // is the truth, the redirect only says what was asked for.
  const ending = typeof params.ending === 'string' ? params.ending : undefined
  const awaitingEnding =
    (ending === 'scheduled' && !entitlements.cancelAtPeriodEnd) ||
    (ending === 'resumed' && entitlements.cancelAtPeriodEnd)
  const endingSettled =
    (ending === 'scheduled' || ending === 'resumed') && !awaitingEnding
  const addonSettled =
    (addon === 'adding' && entitlements.aiAddon) ||
    (addon === 'removing' && !entitlements.aiAddon)

  return (
    <main
      id="main-content"
      className="mx-auto w-full max-w-[780px] flex-1 animate-fade-up px-8 pt-[30px] pb-[72px]"
    >
      <div className="mb-[22px]">
        <h1 className="text-title text-foreground">Settings</h1>
        <p className="mt-1.5 text-[14px] text-quiet">
          Manage your workspace, team and integrations.
        </p>
      </div>

      <SettingsNav />

      {error ? (
        <div className="mb-[18px]">
          <FormError message={error} />
        </div>
      ) : null}

      {checkout === 'canceled' ? (
        <Card className="mb-[18px] px-[22px] py-4">
          <p className="text-sm text-foreground">
            Checkout was canceled. Nothing changed and nothing was charged.
          </p>
        </Card>
      ) : null}

      {checkout === 'success' && onPaidPlan ? (
        <Card className="mb-[18px] px-[22px] py-4">
          <p className="text-sm text-foreground">
            Your {PLAN_NAMES[entitlements.plan]} plan is active. Thank you.
          </p>
        </Card>
      ) : null}

      {awaitingWebhook ? (
        <Card className="mb-[18px] px-[22px] py-4">
          <StatusText tone="pending" label="Confirming your subscription" />
          <p className="mt-1.5 text-[12.5px] text-quiet">
            Payment went through and Stripe is confirming it to us now. This
            page checks again every few seconds; the plan appears the moment
            the confirmation lands.
          </p>
          <PendingRefresh />
        </Card>
      ) : null}

      <Card className="px-[22px] py-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Eyebrow>Current plan</Eyebrow>
            <h2 className="mt-1.5 text-title text-foreground">
              {PLAN_NAMES[entitlements.plan]}
            </h2>
            {onPaidPlan && entitlements.plan !== 'free' ? (
              <div className="mt-2">
                <PriceMark
                  dollars={
                    PLAN_DOLLARS[entitlements.plan as 'basic' | 'pro' | 'business'] +
                    (entitlements.aiAddon ? ADDON_DOLLARS : 0)
                  }
                  size="md"
                />
              </div>
            ) : null}
          </div>
          {planStatus(entitlements)}
        </div>
        <ul className="mt-4 grid gap-x-8 gap-y-1.5 border-t border-divider pt-3.5 sm:grid-cols-2">
          {PLAN_INCLUDES[entitlements.plan].map((line) => (
            <li key={line} className="text-[13px] text-foreground">
              {line}
            </li>
          ))}
          {entitlements.aiAddon ? (
            <li className="text-[13px] text-foreground">
              AI Chat add on: 300 managed AI answers a month
            </li>
          ) : null}
        </ul>
        {entitlements.currentPeriodEnd && entitlements.status === 'active' ? (
          <p className="mt-3.5 border-t border-divider pt-3 text-[12.5px] text-quiet">
            {entitlements.cancelAtPeriodEnd
              ? `Ends ${formatUtc(entitlements.currentPeriodEnd)}; nothing more will be charged.`
              : `Renews ${formatUtc(entitlements.currentPeriodEnd)}.`}
          </p>
        ) : null}
      </Card>

      {entitlements.cancelAtPeriodEnd && onPaidPlan ? (
        <Card className="mt-[18px] px-[22px] py-4">
          <p className="text-sm text-foreground">
            Your subscription is scheduled to end
            {entitlements.currentPeriodEnd
              ? ` on ${formatUtc(entitlements.currentPeriodEnd)}`
              : ''}
            . Everything keeps working until then, and this organization then
            moves to the Free tier. Changed your mind?{' '}
            <Link
              href="/dashboard/settings/billing/cancel?op=resume"
              className="text-link underline hover:text-foreground"
            >
              Keep your subscription
            </Link>
            .
          </p>
        </Card>
      ) : null}

      {entitlements.status === 'past_due' ? (
        <Card className="mt-[18px] px-[22px] py-4">
          <p className="text-sm text-foreground">
            Your last payment did not go through. Stripe retries the card
            automatically, and you can update it under Manage billing. Nothing
            has been turned off.
          </p>
        </Card>
      ) : null}

      {entitlements.status === 'canceled' ? (
        <Card className="mt-[18px] px-[22px] py-4">
          <p className="text-sm text-foreground">
            Your subscription ended and this organization is on the Free tier.
            Choosing a plan below picks up the same billing account, so your
            invoice history stays in one place.
          </p>
        </Card>
      ) : null}

      {awaitingAddon ? (
        <Card className="mt-[18px] px-[22px] py-4">
          <StatusText
            tone="pending"
            label={addon === 'adding' ? 'Adding the AI Chat add on' : 'Removing the AI Chat add on'}
          />
          <p className="mt-1.5 text-[12.5px] text-quiet">
            Stripe is confirming the change to us now. This page checks again
            every few seconds.
          </p>
          <PendingRefresh />
        </Card>
      ) : null}

      {addonSettled ? (
        <Card className="mt-[18px] px-[22px] py-4">
          <p className="text-sm text-foreground">
            {addon === 'adding'
              ? 'The AI Chat add on is active: 300 managed AI answers a month.'
              : 'The AI Chat add on is removed. BYOK chat keeps working as always.'}
          </p>
        </Card>
      ) : null}

      {awaitingEnding ? (
        <Card className="mt-[18px] px-[22px] py-4">
          <StatusText
            tone="pending"
            label={
              ending === 'scheduled'
                ? 'Scheduling the cancellation'
                : 'Resuming your subscription'
            }
          />
          <p className="mt-1.5 text-[12.5px] text-quiet">
            Stripe is confirming the change to us now. This page checks again
            every few seconds.
          </p>
          <PendingRefresh />
        </Card>
      ) : null}

      {endingSettled ? (
        <Card className="mt-[18px] px-[22px] py-4">
          <p className="text-sm text-foreground">
            {ending === 'scheduled'
              ? 'Your cancellation is scheduled. Everything keeps working until the period ends, and nothing more will be charged.'
              : 'Your subscription continues, exactly as before.'}
          </p>
        </Card>
      ) : null}

      {entitlements.plan === 'basic' &&
      entitlements.status === 'active' &&
      !awaitingAddon ? (
        <Card className="mt-[18px] px-[22px] py-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">AI Chat add on</h2>
            <PriceMark dollars={ADDON_DOLLARS} size="md" />
          </div>
          <p className="mt-1 text-[12.5px] text-quiet">
            {entitlements.aiAddon
              ? 'Active: 300 managed AI answers a month, $15 a month. Removing it credits the unused time on your next invoice.'
              : '300 managed AI answers a month for $15 a month. BYOK chat stays free either way.'}
          </p>
          {/* A link, deliberately not a submit: nothing on this screen moves
              money. The confirm page shows the real numbers first. */}
          <Link
            href={`/dashboard/settings/billing/addon?op=${entitlements.aiAddon ? 'remove' : 'add'}`}
            className={`${ghostButton} mt-3`}
          >
            {entitlements.aiAddon ? 'Remove the add on' : 'Add AI Chat'}
          </Link>
        </Card>
      ) : null}

      {!onPaidPlan && !awaitingWebhook ? (
        <Card className="mt-[18px] px-[22px] py-5">
          <h2 className="text-base font-semibold text-foreground">Upgrade</h2>
          <p className="mt-1 text-[12.5px] text-quiet">
            Incident alerts are included on every tier, always. Seats are never
            counted or charged for.
          </p>

          <form action={startCheckoutAction}>
            {/* The clickwrap gate, rendered as one: a bordered row the eye
                must pass before any tier button, matching its place in the
                tab order. */}
            <label className="mt-4 flex items-start gap-2.5 rounded-button border border-card-border bg-background/40 px-3.5 py-3 text-sm text-foreground">
              <input
                name="accept_terms"
                type="checkbox"
                required
                className="mt-0.5 h-4 w-4 accent-(--status-up)"
              />
              <span>
                I agree to the{' '}
                <a href="/terms" className="text-link underline hover:text-foreground">
                  Terms of Service
                </a>{' '}
                and{' '}
                <a href="/privacy" className="text-link underline hover:text-foreground">
                  Privacy Policy
                </a>
                .
              </span>
            </label>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {TIER_CARDS.map((tier) => (
                <div
                  key={tier.plan}
                  className="flex flex-col rounded-card border border-card-border bg-background/30 p-4 transition-colors hover:border-(--ghost-border-hover)"
                >
                  <Eyebrow>{PLAN_NAMES[tier.plan]}</Eyebrow>
                  <div className="mt-2.5">
                    <PriceMark dollars={PLAN_DOLLARS[tier.plan]} />
                  </div>
                  <p className="mt-1.5 text-[12.5px] text-quiet">{tier.blurb}</p>
                  <ul className="mt-3 flex-1 space-y-1.5 border-t border-divider pt-3">
                    {tier.features.map((feature) => (
                      <li key={feature} className="text-[12.5px] text-foreground">
                        {feature}
                      </li>
                    ))}
                  </ul>
                  {tier.plan === 'basic' ? (
                    <label className="mt-3 flex items-start gap-2 border-t border-divider pt-3 text-[12.5px] text-foreground">
                      <input
                        name="ai_addon"
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 accent-(--status-up)"
                      />
                      Add AI Chat: 300 managed answers a month, $15 a month
                    </label>
                  ) : null}
                  <button
                    type="submit"
                    name="plan"
                    value={tier.plan}
                    className={`${ghostButton} mt-3.5`}
                  >
                    Choose {PLAN_NAMES[tier.plan]}
                  </button>
                </div>
              ))}
            </div>

          </form>

          <p className="mt-4 border-t border-divider pt-3 text-[12.5px] text-quiet">
            Need more than ten organizations, or something custom?{' '}
            <a
              href="mailto:islamelsayed02@gmail.com"
              className="text-link underline hover:text-foreground"
            >
              Contact us
            </a>
            .
          </p>
        </Card>
      ) : null}

      {entitlements.stripeCustomerId ? (
        <Card className="mt-[18px] px-[22px] py-5">
          <h2 className="text-base font-semibold text-foreground">Manage billing</h2>
          <p className="mt-1 text-[12.5px] text-quiet">
            Payment method, invoices, plan changes and cancellation all happen
            in the Stripe billing portal. No card details ever touch Talvext.
            {entitlements.aiAddon
              ? ' To switch plans, remove the AI Chat add on first; the portal cannot change a plan while the add on is attached.'
              : ''}
          </p>
          <form action={openPortalAction} className="mt-3">
            <button type="submit" className={primaryButton}>
              Manage billing
            </button>
          </form>
          {onPaidPlan && !entitlements.cancelAtPeriodEnd ? (
            <p className="mt-3 border-t border-divider pt-3 text-[12.5px] text-quiet">
              Done with the plan?{' '}
              <Link
                href="/dashboard/settings/billing/cancel?op=cancel"
                className="text-link underline hover:text-foreground"
              >
                Cancel your subscription
              </Link>{' '}
              — access continues to the end of the period you paid for, and
              nothing more is charged.
            </p>
          ) : null}
        </Card>
      ) : null}

      <p className="mt-[18px] text-[12px] text-quiet">
        {stripeIsTestMode()
          ? 'Billing runs in Stripe test mode while Talvext is prelaunch; no real card is ever charged. '
          : ''}
        BYOK chat stays free on every tier and is never capped.
      </p>
    </main>
  )
}
