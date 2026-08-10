import { auth } from '@clerk/nextjs/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { requireAdmin } from '@/lib/auth/org-viewer'
import { formatUsd } from '@/lib/billing/checkout-rules'
import { getEntitlements } from '@/lib/billing/entitlements'

import { formatUtc, ghostButton, primaryButton } from '../../../monitors/ui'
import { setCancelAtPeriodEndAction } from '../actions'
import { ADDON_DOLLARS, PLAN_DOLLARS, PLAN_NAMES } from '../ui'

export const metadata = { title: 'Cancel subscription — Talvext' }

const PAGE = '/dashboard/settings/billing'

/**
 * The cancellation confirmation (the in app cancel door), and its mirror for
 * keeping the plan after a scheduled cancellation. The release address idiom
 * again: one page, fully server side, the numbers and dates said plainly
 * before the button that commits. Cancellation here means AT PERIOD END,
 * Stripe's kindest shape: everything works until the date already paid for,
 * nothing more is charged, nothing is deleted. The webhook writes the state
 * back (migration 025), so the billing screen shows the scheduled ending
 * whichever door scheduled it.
 */
export default async function CancelSubscriptionPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  await requireAdmin()
  const { orgId } = await auth()
  if (!orgId) redirect('/select-org')

  const params = await searchParams
  const op = typeof params.op === 'string' ? params.op : ''
  if (op !== 'cancel' && op !== 'resume') redirect(PAGE)
  const canceling = op === 'cancel'

  const entitlements = await getEntitlements(orgId)
  // Every moot state goes back to the screen that explains it: no
  // subscription, or the schedule already where the link wanted it.
  if (
    entitlements.plan === 'free' ||
    !entitlements.stripeSubscriptionId ||
    entitlements.cancelAtPeriodEnd === canceling
  ) {
    redirect(PAGE)
  }

  const plan = entitlements.plan as 'basic' | 'pro' | 'business'
  const monthlyCents =
    (PLAN_DOLLARS[plan] + (entitlements.aiAddon ? ADDON_DOLLARS : 0)) * 100
  const periodEnd = entitlements.currentPeriodEnd
    ? formatUtc(entitlements.currentPeriodEnd)
    : null

  return (
    <main id="main-content" className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex max-w-md flex-col gap-4 rounded-button border border-border bg-card p-6">
        <h1 className="text-title text-card-foreground">
          {canceling
            ? `Cancel your ${PLAN_NAMES[plan]} subscription?`
            : `Keep your ${PLAN_NAMES[plan]} subscription?`}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {canceling
            ? `Everything keeps working until the period you have already paid for ends${periodEnd ? ` on ${periodEnd}` : ''}. After that this organization moves to the Free tier and nothing more is charged. Nothing is deleted: monitors past the Free limit pause rather than vanish, your data stays, and incident alerts keep running on every tier, forever.`
            : 'Your subscription continues uninterrupted, exactly as it was before the cancellation was scheduled.'}
        </p>

        <dl className="rounded-button border border-divider bg-background/40 px-4 py-1">
          {periodEnd ? (
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-[12.5px] text-quiet">
                {canceling ? 'Access until' : 'Next invoice'}
              </dt>
              <dd className="text-[15px] font-semibold text-card-foreground tabular-nums">
                {periodEnd}
              </dd>
            </div>
          ) : null}
          <div
            className={`flex items-baseline justify-between gap-4 py-2.5 ${periodEnd ? 'border-t border-divider' : ''}`}
          >
            <dt className="text-[12.5px] text-quiet">
              {canceling ? 'Charged after that' : 'Each month'}
            </dt>
            <dd className="text-[15px] font-semibold text-card-foreground tabular-nums">
              {canceling ? formatUsd(0) : formatUsd(monthlyCents)}
            </dd>
          </div>
        </dl>

        <form action={setCancelAtPeriodEndAction} className="flex items-center gap-3">
          <input type="hidden" name="ending" value={canceling ? 'schedule' : 'resume'} />
          <button type="submit" className={primaryButton}>
            {canceling ? 'Cancel at period end' : `Keep it: ${formatUsd(monthlyCents)} a month`}
          </button>
          <Link href={PAGE} className={ghostButton}>
            {canceling ? 'Keep my plan' : 'Back'}
          </Link>
        </form>
      </div>
    </main>
  )
}
