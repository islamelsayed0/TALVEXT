import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acquireAzureToken,
  AzureApiError,
  queryDailyCosts,
} from '@/lib/azure/cost-client'
import {
  AZURE_TOP_SERVICES_LIMIT,
  azurePullDue,
  azurePullRange,
  parseCostQueryPage,
  rollupDailyCosts,
} from '@/lib/azure/costs'

// Unit tests for the Azure cost pull path (BRD F23): the pure due check,
// window, parsing, and rollup shaping, plus the HTTP client's failure paths
// against a stubbed global fetch. Everything here is FIXTURE tested: the
// payloads imitate Cost Management's columnar answer. The happy path against
// a real subscription is proven by the verification run recorded in the PR,
// not here; no real credential or endpoint is touched in this file.
//
// Deliberately not covered here: the sweep sub-job's wiring (service role
// writes, stamps), which the isolation suite and the real verification cover.

const CREDENTIAL = {
  tenantId: '22222222-aaaa-4222-8222-222222222222',
  clientId: '33333333-aaaa-4333-8333-333333333333',
  clientSecret: 'FAKE-AZURE-SECRET-unit-test', // gitleaks:allow
}

describe('azurePullDue: one attempt per subscription per UTC day', () => {
  it('never pulled is due', () => {
    expect(azurePullDue(null, Date.parse('2026-08-10T12:00:00Z'))).toBe(true)
  })

  it('already attempted today (UTC) is not due, success or failure alike', () => {
    expect(
      azurePullDue('2026-08-10T00:05:00Z', Date.parse('2026-08-10T23:59:00Z')),
    ).toBe(false)
  })

  it('yesterday is due again, even one minute across the UTC boundary', () => {
    expect(
      azurePullDue('2026-08-09T23:59:00Z', Date.parse('2026-08-10T00:01:00Z')),
    ).toBe(true)
  })

  it('an unparseable stamp is due rather than stuck forever', () => {
    expect(azurePullDue('not a date', Date.parse('2026-08-10T12:00:00Z'))).toBe(true)
  })
})

describe('azurePullRange: first of previous UTC month through today', () => {
  it('mid month covers the whole previous month', () => {
    expect(azurePullRange(Date.parse('2026-08-10T15:00:00Z'))).toEqual({
      from: '2026-07-01',
      to: '2026-08-10',
    })
  })

  it('january reaches back into the previous year', () => {
    expect(azurePullRange(Date.parse('2026-01-03T09:00:00Z'))).toEqual({
      from: '2025-12-01',
      to: '2026-01-03',
    })
  })
})

/** A Cost Management answer page, in the API's columnar shape (fixture). */
function fixturePage(
  rows: Array<[number, number, string, string]>,
  costColumn: 'Cost' | 'PreTaxCost' = 'Cost',
) {
  return {
    properties: {
      columns: [
        { name: costColumn, type: 'Number' },
        { name: 'UsageDate', type: 'Number' },
        { name: 'ServiceName', type: 'String' },
        { name: 'Currency', type: 'String' },
      ],
      rows,
    },
  }
}

