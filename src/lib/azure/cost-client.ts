import 'server-only'

import {
  AZURE_MAX_QUERY_PAGES,
  parseCostQueryPage,
  parseUsageDetailsPage,
  type AzureCostEntry,
} from './costs'

/**
 * The two Azure calls the pull path makes, and nothing else: mint a token
 * for the service principal, then run one Cost Management query. ONE attempt
 * per call, no retries here or in any caller (the platform key resilience
 * rule; a failed daily pull costs one day of freshness and the staleness
 * banner says so, which is cheaper than a retry storm against a provider
 * that is refusing us).
 *
 * Secrecy discipline, the providers.ts construction: the client secret and
 * the bearer token live only in this module's request scopes. Errors are
 * built from the HTTP status ALONE; the response body is never read into an
 * error, a log, or a message, because Entra error bodies quote request
 * details. Nothing in this module logs.
 */

const REQUEST_TIMEOUT_MS = 15_000

export class AzureApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AzureApiError'
    this.status = status
  }
}

/** Status to sentence, status alone, the remediation() construction. The
 * wording is safe to show an admin on the connect screen. */
function tokenErrorMessage(status: number): string {
  if (status === 400 || status === 401) {
    return (
      `Azure refused the credential (HTTP ${status}). The tenant id, client id, ` +
      'or client secret is wrong, or the secret has expired.'
    )
  }
  if (status === 429) return 'Azure rate limited the sign in (HTTP 429). Try again in a minute.'
  return `Azure sign in failed (HTTP ${status}).`
}

function costsErrorMessage(status: number): string {
  if (status === 401) {
    return 'Azure rejected the session (HTTP 401). The credential may have just expired.'
  }
  if (status === 403) {
    return (
      'Azure denied access to cost data (HTTP 403). The service principal needs ' +
      'the Cost Management Reader role on this subscription.'
    )
  }
  if (status === 404) {
    return 'Azure could not find that subscription (HTTP 404). Check the subscription id.'
  }
  if (status === 422) {
    return 'Azure could not answer the cost query (HTTP 422). New subscriptions can take a day to have cost data.'
  }
  if (status === 429) return 'Azure rate limited the cost query (HTTP 429).'
  return `Azure Cost Management returned HTTP ${status}.`
}

export type AzureCredential = {
  tenantId: string
  clientId: string
  clientSecret: string
}

/**
 * Client credentials sign in against the org's Entra tenant. Returns the
 * bearer token for the Azure Resource Manager audience; the token is short
 * lived (about an hour) and is used once, for the query that follows.
 */
export async function acquireAzureToken(credential: AzureCredential): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(credential.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        scope: 'https://management.azure.com/.default',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  )
  if (!res.ok) throw new AzureApiError(tokenErrorMessage(res.status), res.status)
  const body = (await res.json()) as { access_token?: unknown }
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new AzureApiError('Azure sign in returned no token.', res.status)
  }
  return body.access_token
}

/**
 * One Cost Management query: actual cost, daily granularity, grouped by
 * service name, over [from, to] inclusive ('YYYY-MM-DD'). Follows the
 * response's nextLink for large answers, bounded at AZURE_MAX_QUERY_PAGES;
 * that is pagination of one answer, not a retry.
 */
export async function queryDailyCosts(args: {
  subscriptionId: string
  accessToken: string
  from: string
  to: string
}): Promise<AzureCostEntry[]> {
  const firstUrl =
    'https://management.azure.com/subscriptions/' +
    `${encodeURIComponent(args.subscriptionId)}/providers/Microsoft.CostManagement/query` +
    '?api-version=2023-11-01'

  const entries: AzureCostEntry[] = []
  let url: string | null = firstUrl
  for (let page = 0; page < AZURE_MAX_QUERY_PAGES && url !== null; page++) {
    const res: Response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'ActualCost',
        timeframe: 'Custom',
        timePeriod: {
          from: `${args.from}T00:00:00+00:00`,
          to: `${args.to}T23:59:59+00:00`,
        },
        dataset: {
          granularity: 'Daily',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          grouping: [{ type: 'Dimension', name: 'ServiceName' }],
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new AzureApiError(costsErrorMessage(res.status), res.status)
    const payload: unknown = await res.json()
    entries.push(...parseCostQueryPage(payload))
    const next = (payload as { properties?: { nextLink?: unknown } }).properties?.nextLink
    url = typeof next === 'string' && next.startsWith('https://management.azure.com/') ? next : null
  }
  return entries
}

/**
 * The same window through the Consumption usage details API: one GET, paged
 * by nextLink under the same bound. Verbose (one record per meter per
 * resource per day) but throttled by CLIENT APP ID with a real budget, where
 * the Query API's per client type budget is zero on some subscription
 * offers. parseUsageDetailsPage aggregates the records back into the same
 * entries the query would have returned.
 */
export async function queryUsageDetailsCosts(args: {
  subscriptionId: string
  accessToken: string
  from: string
  to: string
}): Promise<AzureCostEntry[]> {
  const filter = `properties/usageStart ge '${args.from}' and properties/usageEnd le '${args.to}'`
  const firstUrl =
    'https://management.azure.com/subscriptions/' +
    `${encodeURIComponent(args.subscriptionId)}/providers/Microsoft.Consumption/usageDetails` +
    `?api-version=2024-08-01&$top=1000&$filter=${encodeURIComponent(filter)}`

  const entries: AzureCostEntry[] = []
  let url: string | null = firstUrl
  for (let page = 0; page < AZURE_MAX_QUERY_PAGES && url !== null; page++) {
    const res: Response = await fetch(url, {
      headers: { authorization: `Bearer ${args.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new AzureApiError(costsErrorMessage(res.status), res.status)
    const payload: unknown = await res.json()
    entries.push(...parseUsageDetailsPage(payload))
    const next = (payload as { nextLink?: unknown }).nextLink
    url = typeof next === 'string' && next.startsWith('https://management.azure.com/') ? next : null
  }
  return entries
}

export type DailyCostPull = {
  entries: AzureCostEntry[]
  /** Which API answered; carried into the sweep's counts, never required. */
  source: 'query' | 'usage_details'
}

/**
 * The one entry point the pull path and the connect verification use. Tries
 * the Cost Management Query API once; on 429, and only on 429, takes the
 * usage details road instead. That is not a retry: it is a different API in
 * a different throttle family, and the 429 case it exists for was observed
 * against a real subscription (Azure for Students, 2026-09-08), where the
 * Query API grants unrecognized client applications a permanent budget of
 * ZERO while usage details answers normally. One attempt per API per pull,
 * and every other failure status still surfaces immediately.
 */
export async function pullDailyCostEntries(args: {
  subscriptionId: string
  accessToken: string
  from: string
  to: string
}): Promise<DailyCostPull> {
  try {
    return { entries: await queryDailyCosts(args), source: 'query' }
  } catch (err) {
    if (err instanceof AzureApiError && err.status === 429) {
      return { entries: await queryUsageDetailsCosts(args), source: 'usage_details' }
    }
    throw err
  }
}
