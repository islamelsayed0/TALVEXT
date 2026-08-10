import 'server-only'

import Stripe from 'stripe'

/**
 * The Stripe client cannot be built because its env var is missing. A
 * deployment configuration problem, not a user error: thrown so callers can
 * tell it apart from a real failure and say so honestly (the admin.ts
 * AdminConfigError pattern).
 */
export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StripeConfigError'
  }
}

/**
 * Server side Stripe client. The key is STRIPE_SECRET_KEY, server only, no
 * NEXT_PUBLIC_ prefix, so it cannot reach the browser (CLAUDE.md security
 * rules 1 and 4). Everything in this repo runs against Stripe TEST MODE; the
 * live switch is a human decision behind the recorded gates in
 * docs/DECISIONS.md 2026-08-07, made by swapping the environment values, not
 * by editing code.
 *
 * The API version is the one this SDK release pins, on purpose: the SDK's
 * types and the wire format stay in lockstep, and upgrading the SDK is the
 * one deliberate act that moves both.
 */
/**
 * Whether billing is running against Stripe test mode, derived from the key
 * actually in use, never from a separate flag that could drift from it. An
 * absent key counts as test mode: nothing can be charged at all, so the
 * screen's no real charge sentence stays true. Used by the billing screen to
 * decide whether to say so; the moment a live key lands in the environment,
 * the claim disappears on its own.
 */
export function stripeIsTestMode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY
  return !key || !/^(sk|rk)_live_/.test(key)
}

export function createStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key || !key.trim()) {
    throw new StripeConfigError(
      'STRIPE_SECRET_KEY is not set. It lives in .env.local and in Vercel ' +
        'env vars, never in the repo. See .env.example.',
    )
  }
  return new Stripe(key)
}