describe('parseCostQueryPage: the columnar answer becomes named entries', () => {
  it('reads cost, usage date, service, and currency by column name', () => {
    const entries = parseCostQueryPage(
      fixturePage([
        [1.23, 20260809, 'Virtual Machines', 'USD'],
        [0.4, 20260810, 'Storage', 'USD'],
      ]),
    )
    expect(entries).toEqual([
      { day: '2026-08-09', cost: 1.23, currency: 'USD', service: 'Virtual Machines' },
      { day: '2026-08-10', cost: 0.4, currency: 'USD', service: 'Storage' },
    ])
  })

  it('accepts PreTaxCost, the older subscription offer column name', () => {
    const entries = parseCostQueryPage(fixturePage([[2, 20260801, 'Storage', 'EUR']], 'PreTaxCost'))
    expect(entries).toEqual([{ day: '2026-08-01', cost: 2, currency: 'EUR', service: 'Storage' }])
  })

  it('skips malformed rows rather than failing the page', () => {
    const entries = parseCostQueryPage(
      fixturePage([
        [1, 20260801, 'Storage', 'USD'],
        ['not a number' as unknown as number, 20260801, 'Broken', 'USD'],
        [1, 999 as unknown as number, 'Broken date', 'USD'],
      ]),
    )
    expect(entries).toHaveLength(1)
  })

  it('a row with no service name still counts, under Other', () => {
    const entries = parseCostQueryPage(fixturePage([[0.5, 20260801, '', 'USD']]))
    expect(entries).toEqual([{ day: '2026-08-01', cost: 0.5, currency: 'USD', service: 'Other' }])
  })

  it('an answer missing the expected columns parses to nothing', () => {
    expect(parseCostQueryPage({ properties: { columns: [{ name: 'Weird' }], rows: [[1]] } })).toEqual([])
    expect(parseCostQueryPage(null)).toEqual([])
    expect(parseCostQueryPage('nonsense')).toEqual([])
  })
})

describe('rollupDailyCosts: totals, top services, honest edges', () => {
  it('groups by day, sums the total, sorts days ascending', () => {
    const rollups = rollupDailyCosts([
      { day: '2026-08-02', cost: 1, currency: 'USD', service: 'Storage' },
      { day: '2026-08-01', cost: 2, currency: 'USD', service: 'Storage' },
      { day: '2026-08-02', cost: 3, currency: 'USD', service: 'Virtual Machines' },
    ])
    expect(rollups.map((r) => r.day)).toEqual(['2026-08-01', '2026-08-02'])
    expect(rollups[1].total_cost).toBe(4)
    expect(rollups[1].by_service).toEqual({ 'Virtual Machines': 3, Storage: 1 })
  })

  it('bounds by_service at the limit but the total still covers every service', () => {
    const entries = Array.from({ length: AZURE_TOP_SERVICES_LIMIT + 5 }, (_, i) => ({
      day: '2026-08-01',
      cost: i + 1,
      currency: 'USD',
      service: `Service ${i}`,
    }))
    const [rollup] = rollupDailyCosts(entries)
    expect(Object.keys(rollup.by_service)).toHaveLength(AZURE_TOP_SERVICES_LIMIT)
    // Sum 1..15 = 120: nothing dropped from the total.
    expect(rollup.total_cost).toBe(120)
    // The kept services are the top spenders.
    expect(rollup.by_service[`Service ${AZURE_TOP_SERVICES_LIMIT + 4}`]).toBe(
      AZURE_TOP_SERVICES_LIMIT + 5,
    )
    expect(rollup.by_service['Service 0']).toBeUndefined()
  })

  it('negative costs (credits, refunds) pass through as real numbers', () => {
    const [rollup] = rollupDailyCosts([
      { day: '2026-08-01', cost: 5, currency: 'USD', service: 'Storage' },
      { day: '2026-08-01', cost: -7.5, currency: 'USD', service: 'Credit' },
    ])
    expect(rollup.total_cost).toBe(-2.5)
  })

  it('rounds the metering noise to two decimals', () => {
    const [rollup] = rollupDailyCosts([
      { day: '2026-08-01', cost: 0.123456789, currency: 'USD', service: 'Storage' },
    ])
    expect(rollup.total_cost).toBe(0.12)
    expect(rollup.by_service.Storage).toBe(0.12)
  })
})

