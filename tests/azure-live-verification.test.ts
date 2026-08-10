import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { acquireAzureToken, queryDailyCosts } from '@/lib/azure/cost-client'
import { azurePullRange, rollupDailyCosts } from '@/lib/azure/costs'

// LIVE MODE verification for the Azure cost pull (BRD F23 PR 1). This file
// runs ONLY when the TEST_AZURE_* variables are present (in the environment
// or in .env.local, which is gitignored); everywhere else, CI included, it
// reports as skipped, because CI holds no cloud credential on purpose.
//
// This is deliberately not a fixture test and not part of the isolation
// suite. The fixture tests in tests/azure-costs.test.ts imitate Cost
// Management's answer shape; this one proves the real thing: the service
// principal signs in, the query returns actual spend, and the rollup shaping
// holds against data we did not invent. The standing rule for the feature is
// that an empty answer proves nothing, so the pull must find real cost rows;
// a zero row run FAILS here rather than passing vacuously.
//
// The secret never appears in output: assertions carry counts and day keys,
// never credential material.

function envOrLocal(name: string): string | null {
  const fromEnv = process.env[name]?.trim()
  if (fromEnv) return fromEnv
  try {
    const local = readFileSync('.env.local', 'utf8')
    const match = local.match(new RegExp(`^${name}=(.*)$`, 'm'))
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

const live = {
  subscriptionId: envOrLocal('TEST_AZURE_SUBSCRIPTION_ID'),
  tenantId: envOrLocal('TEST_AZURE_TENANT_ID'),
  clientId: envOrLocal('TEST_AZURE_CLIENT_ID'),
  clientSecret: envOrLocal('TEST_AZURE_CLIENT_SECRET'),
}
const configured = Boolean(
  live.subscriptionId && live.tenantId && live.clientId && live.clientSecret,
)

describe.skipIf(!configured)('live Azure pull against the real subscription', () => {
  it(
    'signs in as the service principal and pulls real daily costs',
    async () => {
      const token = await acquireAzureToken({
        tenantId: live.tenantId!,
        clientId: live.clientId!,
        clientSecret: live.clientSecret!,
      })
      expect(token.length).toBeGreaterThan(0)

      const range = azurePullRange(Date.now())
      const entries = await queryDailyCosts({
        subscriptionId: live.subscriptionId!,
        accessToken: token,
        from: range.from,
        to: range.to,
      })

      // The empty-proves-nothing rule: this subscription must carry real
      // spend. If this fails, the demo resource is missing or Cost
      // Management has not caught up with it yet (it lags by hours to a
      // couple of days).
      expect(
        entries.length,
        'no cost rows: create the demo resource and give Azure a day to meter it',
      ).toBeGreaterThan(0)

      const rollups = rollupDailyCosts(entries)
      expect(rollups.length).toBeGreaterThan(0)
      for (const rollup of rollups) {
        expect(rollup.day >= range.from && rollup.day <= range.to).toBe(true)
        expect(rollup.currency.length).toBeGreaterThanOrEqual(3)
        expect(Number.isFinite(rollup.total_cost)).toBe(true)
      }
      // One billing currency per subscription.
      expect(new Set(rollups.map((r) => r.currency)).size).toBe(1)
    },
    60_000,
  )
})
