/**
 * Pure logic for Azure cost monitoring (BRD F23): the daily due check, the
 * pull window, and the shaping of Cost Management query rows into the daily
 * rollups migration 026 stores. No I/O here, the cert-alerts construction:
 * everything is testable with plain values, and the sweep route owns every
 * read and write.
 *
 * Vocabulary, for anyone new to Azure: Cost Management is Azure's billing
 * query API. Asked for "actual cost, daily granularity, grouped by service
 * name" it returns one row per day per service (Virtual Machines, Storage,
 * Bandwidth, ...) with the cost in the subscription's billing currency.
 * Azure buckets those days itself and restates recent ones as usage settles
 * (metering lags by hours to a couple of days), which is why the pull always
 * re-covers a trailing window and the rollup upsert is idempotent.
 */

/** Services kept per day in the by_service jsonb. Top spenders only; the
 * day's total_cost always covers everything regardless (v1 ruling: no per
 * resource or exhaustive per service detail). */
export const AZURE_TOP_SERVICES_LIMIT = 10

/** How many pages of a paginated cost query the pull will follow. One page
 * holds 1000 rows, a day-by-service window is rarely over two pages, and a
 * bound keeps a pathological answer from pinning the sweep. */
export const AZURE_MAX_QUERY_PAGES = 5

/** One row of the Cost Management answer, already named. */
export type AzureCostEntry = {
  /** 'YYYY-MM-DD', Azure's own usage day bucket. */
  day: string
  cost: number
  currency: string
  service: string
}

/** One azure_daily_costs row, ready to upsert. */
export type AzureDailyRollup = {
  day: string
  total_cost: number
  currency: string
  by_service: Record<string, number>
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 'YYYY-MM-DD' in UTC. */
function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * One pull attempt per subscription per UTC day, success or failure. The
 * stamp is last_pull_at (every attempt moves it), so a failed morning pull
 * does not turn the five minute sweep into 288 failing Azure calls a day;
 * the next attempt is tomorrow and the staleness banner tells the admin the
 * truth in the meantime.
 */
export function azurePullDue(lastPullAtIso: string | null, nowMs: number): boolean {
  if (lastPullAtIso === null) return true
  const lastMs = Date.parse(lastPullAtIso)
  if (Number.isNaN(lastMs)) return true
  return utcDateString(lastMs) !== utcDateString(nowMs)
}

/**
 * The window each pull covers: the first day of the PREVIOUS UTC month
 * through today. Wide on purpose: the screen compares this month against
 * last month, a brand new connection backfills both in its first pull, and
 * Azure's restatement of recent days is re-absorbed daily for free. Roughly
 * sixty rows per service per pull, well inside one query page.
 */
export function azurePullRange(nowMs: number): { from: string; to: string } {
  const now = new Date(nowMs)
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return { from: utcDateString(from.getTime()), to: utcDateString(nowMs) }
}

/**
 * Reads one Cost Management query response page into named entries. The
 * response is columnar: a columns array naming each position, then rows of
 * bare values. The cost column is 'Cost' under the totalCost aggregation
 * ('PreTaxCost' on some older subscription offers, accepted too). UsageDate
 * arrives as the number 20260810; currency and service name as strings.
 *
 * Malformed rows are skipped rather than thrown: one odd row in a page must
 * not cost the whole day's pull, and the total the screen shows is built
 * from what parsed.
 */
export function parseCostQueryPage(payload: unknown): AzureCostEntry[] {
  if (typeof payload !== 'object' || payload === null) return []
  const properties = (payload as { properties?: unknown }).properties
  if (typeof properties !== 'object' || properties === null) return []
  const { columns, rows } = properties as { columns?: unknown; rows?: unknown }
  if (!Array.isArray(columns) || !Array.isArray(rows)) return []

  const names = columns.map((c) =>
    typeof c === 'object' && c !== null && typeof (c as { name?: unknown }).name === 'string'
      ? (c as { name: string }).name
      : '',
  )
  const costIdx = names.findIndex((n) => n === 'Cost' || n === 'PreTaxCost')
  const dateIdx = names.indexOf('UsageDate')
  const serviceIdx = names.indexOf('ServiceName')
  const currencyIdx = names.indexOf('Currency')
  if (costIdx === -1 || dateIdx === -1 || serviceIdx === -1 || currencyIdx === -1) {
    return []
  }

  const entries: AzureCostEntry[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const cost = row[costIdx]
    const date = row[dateIdx]
    const service = row[serviceIdx]
    const currency = row[currencyIdx]
    if (typeof cost !== 'number' || !Number.isFinite(cost)) continue
    if (typeof currency !== 'string' || currency.trim() === '') continue
    const day = usageDateToDay(date)
    if (day === null) continue
    entries.push({
      day,
      cost,
      currency,
      // A row with no service name (rare, but Azure emits them for some
      // charges) still counts toward the day; it just has no named bucket.
      service: typeof service === 'string' && service.trim() !== '' ? service : 'Other',
    })
  }
  return entries
}

/**
 * Reads one Consumption usage details page into the same named entries. This
 * is the FALLBACK shape (see pullDailyCostEntries in cost-client.ts): where
 * the Query API's per client budget is zero, the older usage details API
 * still answers, but as one record per meter per resource per day instead of
 * a columnar aggregate, and with two field spellings in the wild. The
 * modern kind carries costInBillingCurrency and billingCurrencyCode; the
 * legacy kind carries cost and billingCurrency. Both are accepted; the
 * service bucket is the meter category, which is what the Query API's
 * ServiceName dimension aggregates too.
 *
 * Malformed records are skipped, never thrown on, same as the query parser.
 */
export function parseUsageDetailsPage(payload: unknown): AzureCostEntry[] {
  if (typeof payload !== 'object' || payload === null) return []
  const { value } = payload as { value?: unknown }
  if (!Array.isArray(value)) return []

  const entries: AzureCostEntry[] = []
  for (const record of value) {
    if (typeof record !== 'object' || record === null) continue
    const properties = (record as { properties?: unknown }).properties
    if (typeof properties !== 'object' || properties === null) continue
    const p = properties as Record<string, unknown>

    const cost =
      typeof p.costInBillingCurrency === 'number' && Number.isFinite(p.costInBillingCurrency)
        ? p.costInBillingCurrency
        : typeof p.cost === 'number' && Number.isFinite(p.cost)
          ? p.cost
          : null
    const currency =
      typeof p.billingCurrencyCode === 'string' && p.billingCurrencyCode.trim() !== ''
        ? p.billingCurrencyCode
        : typeof p.billingCurrency === 'string' && p.billingCurrency.trim() !== ''
          ? p.billingCurrency
          : null
    const day =
      typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.date)
        ? p.date.slice(0, 10)
        : null
    if (cost === null || currency === null || day === null) continue

    entries.push({
      day,
      cost,
      currency,
      service:
        typeof p.meterCategory === 'string' && p.meterCategory.trim() !== ''
          ? p.meterCategory
          : 'Other',
    })
  }
  return entries
}