describe('the HTTP client: one attempt, safe errors, no secret anywhere', () => {
  let calls: Array<{ url: string; body: string }>

  beforeEach(() => {
    calls = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Awaits a call that must reject and hands back the AzureApiError. */
  async function expectAzureFailure(promise: Promise<unknown>): Promise<AzureApiError> {
    try {
      await promise
    } catch (err) {
      expect(err).toBeInstanceOf(AzureApiError)
      return err as AzureApiError
    }
    throw new Error('expected the call to reject')
  }

  function stubFetch(responses: Response[]) {
    let i = 0
    global.fetch = vi.fn(async (url: unknown, init?: unknown) => {
      calls.push({
        url: String(url),
        body: String((init as { body?: unknown })?.body ?? ''),
      })
      return responses[Math.min(i++, responses.length - 1)]
    }) as unknown as typeof fetch
  }

  it('acquireAzureToken returns the token from a 200', async () => {
    stubFetch([Response.json({ access_token: 'FAKE-TOKEN' })])
    await expect(acquireAzureToken(CREDENTIAL)).resolves.toBe('FAKE-TOKEN')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain(CREDENTIAL.tenantId)
    expect(calls[0].body).toContain('client_credentials')
  })

  it('a refused credential is ONE attempt and an error built from the status alone', async () => {
    stubFetch([new Response('{"error":"invalid_client","secret_echo":"x"}', { status: 401 })])
    const failure = await expectAzureFailure(acquireAzureToken(CREDENTIAL))
    expect(failure.status).toBe(401)
    // No retry: exactly one request left the building.
    expect(calls).toHaveLength(1)
    // The message names the fix and carries nothing from the request or
    // response: not the secret, not the tenant, not the body.
    expect(failure.message).toContain('HTTP 401')
    expect(failure.message).not.toContain(CREDENTIAL.clientSecret)
    expect(failure.message).not.toContain(CREDENTIAL.tenantId)
    expect(failure.message).not.toContain('secret_echo')
  })

  it('queryDailyCosts sends the daily by-service query and parses the answer', async () => {
    stubFetch([Response.json(fixturePage([[1.5, 20260810, 'Storage', 'USD']]))])
    const entries = await queryDailyCosts({
      subscriptionId: '11111111-aaaa-4111-8111-111111111111',
      accessToken: 'FAKE-TOKEN',
      from: '2026-07-01',
      to: '2026-08-10',
    })
    expect(entries).toEqual([{ day: '2026-08-10', cost: 1.5, currency: 'USD', service: 'Storage' }])
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].body) as Record<string, unknown>
    expect(body.type).toBe('ActualCost')
    expect((body.dataset as { granularity: string }).granularity).toBe('Daily')
  })

  it('a 403 names the missing role, from the status alone, in one attempt', async () => {
    stubFetch([new Response('{"error":{"message":"tenant detail"}}', { status: 403 })])
    const failure = await expectAzureFailure(
      queryDailyCosts({
        subscriptionId: '11111111-aaaa-4111-8111-111111111111',
        accessToken: 'FAKE-TOKEN',
        from: '2026-07-01',
        to: '2026-08-10',
      }),
    )
    expect(failure.message).toContain('Cost Management Reader')
    expect(failure.message).not.toContain('tenant detail')
    expect(calls).toHaveLength(1)
  })

  it('follows nextLink pagination within the management host, bounded', async () => {
    const page1 = fixturePage([[1, 20260809, 'Storage', 'USD']]) as {
      properties: Record<string, unknown>
    }
    page1.properties.nextLink =
      'https://management.azure.com/subscriptions/x/providers/Microsoft.CostManagement/query?page=2'
    stubFetch([
      Response.json(page1),
      Response.json(fixturePage([[2, 20260810, 'Storage', 'USD']])),
    ])
    const entries = await queryDailyCosts({
      subscriptionId: '11111111-aaaa-4111-8111-111111111111',
      accessToken: 'FAKE-TOKEN',
      from: '2026-07-01',
      to: '2026-08-10',
    })
    expect(entries).toHaveLength(2)
    expect(calls).toHaveLength(2)
  })

  it('a nextLink pointing off the management host is not followed', async () => {
    const page = fixturePage([[1, 20260809, 'Storage', 'USD']]) as {
      properties: Record<string, unknown>
    }
    page.properties.nextLink = 'https://evil.example.com/steal-token'
    stubFetch([Response.json(page)])
    const entries = await queryDailyCosts({
      subscriptionId: '11111111-aaaa-4111-8111-111111111111',
      accessToken: 'FAKE-TOKEN',
      from: '2026-07-01',
      to: '2026-08-10',
    })
    expect(entries).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })
})
