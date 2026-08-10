import 'server-only'

/**
 * The one place this codebase writes to the console.
 *
 * Every log line is a single line of JSON with a fixed field set, so a human
 * reading Vercel's runtime logs and a machine grepping them see the same
 * shape. Before this module the codebase had 22 hand formatted console calls
 * whose only structure was a prefix convention, which meant no line could be
 * filtered on reliably and every new caller invented its own wording.
 *
 * Why a module and not a dependency: an error tracker is a real dependency
 * (a tree, a build plugin, and a client bundle) and this project has seven
 * runtime dependencies on purpose. What the tracker would buy over this is
 * durable retention, and that is bought instead by posting the lines that
 * matter to an operator owned channel. This module is the single seam where
 * a real tracker attaches if one is ever warranted, and `no-console` in the
 * eslint config is what keeps the seam single.
 *
 * The tenant data rule, unchanged from the callers this replaced: a log line
 * carries status, counts, and provider names. It never carries an org id, a
 * recipient address, a webhook URL, a ticket title, a message body, or key
 * material. The `LogDetail` type enforces the shape at compile time and
 * `safeDetail` enforces it again at runtime, so an untyped caller still
 * cannot serialize an object. That second guard is why an Error can never
 * contribute a stack: pass `errorName(err)`, not the error.
 */

/**
 * Every log line this codebase can emit. A closed union rather than a string
 * so event names cannot drift into free text, which is what makes them
 * filterable. Adding a line means adding a name here first.
 */
export type LogEvent =
  // The AI chat path.
  | 'chat.provider.call'
  | 'chat.send.failed'
  | 'chat.grounding.failed'
  // An org entitled to managed answers hit a missing platform key (F13).
  | 'chat.platform_key.not_configured'
  // The provider refused the platform key at answer time: spend limit
  // reached, rate limited, or the key is invalid. Reported to the operator
  // channel; the managed path degrades to the Get Help door.
  | 'chat.platform_key.failed'
  // The Clerk webhook that syncs organizations and memberships.
  | 'clerk.webhook.applied'
  | 'clerk.webhook.failed'
  // The Stripe webhook that syncs subscription state into org_billing (F13).
  | 'stripe.webhook.applied'
  | 'stripe.webhook.failed'
  // The billing screen's two server actions (F13 PR 2). Names only, never
  // Stripe error text: it can quote request details.
  | 'billing.checkout.failed'
  | 'billing.portal.failed'
  | 'billing.cancel.failed'
  | 'billing.addon.failed'
  // The five minute sweep, its steps, and the daily digest that rides it.
  | 'cron.sweep.complete'
  | 'cron.sweep.steps_failed'
  | 'cron.heartbeat.stamp_failed'
  | 'cron.monitors.list_failed'
  | 'cron.incidents.list_failed'
  | 'cron.incidents.stamp_failed'
  | 'cron.settings.list_failed'
  | 'cron.timezones.list_failed'
  | 'cron.cert.evaluate_failed'
  | 'cron.suppression.catchup_failed'
  | 'cron.digest.settings_failed'
  | 'cron.digest.entitlements_failed'
  | 'cron.digest.timezones_failed'
  | 'cron.digest.send_failed'
  | 'cron.digest.org_failed'
  | 'cron.digest.stamp_failed'
  // Document suggestions on the ticket form. The name only; never a draft,
  // a term, or a result.
  | 'help.suggestions.failed'
  // The immediate first check after a monitor is created.
  | 'monitors.first_check_failed'
  // Incident notification channels.
  | 'notifications.email.not_configured'
  | 'notifications.email.send_failed'
  | 'notifications.dispatch.email_failed'
  | 'notifications.dispatch.discord_failed'
  | 'notifications.dispatch.discord_rejected'
  | 'notifications.dispatch.cert_email_failed'
  | 'notifications.dispatch.cert_discord_failed'
  | 'notifications.dispatch.cert_discord_rejected'
  // The operator error sink itself.
  | 'ops.report.not_configured'

/**
 * What happened, in one token. Kept to a small union for the same reason as
 * the event names: so a dashboard can count failures without parsing prose.
 */
export type LogOutcome = 'ok' | 'failed' | 'skipped' | 'rejected' | 'unavailable'

/**
 * The free field, restricted to primitives. There is no recursive value type
 * on purpose: nesting is how an object with a stack, a request body, or a row
 * gets logged by accident.
 */
export type LogDetail = Record<string, string | number | boolean>

/** The serialized line. Field order here is the field order in the output. */
type LogLine = {
  ts: string
  level: 'info' | 'error'
  event: LogEvent
  outcome: LogOutcome
  detail?: LogDetail
}

/**
 * The runtime half of the tenant data guard. TypeScript already refuses a non
 * primitive, but this module is the last thing standing between a careless
 * caller and a leaked stack, so the check is repeated where it cannot be
 * compiled away. A rejected value is replaced rather than dropped, so the
 * mistake is visible in the log instead of silently vanishing.
 */
function safeDetail(detail: LogDetail): LogDetail {
  const safe: LogDetail = {}
  for (const [key, value] of Object.entries(detail)) {
    const t = typeof value
    safe[key] = t === 'string' || t === 'number' || t === 'boolean' ? value : '[unloggable]'
  }
  return safe
}

function emit(
  level: 'info' | 'error',
  event: LogEvent,
  outcome: LogOutcome,
  detail?: LogDetail,
): void {
  const line: LogLine = { ts: new Date().toISOString(), level, event, outcome }
  if (detail) {
    const safe = safeDetail(detail)
    if (Object.keys(safe).length > 0) line.detail = safe
  }
  // The only console calls in the codebase. `no-console` is an error
  // everywhere else, with this file the single exception in eslint.config.mjs,
  // which is what keeps this module the one seam rather than a convention.
  const text = JSON.stringify(line)
  if (level === 'error') console.error(text)
  else console.log(text)
}

/** A line worth keeping when nothing is wrong: sweep summaries, sync results. */
export function logInfo(event: LogEvent, outcome: LogOutcome, detail?: LogDetail): void {
  emit('info', event, outcome, detail)
}

export type LogErrorOptions = {
  /**
   * Also post this to the operator channel (src/lib/ops/report.ts).
   *
   * Opt in, never automatic, and that is the whole design. A per org email
   * misconfiguration logs on every sweep, so reporting all errors would page
   * the operator every five minutes until it was muted, and a muted channel
   * catches nothing. Reserve it for failures of the platform itself.
   */
  report?: boolean
}

/**
 * A line for something that failed. Note that in this codebase a failure is
 * usually already swallowed by the caller (the sweep and the notification
 * fan out both never throw), so this is the only record that it happened.
 */
export function logError(
  event: LogEvent,
  outcome: LogOutcome,
  detail?: LogDetail,
  options?: LogErrorOptions,
): void {
  emit('error', event, outcome, detail)

  if (options?.report) {
    // Fire and forget, and imported lazily so the sink is not pulled into
    // every module that logs. Logging must stay synchronous and must never
    // fail because a webhook did.
    const reason = typeof detail?.error === 'string' ? detail.error : undefined
    void import('@/lib/ops/report')
      .then(({ reportOpsError }) => reportOpsError({ event, reason }))
      .catch(() => {})
  }
}

/**
 * The name of an error and nothing else. Every call site that wants to say
 * what went wrong uses this: the name is a class, which is useful, while the
 * message and the stack are unvetted text that may quote a request body.
 */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown'
}
