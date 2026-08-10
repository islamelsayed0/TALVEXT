/**
 * Seeds the Stripe TEST catalog for Talvext billing (BRD F13): four products,
 * four monthly prices, each price carrying the lookup key that
 * src/lib/db/stripe-sync.ts maps back to a plan. Run it against an empty
 * Stripe test account and the catalog exists; run it again and it reports
 * what is already there. The same philosophy as migrations: the checked in
 * script is the source of truth and the dashboard is never hand edited into
 * a state this file cannot reproduce.
 *
 *   npm run stripe:seed            (test mode, the default)
 *   npm run stripe:seed -- --live  (live mode, deliberate and loud)
 *
 * Reads STRIPE_SECRET_KEY from .env.local (via node --env-file-if-exists) or
 * the shell. Test keys are the default and the safe path. A live key is
 * refused UNLESS the --live flag states the intent explicitly, and the flag
 * is refused unless the key is actually live: the flag and the key must
 * agree, so neither a pasted wrong key nor a habitual command can touch the
 * wrong account. The live gates (docs/DECISIONS.md 2026-08-07: clickwrap
 * shipped, the TALVEXT statement descriptor set, the operator go ahead) are
 * process, not code; passing --live is the operator asserting they have
 * passed.
 *
 * What is deliberately NOT here: the Free tier (no money, no Stripe object),
 * the Custom tier (a mailto, no price shown), annual prices, coupons,
 * trials, tax configuration, and the statement descriptor (TALVEXT is set in
 * the dashboard by a human; it is one of the live gates). Prices in Stripe
 * are immutable, so a future price change is a NEW price and a lookup key
 * transfer, recorded here first.
 */

import Stripe from 'stripe'

import { ensurePortalConfiguration } from '../src/lib/billing/portal-config'

type CatalogEntry = {
  lookupKey: string
  productName: string
  productDescription: string
  unitAmount: number
}

// The frozen pricing, docs/DECISIONS.md 2026-08-07. Descriptions are
// customer visible in Stripe surfaces (Checkout, the customer portal,
// receipts), so they follow the copy rules: short, human, no hyphens, staff
// counts are marketing language and never enforced, and the word MSP does
// not appear.
const CATALOG: CatalogEntry[] = [
  {
    lookupKey: 'talvext_basic_monthly',
    productName: 'Talvext Basic',
    productDescription:
      'For offices up to around 20 staff. 15 monitors, status page, daily digest, SSL expiry warnings, maintenance windows.',
    unitAmount: 3900,
  },
  {
    lookupKey: 'talvext_pro_monthly',
    productName: 'Talvext Pro',
    productDescription:
      'Everything unlimited, plus 300 managed AI answers per month included.',
    unitAmount: 7900,
  },
  {
    lookupKey: 'talvext_business_monthly',
    productName: 'Talvext Business',
    productDescription:
      'Everything in Pro for up to 10 organizations. Manage every client or location from one account.',
    unitAmount: 19900,
  },
  {
    lookupKey: 'talvext_ai_addon_monthly',
    productName: 'Talvext AI Chat Add On',
    productDescription: '300 managed AI answers per month, added to the Basic plan.',
    unitAmount: 1500,
  },
]

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key || !key.trim()) {
    console.error(
      'STRIPE_SECRET_KEY is not set. Put a restricted TEST key in .env.local; see .env.example.',
    )
    process.exit(1)
  }
  const liveKey = /^(sk|rk)_live_/.test(key)
  const testKey = /^(sk|rk)_test_/.test(key)
  const liveFlag = process.argv.includes('--live')
  if (!liveKey && !testKey) {
    console.error('STRIPE_SECRET_KEY is neither a test nor a live secret key.')
    process.exit(1)
  }
  if (liveKey && !liveFlag) {
    console.error(
      'Refusing to run: STRIPE_SECRET_KEY is a live key and --live was not ' +
        'passed. Live mode is a human switch behind the gates recorded in ' +
        'docs/DECISIONS.md (2026-08-07); if they have passed, state the ' +
        'intent explicitly: npm run stripe:seed -- --live',
    )
    process.exit(1)
  }
  if (testKey && liveFlag) {
    console.error(
      'Refusing to run: --live was passed but STRIPE_SECRET_KEY is a test ' +
        'key. The flag and the key must agree; check which key .env.local ' +
        'holds.',
    )
    process.exit(1)
  }
  if (liveKey) {
    console.log(
      'LIVE MODE: creating real products and prices on the live Stripe ' +
        'account. Customers will be able to buy these.',
    )
  }

  const stripe = new Stripe(key)

  const { data: existing } = await stripe.prices.list({
    lookup_keys: CATALOG.map((entry) => entry.lookupKey),
    limit: 100,
  })
  const existingByKey = new Map(existing.map((price) => [price.lookup_key, price]))

  for (const entry of CATALOG) {
    const found = existingByKey.get(entry.lookupKey)
    if (found) {
      const amountMatches =
        found.unit_amount === entry.unitAmount &&
        found.currency === 'usd' &&
        found.recurring?.interval === 'month'
      console.log(
        `${entry.lookupKey}: exists (${found.id})` +
          (amountMatches
            ? ''
            : ' MISMATCH: the live catalog disagrees with this file. Prices are immutable; create a replacement price and move the lookup key, in this script first.'),
      )
      continue
    }

    const product = await stripe.products.create({
      name: entry.productName,
      description: entry.productDescription,
      metadata: { talvext_lookup_key: entry.lookupKey },
    })
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: entry.unitAmount,
      recurring: { interval: 'month' },
      lookup_key: entry.lookupKey,
      // If the key ever ends up on an orphaned price, transfer it here
      // rather than failing on the unique constraint.
      transfer_lookup_key: true,
    })
    console.log(
      `${entry.lookupKey}: created product ${product.id}, price ${price.id}, ` +
        `$${(entry.unitAmount / 100).toFixed(2)}/month`,
    )
  }

  // The customer portal configuration, same philosophy as the catalog: in
  // code, reproducible from zero. The portal action self heals too, so this
  // is belt and braces; running it here means the first subscriber never
  // pays the creation latency.
  const portal = await ensurePortalConfiguration(stripe)
  console.log(`Portal configuration: ${portal.id}`)

  console.log(
    liveKey
      ? 'Catalog check complete against the LIVE account.'
      : 'Catalog check complete. Test mode; nothing here touched live.',
  )
}

main().catch((err: unknown) => {
  // Stripe errors can quote request details; the message is enough to act on
  // and the key can never appear in it.
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown failure')
  process.exit(1)
})
