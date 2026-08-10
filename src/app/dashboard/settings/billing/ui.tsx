/**
 * Shared visual atoms for the billing surfaces (F13 design pass).
 *
 * The money mark is the one deliberate signature: everywhere a price
 * appears, on the tier cards, the current plan, the add on, and the confirm
 * page's mini invoice, it is set the same way, a small raised dollar mark, a
 * large tabular numeral in the KPI voice the overview already speaks, and a
 * quiet "a month". Money is the whole subject of these screens, so money is
 * what the typography anchors on; everything else stays in the settings
 * register.
 *
 * The eyebrow borrows the landing page's mono label device, the one place
 * the product already whispers in small caps. Nothing here introduces a new
 * color or motion.
 */

import type { BillingPlan } from '@/lib/billing/entitlements'

export const PLAN_NAMES: Record<BillingPlan, string> = {
  free: 'Free',
  basic: 'Basic',
  pro: 'Pro',
  business: 'Business',
}

/** Display prices, the frozen pricing's numbers as numbers. */
export const PLAN_DOLLARS: Record<'basic' | 'pro' | 'business', number> = {
  basic: 39,
  pro: 79,
  business: 199,
}

export const ADDON_DOLLARS = 15

const PRICE_SIZES = {
  lg: { dollar: 'text-[14px]', amount: 'text-[28px]' },
  md: { dollar: 'text-[12px]', amount: 'text-[20px]' },
} as const

export function PriceMark({
  dollars,
  per = 'a month',
  size = 'lg',
}: {
  dollars: number
  per?: string | null
  size?: keyof typeof PRICE_SIZES
}) {
  const s = PRICE_SIZES[size]
  return (
    <span className="whitespace-nowrap">
      <span className={`${s.dollar} align-top font-medium leading-none text-quiet`}>$</span>
      <span
        className={`${s.amount} font-semibold leading-none tracking-[-0.02em] text-foreground tabular-nums`}
      >
        {dollars}
      </span>
      {per ? <span className="text-[12.5px] text-quiet"> {per}</span> : null}
    </span>
  )
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[11px] font-medium tracking-[0.08em] text-quiet uppercase">
      {children}
    </p>
  )
}