/** 20260810 (or '20260810') to '2026-08-10'; null when it is neither. */
function usageDateToDay(value: unknown): string | null {
  const digits =
    typeof value === 'number' && Number.isInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : null
  if (digits === null || !/^\d{8}$/.test(digits)) return null
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
}

/**
 * Entries to daily rollup rows: total per day, plus the top services by
 * spend, bounded at AZURE_TOP_SERVICES_LIMIT. The total always includes
 * every service, bounded or not; negative costs (credits, refunds) are
 * real and pass through. Currency is taken from the day's rows; Azure
 * reports one billing currency per subscription.
 */
export function rollupDailyCosts(entries: AzureCostEntry[]): AzureDailyRollup[] {
  const byDay = new Map<string, { total: number; currency: string; services: Map<string, number> }>()
  for (const entry of entries) {
    let day = byDay.get(entry.day)
    if (!day) {
      day = { total: 0, currency: entry.currency, services: new Map() }
      byDay.set(entry.day, day)
    }
    day.total += entry.cost
    day.services.set(entry.service, (day.services.get(entry.service) ?? 0) + entry.cost)
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, sums]) => {
      const top = [...sums.services.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, AZURE_TOP_SERVICES_LIMIT)
      return {
        day,
        total_cost: round2(sums.total),
        currency: sums.currency,
        by_service: Object.fromEntries(top.map(([name, cost]) => [name, round2(cost)])),
      }
    })
}

/** Two decimals, the display precision. Azure reports many more; the sub
 * cent tail is metering noise the screen would never show. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Staleness, the heartbeat construction: how long since the last successful
 * pull, so the screen can say "Azure has not answered since Tuesday" instead
 * of rendering a fake zero. Returns null while the connection has never
 * succeeded (a distinct state; the screen words it differently) or when the
 * last success is recent enough. Two full days is the threshold: the pull is
 * daily and Azure's own data lags, so one quiet day is normal and two is not.
 */
export const AZURE_STALE_AFTER_MS = 2 * DAY_MS

export function azurePullAgeMs(lastSuccessAtIso: string | null, nowMs: number): number | null {
  if (lastSuccessAtIso === null) return null
  const ms = Date.parse(lastSuccessAtIso)
  if (Number.isNaN(ms)) return null
  return Math.max(0, nowMs - ms)
}
