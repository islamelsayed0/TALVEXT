import { NextResponse } from 'next/server'

import { acquireAzureToken, queryDailyCosts } from '@/lib/azure/cost-client'
import { azurePullDue, azurePullRange, rollupDailyCosts } from '@/lib/azure/costs'
import { readConnectionSecret } from '@/lib/azure/credential-vault'
import { resolveEntitlements } from '@/lib/billing/entitlements'
import { createAdminClient } from '@/lib/db/admin'
import { isLowStock } from '@/lib/db/inventory'
import { interleaveTrail } from '@/lib/db/tickets'
import { DEFAULT_TIMEZONE, zonedMinuteLabel } from '@/lib/db/usage'
import { errorName, logError, logInfo } from '@/lib/log'
import { clientIp, createSlidingWindow } from '@/lib/rate-limit'
import {
  certDaysLeft,
  decideCertAlert,
  type CertThreshold,
} from '@/lib/monitoring/cert-alerts'
import { runMonitorCheck } from '@/lib/monitoring/check'
import { isAuthorizedCronRequest } from '@/lib/monitoring/cron-auth'
import {
  decide,
  type EngineAction,
  type EngineState,
  type IncidentEventInput,
} from '@/lib/monitoring/incident-engine'
import {
  composeDigest,
  digestDueCheck,
  digestSection,
  digestWindowStartMs,
  isAwaitingReply,
  waitingSinceMs,
  type DigestData,
  type DigestSchedule,
  type DigestTicket,
  type DigestTrailItem,
} from '@/lib/notifications/digest'
import {
  needsCatchUp,
  notifyCertExpiry,
  notifyIncidentEvent,
  suppressedAt,
  type IncidentNotifyEvent,
  type NotifyChannelSettings,
} from '@/lib/notifications/dispatch'
import { sendAlertEmailResult } from '@/lib/notifications/email'

/**
 * The cron sweep (architecture ruling for Phase 1 Task 1). An external
 * scheduler (cron-job.org, decision log 2026-07-27) invokes this route
 * every 5 minutes: POST, Bearer CRON_SECRET, expecting a 200. The Vercel
 * Cron schedule is gone; Hobby caps it at once per day, which notifications
 * cannot live with. The sweep finds every active monitor due for a check,
 * runs the checks, writes results, runs the incident engine on each result,
 * prunes raw rows older than 30 days, and maintains the daily rollups. Each
 * monitor's own interval is respected: the sweep only checks monitors whose
 * interval has elapsed since their last check.
 *
 * Incidents (Phase 1 Task 2): after each check is recorded, the pure
 * engine in src/lib/monitoring/incident-engine.ts decides what it means
 * (await confirmation, blip, open, reopen, resolve) and this route performs
 * the writes. Confirmation rechecks ride the normal sweep: a monitor with
 * failing_since set gets rechecked on the NEXT invocation (decision log
 * 2026-07-23: never assume fresh checks). The logic is correct at any
 * cadence and tightens automatically when the schedule does.
 *
 * Notifications (F10): when an incident opens, reopens, or resolves, the
 * org's configured channels (Resend email, Discord webhook) are notified
 * from applyIncidentAction, after the incident write, never before.
 * Settings are fetched once per sweep per org. A notification failure is
 * logged and swallowed; it never fails the sweep or the incident write.
 *
 * The daily digest: the same sweep also sends each org's one email a day, at
 * the time that org chose, in that org's own timezone. It runs after all the
 * work above, reads what that work has just settled, and cannot fail the
 * sweep. No new scheduler and no new cron entry: the 5 minute cadence is what
 * makes a 07:30 setting land at 07:30 or a few minutes after.
 *
 * Tickets: this sweep no longer touches them. It used to close anything left
 * resolved for 7 days, and migration 019 retired both that step and the closed
 * state it produced, because a closed ticket was final and a requester now has
 * a Reopen button that must keep working. Getting settled tickets out of the
 * way is now the requester's own list rule, which hides without freezing.
 *
 * Auth: CRON_SECRET bearer token, checked before anything else; requests
 * without it get 401 and touch nothing. The route is excluded from Clerk
 * middleware (src/proxy.ts) because cron invocations carry no user session.
 * It therefore runs on the service role client, which bypasses RLS: the
 * narrow no-tenant-context case admin.ts exists for. Incidents and their
 * timeline events are written ONLY here; user sessions can read them and
 * nothing else. No tenant data is logged, only counts.
 */

// Never static, never cached: every invocation must sweep.
export const dynamic = 'force-dynamic'
// Within every Vercel plan's function ceiling. With batches of 10 and a 10
// second per check timeout, this comfortably covers Phase 1 monitor counts.
export const maxDuration = 60

const RETENTION_DAYS = 30
const BATCH_SIZE = 10

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

type Db = ReturnType<typeof createAdminClient>

type SweptMonitor = {
  id: string
  org_id: string
  name: string
  url: string
  interval_seconds: number
  last_checked_at: string | null
  failing_since: string | null
  cert_expires_at: string | null
  cert_alerted_threshold: string | null
  suppress_until: string | null
  suppress_set_at: string | null
}

/**
 * Notification dispatch (F10), strictly AFTER the incident write succeeded:
 * the row stands whatever happens here. notifyIncidentEvent never throws and
 * owns the reopen cooldown; when a channel actually fired, the incident is
 * stamped so the next reopen can measure its cooldown from it. A failed
 * stamp is logged and swallowed for the same reason a failed send is: a
 * notification problem must never fail the sweep.
 */
async function notifyAndStamp(
  db: Db,
  settings: NotifyChannelSettings | undefined,
  monitor: SweptMonitor,
  event: IncidentNotifyEvent,
  incidentId: string,
  occurredAtIso: string,
  lastNotifiedAtIso: string | null,
): Promise<void> {
  if (!settings) return
  // Maintenance window (migration 021): a suppressed send is SKIPPED, not
  // queued, and last_notified_at is not stamped, which is exactly what lets
  // the catch up pass recognize an open incident the window outlived. The
  // incident write already happened above this call; only the noise is held.
  if (suppressedAt(monitor.suppress_until, Date.now())) return
  const { attempted } = await notifyIncidentEvent(
    settings,
    { name: monitor.name, url: monitor.url },
    event,
    { occurredAtIso, lastNotifiedAtIso },
  )
  if (!attempted) return
  const { error } = await db
    .from('incidents')
    .update({ last_notified_at: new Date().toISOString() })
    .eq('id', incidentId)
  if (error) {
    logError('cron.incidents.stamp_failed', 'failed', { error: error.message })
  }
}

/**
 * Performs the writes one engine action describes. Returns the value
 * monitors.failing_since must take (undefined when it stays untouched) so
 * the caller can fold it into the monitor's status update, plus which
 * incident counter to bump. Open, reopen, and resolve dispatch notifications
 * here and nowhere else, always after their write succeeded.
 */
async function applyIncidentAction(
  db: Db,
  monitor: SweptMonitor,
  action: EngineAction,
  settings: NotifyChannelSettings | undefined,
): Promise<{ failingSince?: string | null; counted?: 'opened' | 'reopened' | 'resolved' }> {
  switch (action.kind) {
    case 'none':
      return {}
    case 'await_confirmation':
      return { failingSince: action.failingSince }
    case 'record_blip':
      return { failingSince: null }
    case 'open': {
      const { data: incident, error } = await db
        .from('incidents')
        .insert({
          org_id: monitor.org_id,
          monitor_id: monitor.id,
          status: 'open',
          opened_at: action.openedAt,
        })
        .select('id')
        .single()
      if (error) throw new Error(`opening incident: ${error.message}`)
      await appendEvents(db, monitor.org_id, incident.id, action.events)
      await notifyAndStamp(db, settings, monitor, 'open', incident.id, action.openedAt, null)
      return { failingSince: null, counted: 'opened' }
    }
    case 'reopen': {
      // The update does not touch last_notified_at, so selecting it back
      // returns the value from before this reopen: exactly what the
      // cooldown must measure against.
      const { data: reopened, error } = await db
        .from('incidents')
        .update({
          status: 'open',
          resolved_at: null,
          last_reopened_at: action.reopenedAt,
        })
        .eq('id', action.incidentId)
        .select('last_notified_at')
        .single()
      if (error) throw new Error(`reopening incident: ${error.message}`)
      await appendEvents(db, monitor.org_id, action.incidentId, action.events)
      await notifyAndStamp(
        db,
        settings,
        monitor,
        'reopen',
        action.incidentId,
        action.reopenedAt,
        reopened.last_notified_at,
      )
      return { failingSince: null, counted: 'reopened' }
    }
    case 'resolve': {
      const { error } = await db
        .from('incidents')
        .update({ status: 'resolved', resolved_at: action.resolvedAt })
        .eq('id', action.incidentId)
      if (error) throw new Error(`resolving incident: ${error.message}`)
      await appendEvents(db, monitor.org_id, action.incidentId, action.events)
      await notifyAndStamp(
        db,
        settings,
        monitor,
        'resolve',
        action.incidentId,
        action.resolvedAt,
        null,
      )
      return { failingSince: null, counted: 'resolved' }
    }
  }
}

/**
 * Certificate expiry evaluation (migration 020): a warning, not an incident.
 * Runs after the incident work for a monitor, asks the pure module whether a
 * threshold was crossed, dispatches through the cert fan out, and returns the
 * ledger columns to fold into the monitor's status update. Never throws; a
 * failure here costs one sweep of cert warnings and nothing else.
 *
 * The ledger is stamped from the decision alone, whether or not a channel was
 * configured or a provider accepted the message: one notification per
 * threshold crossing is the binding guarantee, a deeper threshold still fires
 * after a missed send, and the dashboard chip shows the state regardless.
 */
async function evaluateCertExpiry(
  monitor: SweptMonitor,
  captured: string | null,
  nowMs: number,
  timeZone: string,
  settings: NotifyChannelSettings | undefined,
): Promise<{ cert_expires_at?: string | null; cert_alerted_threshold?: string | null }> {
  try {
    if (!monitor.url.startsWith('https:')) {
      // http monitors store null and show nothing (spec ruling 2).
      return monitor.cert_expires_at !== null ||
        monitor.cert_alerted_threshold !== null
        ? { cert_expires_at: null, cert_alerted_threshold: null }
        : {}
    }

    // A failed read keeps the stored expiry: a transient handshake failure
    // must not wipe state or reset dedup. An expired certificate usually
    // BREAKS the handshake, and the stored, now past, expiry is exactly what
    // lets the expired threshold fire anyway.
    const effective = captured ?? monitor.cert_expires_at
    const decision = decideCertAlert({
      certExpiresAt: effective,
      previousExpiresAt: monitor.cert_expires_at,
      alertedThreshold: monitor.cert_alerted_threshold as CertThreshold | null,
      nowMs,
      timeZone,
    })

    if (decision.notify !== null && effective !== null && settings) {
      await notifyCertExpiry(
        settings,
        { name: monitor.name, url: monitor.url },
        {
          daysLeft: certDaysLeft(effective, nowMs, timeZone),
          expiresAtIso: effective,
          expired: decision.notify === 'expired',
        },
      )
    }

    const columns: { cert_expires_at?: string; cert_alerted_threshold?: string | null } = {}
    if (captured !== null) columns.cert_expires_at = captured
    if (decision.newAlertedThreshold !== monitor.cert_alerted_threshold) {
      columns.cert_alerted_threshold = decision.newAlertedThreshold
    }
    return columns
  } catch (err) {
    logError('cron.cert.evaluate_failed', 'failed', { error: errorName(err) })
    return {}
  }
}

async function appendEvents(
  db: Db,
  orgId: string,
  incidentId: string,
  events: IncidentEventInput[],
): Promise<void> {
  const { error } = await db.from('incident_events').insert(
    events.map((e) => ({
      org_id: orgId,
      incident_id: incidentId,
      event_type: e.eventType,
      occurred_at: e.occurredAt,
      check_id: e.checkId,
      detail: e.detail,
    })),
  )
  if (error) throw new Error(`writing timeline events: ${error.message}`)
}

// ---------------------------------------------------------------------------
// Maintenance window catch up (migration 021, ruling 5). When a window ends
// with the monitor still down, the open incident's alert goes out on the
// first sweep after expiry, so a real outage that outlived the window is
// never swallowed. This pass runs over EVERY expired window, not just due
// monitors: a monitor on a long interval must not stay silent because its
// next check is an hour away.

async function runSuppressionCatchUp(
  db: Db,
  nowMs: number,
): Promise<{ caughtUp: number; failed: number }> {
  const counts = { caughtUp: 0, failed: 0 }
  try {
    const { data: expired, error } = await db
      .from('monitors')
      .select('id, org_id, name, url, suppress_until, suppress_set_at')
      .not('suppress_until', 'is', null)
      .lte('suppress_until', new Date(nowMs).toISOString())
    if (error) throw new Error(error.message)
    if (expired.length === 0) return counts

    const { data: openIncidents, error: incidentsError } = await db
      .from('incidents')
      .select('id, monitor_id, opened_at, last_notified_at')
      .in('monitor_id', expired.map((m) => m.id))
      .eq('status', 'open')
    if (incidentsError) throw new Error(incidentsError.message)
    if (openIncidents.length === 0) return counts

    const monitorById = new Map(expired.map((m) => [m.id, m]))
    const due = openIncidents.filter((incident) => {
      const monitor = monitorById.get(incident.monitor_id)!
      return needsCatchUp({
        suppressUntilIso: monitor.suppress_until,
        suppressSetAtIso: monitor.suppress_set_at,
        lastNotifiedAtIso: incident.last_notified_at,
        nowMs,
      })
    })
    if (due.length === 0) return counts

    const orgIds = [...new Set(due.map((i) => monitorById.get(i.monitor_id)!.org_id))]
    const { data: settingsRows, error: settingsError } = await db
      .from('org_notification_settings')
      .select(
        'org_id, notification_email, discord_webhook, email_on_open, email_on_resolve, alert_cooldown_minutes',
      )
      .in('org_id', orgIds)
    if (settingsError) throw new Error(settingsError.message)
    const settingsByOrg = new Map<string, NotifyChannelSettings>(
      settingsRows.map((row) => [
        row.org_id,
        {
          notificationEmail: row.notification_email,
          discordWebhook: row.discord_webhook,
          emailOnOpen: row.email_on_open,
          emailOnResolve: row.email_on_resolve,
          alertCooldownMinutes: row.alert_cooldown_minutes,
        },
      ]),
    )

    for (const incident of due) {
      const monitor = monitorById.get(incident.monitor_id)!
      const settings = settingsByOrg.get(monitor.org_id)
      if (!settings) continue
      try {
        const { attempted } = await notifyIncidentEvent(
          settings,
          { name: monitor.name, url: monitor.url },
          'open',
          { occurredAtIso: incident.opened_at, lastNotifiedAtIso: null },
        )
        if (!attempted) continue
        counts.caughtUp++
        // Stamping is what stops the same incident catching up again on the
        // next sweep: last_notified_at is now inside no window.
        const { error: stampError } = await db
          .from('incidents')
          .update({ last_notified_at: new Date().toISOString() })
          .eq('id', incident.id)
        if (stampError) {
          logError('cron.incidents.stamp_failed', 'failed', {
            error: stampError.message,
          })
        }
      } catch (err) {
        counts.failed++
        logError('cron.suppression.catchup_failed', 'failed', {
          error: errorName(err),
        })
      }
    }
  } catch (err) {
    counts.failed++
    logError('cron.suppression.catchup_failed', 'failed', { error: errorName(err) })
  }
  return counts
}

// ---------------------------------------------------------------------------
// The daily digest. One email per org per day, at the time the org chose, in
// the org's own timezone. It rides THIS sweep: no new scheduler, no new cron
// entry, no queue. Every 5 minutes the sweep asks which orgs have it enabled,
// whose local clock has reached their chosen time, and who has not already
// been sent today.
//
// Failure discipline is the F10 rule, unchanged: never throw. One org's
// gather, compose, or send failure is logged and swallowed, so it cannot
// touch another org's digest, the monitor checks, or this route's response. A
// send that fails does NOT stamp the ledger, so the next sweep five minutes
// later tries the same org again.
//
// Content rule (ruling 5): titles, names, counts, ages, and links only. The
// queries below select no ticket description, no comment body, and no
// inventory notes, so there is no content in memory for the email to carry.

type DigestSettingsRow = {
  org_id: string
  notification_email: string | null
  digest_send_time: string
  digest_last_sent_on: string | null
}

/**
 * Everything one org's digest reports. Service role reads, so RLS is bypassed
 * and every query is explicitly scoped by org_id: that eq() IS the tenant
 * boundary here, exactly as it is everywhere else in this route.
 *
 * The two ticket sections are disjoint on purpose. A ticket that arrived
 * inside this digest's window is reported as new; one that arrived before it
 * and is still unanswered is reported as waiting. Without the split the same
 * overnight ticket would appear twice in one email under two headings.
 */
async function gatherDigestData(
  db: Db,
  orgId: string,
  windowStartMs: number,
  nowMs: number,
  timeZone: string,
): Promise<DigestData> {
  const [incidentsRes, suppressedRes, certsRes, ticketsRes, inventoryRes] = await Promise.all([
    // RULING: the digest ALWAYS shows open incidents, maintenance windows or
    // not. A window silences the system interrupting; the digest is the
    // person asking, and the answer they get is the truth.
    db
      .from('incidents')
      .select('id, opened_at, monitors(name)')
      .eq('org_id', orgId)
      .eq('status', 'open')
      .order('opened_at', { ascending: true }),
    // Monitors whose alerts are currently paused: the morning email is what
    // surfaces a forgotten window.
    db
      .from('monitors')
      .select('id, name, suppress_until')
      .eq('org_id', orgId)
      .not('suppress_until', 'is', null)
      .gt('suppress_until', new Date(nowMs).toISOString())
      .order('suppress_until', { ascending: true }),
    // Active monitors only: a paused monitor's stored expiry goes stale the
    // moment checks stop, and stale certainty is worse than silence.
    db
      .from('monitors')
      .select('id, name, cert_expires_at')
      .eq('org_id', orgId)
      .eq('active', true)
      .not('cert_expires_at', 'is', null),
    db
      .from('tickets')
      .select('id, title, submitted_by, created_at')
      .eq('org_id', orgId)
      .in('status', ['open', 'in_progress']),
    db
      .from('inventory_items')
      .select('id, name, quantity, min_stock')
      .eq('org_id', orgId),
  ])
  if (incidentsRes.error) throw new Error(incidentsRes.error.message)
  if (certsRes.error) throw new Error(certsRes.error.message)
  if (suppressedRes.error) throw new Error(suppressedRes.error.message)
  if (ticketsRes.error) throw new Error(ticketsRes.error.message)
  if (inventoryRes.error) throw new Error(inventoryRes.error.message)

  const suppressedMonitors = suppressedRes.data.map((m) => ({
    monitorId: m.id,
    monitorName: m.name,
    untilLabel: zonedMinuteLabel(Date.parse(m.suppress_until!), timeZone),
  }))

  // Certificates inside the 14 day warning window, soonest first; expired
  // ones are negative and sort to the top, which is where they belong.
  const expiringCertificates = certsRes.data
    .map((m) => ({
      monitorId: m.id,
      monitorName: m.name,
      daysLeft: certDaysLeft(m.cert_expires_at!, nowMs, timeZone),
    }))
    .filter((c) => c.daysLeft <= 14)
    .sort((a, b) => a.daysLeft - b.daysLeft)

  const tickets = ticketsRes.data
  const ticketIds = tickets.map((t) => t.id)

  // The trail behind every unsettled ticket, in two queries rather than two
  // per ticket. Note the columns: author and timestamps, never a body.
  //
  // is_internal false is filtered HERE and not left to RLS, because this runs
  // on the service role and RLS is not in the room. An internal note is not
  // something the requester can read, so it cannot count as somebody having
  // answered them; letting one through would silently drop a waiting ticket
  // out of the digest (migration 019).
  const trailByTicket = new Map<string, DigestTrailItem[]>()
  if (ticketIds.length > 0) {
    const [commentsRes, eventsRes] = await Promise.all([
      db
        .from('ticket_comments')
        .select('ticket_id, author, created_at, is_internal')
        .eq('is_internal', false)
        .in('ticket_id', ticketIds),
      db
        .from('ticket_events')
        .select('ticket_id, occurred_at')
        .in('ticket_id', ticketIds),
    ])
    if (commentsRes.error) throw new Error(commentsRes.error.message)
    if (eventsRes.error) throw new Error(eventsRes.error.message)

    for (const id of ticketIds) {
      trailByTicket.set(
        id,
        // The shared tickets logic decides what a trail is and how it orders;
        // the digest only reads the result.
        interleaveTrail(
          commentsRes.data.filter((c) => c.ticket_id === id),
          eventsRes.data.filter((e) => e.ticket_id === id),
        ),
      )
    }
  }

  const awaiting: DigestTicket[] = []
  const arrived: DigestTicket[] = []
  for (const ticket of tickets) {
    const createdMs = Date.parse(ticket.created_at)
    if (createdMs >= windowStartMs) {
      arrived.push({
        ticketId: ticket.id,
        title: ticket.title,
        sinceIso: ticket.created_at,
      })
      continue
    }
    const trail = trailByTicket.get(ticket.id) ?? []
    if (!isAwaitingReply(ticket.submitted_by, trail)) continue
    awaiting.push({
      ticketId: ticket.id,
      title: ticket.title,
      sinceIso: new Date(
        waitingSinceMs(
          { submittedBy: ticket.submitted_by, createdAtIso: ticket.created_at },
          trail,
        ),
      ).toISOString(),
    })
  }
  // Longest wait first in both: the top of the email is the top of the queue.
  awaiting.sort((a, b) => Date.parse(a.sinceIso) - Date.parse(b.sinceIso))
  arrived.sort((a, b) => Date.parse(a.sinceIso) - Date.parse(b.sinceIso))

  // Low stock is derived, never stored (F15 ruling 2), so it is the F15
  // helper that decides, not a repeated comparison here.
  const lowStock = inventoryRes.data
    .filter((item) => isLowStock({ quantity: item.quantity, min_stock: item.min_stock }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => ({
      itemId: item.id,
      name: item.name,
      quantity: item.quantity,
      minStock: item.min_stock,
    }))

  return {
    openIncidents: digestSection(
      incidentsRes.data.map((incident) => ({
        incidentId: incident.id,
        monitorName: incident.monitors?.name ?? 'Deleted monitor',
        openedAtIso: incident.opened_at,
      })),
    ),
    expiringCertificates: digestSection(expiringCertificates),
    suppressedMonitors: digestSection(suppressedMonitors),
    awaitingReply: digestSection(awaiting),
    newTickets: digestSection(arrived),
    lowStock: digestSection(lowStock),
  }
}

/**
 * Sends every digest that is due at this instant. Returns counts only; no
 * tenant data, no addresses, and no subject lines are ever logged.
 *
 * Settings are fetched once for the whole run (the F10 batching idiom), and
 * the org timezones they depend on in one more query, so the cost of the
 * digest on a sweep where nothing is due is two reads.
 */
async function runDailyDigests(
  db: Db,
  nowMs: number,
  baseUrl: string,
): Promise<{ due: number; sent: number; quiet: number; failed: number }> {
  const counts = { due: 0, sent: 0, quiet: 0, failed: 0 }

  const { data: rows, error } = await db
    .from('org_notification_settings')
    .select('org_id, notification_email, digest_send_time, digest_last_sent_on')
    .eq('digest_enabled', true)
  if (error) {
    logError('cron.digest.settings_failed', 'failed', { error: error.message })
    return counts
  }
  // Ruling 4: the recipient is the org's notification email. With nowhere to
  // send it, there is nothing to do and nothing to stamp.
  const enabled = (rows as DigestSettingsRow[])
    .map((row) => ({ row, to: (row.notification_email ?? '').trim() }))
    .filter((entry) => entry.to !== '')
  if (enabled.length === 0) return counts

  // The entitlement gate (F13 PR 3): the daily digest is a paid feature
  // (Basic and up, the recorded packaging decision). One batched read over
  // org_billing for the enabled orgs; an org with no row is free by
  // definition and is skipped. Skipping happens BEFORE the due check and the
  // stamp, so a gated org is never counted due and its ledger never moves:
  // the day an org upgrades, that morning's digest is still owed and sends.
  const { data: billingRows, error: billingError } = await db
    .from('org_billing')
    .select('*')
    .in('org_id', enabled.map((entry) => entry.row.org_id))
  if (billingError) {
    logError('cron.digest.entitlements_failed', 'failed', { error: billingError.message })
    return counts
  }
  const billingByOrg = new Map((billingRows ?? []).map((b) => [b.org_id, b]))
  const entitled = enabled.filter(
    (entry) => resolveEntitlements(billingByOrg.get(entry.row.org_id)).dailyDigest,
  )
  if (entitled.length === 0) return counts

  // organizations.timezone is the F11 authority (migration 012). An org that
  // has not had one detected yet falls back to the same default the rest of
  // the app uses, so the digest never waits on a zone to exist.
  const zoneByOrg = new Map<string, string>()
  const { data: orgs, error: orgsError } = await db
    .from('organizations')
    .select('id, timezone')
    .in('id', entitled.map((entry) => entry.row.org_id))
  if (orgsError) {
    logError('cron.digest.timezones_failed', 'failed', { error: orgsError.message })
    return counts
  }
  for (const org of orgs) {
    zoneByOrg.set(org.id, org.timezone ?? DEFAULT_TIMEZONE)
  }

  for (const { row, to } of entitled) {
    const schedule: DigestSchedule = {
      timeZone: zoneByOrg.get(row.org_id) ?? DEFAULT_TIMEZONE,
      sendTime: row.digest_send_time,
      lastSentOn: row.digest_last_sent_on,
    }
    const { due, today } = digestDueCheck(schedule, nowMs)
    if (!due) continue
    counts.due++

    try {
      const data = await gatherDigestData(
        db,
        row.org_id,
        digestWindowStartMs(schedule, nowMs),
        nowMs,
        schedule.timeZone,
      )
      const email = composeDigest(data, { baseUrl, nowMs })

      // The quiet day ruling: composition returned nothing, so nothing is
      // sent. The ledger IS still stamped, because today's digest is settled.
      // Leaving it unstamped would mean the next sweep asks again, and an
      // incident opening at two in the afternoon would fire a "your day"
      // email in the afternoon. Alerting on that is the incident alert's job;
      // the digest is a morning briefing and stays one.
      if (email === null) {
        counts.quiet++
        await stampDigestSent(db, row.org_id, today)
        continue
      }

      // sendAlertEmailResult, not sendAlertEmail: the fire and forget sender
      // swallows provider failures, which would let a failed send stamp the
      // ledger and lose the day's digest silently. Reporting the outcome is
      // what makes "a failed send is retried on the next sweep" true.
      const result = await sendAlertEmailResult({
        to,
        subject: email.subject,
        text: email.text,
      })
      if (!result.ok) {
        counts.failed++
        logError('cron.digest.send_failed', 'rejected', { reason: result.reason })
        continue
      }
      counts.sent++
      await stampDigestSent(db, row.org_id, today)
    } catch (err) {
      // Swallowed on purpose: an unstamped ledger means the next sweep
      // retries this org, and no other org is affected.
      counts.failed++
      logError('cron.digest.org_failed', 'failed', { error: errorName(err) })
    }
  }

  return counts
}

/** The dedup ledger write. Service role only; no user session can touch it. */
async function stampDigestSent(db: Db, orgId: string, today: string): Promise<void> {
  const { error } = await db
    .from('org_notification_settings')
    .update({ digest_last_sent_on: today })
    .eq('org_id', orgId)
  if (error) {
    logError('cron.digest.stamp_failed', 'failed', { error: error.message })
  }
}

/**
 * The daily Azure cost pull (BRD F23), riding the sweep the way the digest
 * does: no new scheduler, no new cron entry. A connection is due once per
 * UTC day, measured from last_pull_at, which stamps on every ATTEMPT so a
 * failing credential costs one Azure call a day, not one per sweep. Each
 * pull is one token request and one Cost Management query, one attempt, no
 * retries (the platform key resilience rule); a failure stamps
 * last_pull_status and is swallowed, because a tenant's expired credential
 * must never fail the sweep and is never an incident. The org's admin sees
 * the truth on the cloud costs screen, not a fake zero.
 *
 * The entitlement gate runs BEFORE any Azure call (the digest construction):
 * cloud cost monitoring is Business only, and a lapsed plan stops spending
 * Azure quota immediately. The credential row itself stays, so upgrading
 * again resumes pulls without a reconnect.
 */
async function runAzureCostPulls(
  db: Db,
  nowMs: number,
): Promise<{ due: number; pulled: number; failed: number }> {
  const counts = { due: 0, pulled: 0, failed: 0 }

  const { data: rows, error } = await db
    .from('azure_connections')
    .select('id, org_id, subscription_id, tenant_id, client_id, last_pull_at')
  if (error) {
    logError('cron.azure.list_failed', 'failed', { error: error.message })
    return counts
  }
  const due = (rows ?? []).filter((row) => azurePullDue(row.last_pull_at, nowMs))
  if (due.length === 0) return counts

  const { data: billingRows, error: billingError } = await db
    .from('org_billing')
    .select('*')
    .in('org_id', [...new Set(due.map((row) => row.org_id))])
  if (billingError) {
    logError('cron.azure.list_failed', 'failed', { error: billingError.message })
    return counts
  }
  const billingByOrg = new Map((billingRows ?? []).map((b) => [b.org_id, b]))
  const entitled = due.filter(
    (row) => resolveEntitlements(billingByOrg.get(row.org_id)).cloudCosts,
  )

  const range = azurePullRange(nowMs)
  for (const connection of entitled) {
    counts.due++
    const attemptedAt = new Date().toISOString()
    try {
      const secret = await readConnectionSecret(connection.id)
      // Disconnected between the list and the pull: nothing to do, and
      // nothing to stamp on a row that no longer exists.
      if (secret === null) continue
      const token = await acquireAzureToken({
        tenantId: connection.tenant_id,
        clientId: connection.client_id,
        clientSecret: secret,
      })
      const entries = await queryDailyCosts({
        subscriptionId: connection.subscription_id,
        accessToken: token,
        from: range.from,
        to: range.to,
      })
      const rollups = rollupDailyCosts(entries).map((rollup) => ({
        org_id: connection.org_id,
        subscription_id: connection.subscription_id,
        ...rollup,
      }))
      // Zero rows is a legitimate answer (a brand new subscription with no
      // spend yet); the pull still succeeded and stamps as ok.
      if (rollups.length > 0) {
        const { error: upsertError } = await db
          .from('azure_daily_costs')
          .upsert(rollups, { onConflict: 'org_id,subscription_id,day' })
        if (upsertError) throw new Error(upsertError.message)
      }
      await stampAzurePull(db, connection.id, {
        last_pull_at: attemptedAt,
        last_pull_status: 'ok',
        last_success_at: attemptedAt,
      })
      counts.pulled++
    } catch (err) {
      // Swallowed on purpose: one connection's refusal affects no other
      // connection and never the sweep. Name only, never a tenant or
      // subscription identifier (the log.ts rule).
      counts.failed++
      logError('azure.pull.failed', 'failed', { error: errorName(err) })
      await stampAzurePull(db, connection.id, {
        last_pull_at: attemptedAt,
        last_pull_status: 'failed',
      })
    }
  }
  return counts
}

/** The pull ledger write. Service role only; no user session holds a write
 * grant on any of these columns (migration 026). */
async function stampAzurePull(
  db: Db,
  connectionId: string,
  columns: { last_pull_at: string; last_pull_status: 'ok' | 'failed'; last_success_at?: string },
): Promise<void> {
  const { error } = await db
    .from('azure_connections')
    .update(columns)
    .eq('id', connectionId)
  if (error) {
    logError('cron.azure.stamp_failed', 'failed', { error: error.message })
  }
}

/**
 * The origin to build dashboard links from, taken from the request the
 * scheduler made, the same way the status page settings screen derives the
 * public status URL. The route is bearer token protected, so the only caller
 * able to influence this header is one that already holds CRON_SECRET.
 */
function requestBaseUrl(request: Request): string {
  const url = new URL(request.url)
  const host = request.headers.get('host') ?? url.host
  const proto = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https'
  return `${proto}://${host}`
}

/**
 * Records that the sweep ran (migration 018). This is what makes a dead
 * scheduler visible: without it, every screen keeps rendering its last values
 * and the product reports health from data that stopped updating, which is
 * the failure this table exists for.
 *
 * Wrapped so it can never fail the sweep. A heartbeat write that throws would
 * turn an observability feature into an outage, and the checks and incident
 * writes above have already succeeded by the time this runs. A missed stamp
 * costs one interval of freshness and the next sweep corrects it.
 */
async function stampHeartbeat(db: Db, startedMs: number, stepFailures: number): Promise<void> {
  const ranAt = new Date().toISOString()
  try {
    const { error } = await db
      .from('platform_heartbeat')
      .update({
        last_run_at: ranAt,
        // Only a clean sweep advances last_success_at, so a sweep that keeps
        // running with a failing step is visibly distinct from a healthy one.
        ...(stepFailures === 0 ? { last_success_at: ranAt } : {}),
        // run_count is not sent: the trigger on this table increments it, so
        // there is no read before write and no lost update.
        step_failures: stepFailures,
        duration_ms: Date.now() - startedMs,
      })
      .eq('id', 'sweep')
    // Reported: a heartbeat that stops being written makes the external
    // watcher go red, so the operator should know it was the stamp that broke
    // rather than the sweep.
    if (error) {
      logError(
        'cron.heartbeat.stamp_failed',
        'failed',
        { error: error.message },
        { report: true },
      )
    }
  } catch (err) {
    logError(
      'cron.heartbeat.stamp_failed',
      'failed',
      { error: errorName(err) },
      { report: true },
    )
  }
}

/**
 * Two windows on this endpoint, for two different problems.
 *
 * Unauthorized attempts are limited per IP so the bearer check is not an
 * unlimited guessing oracle. The real scheduler presents a valid token twelve
 * times an hour and never touches this counter, so ten a minute costs it
 * nothing while making a brute force slow enough to be pointless.
 *
 * Authorized invocations are limited globally because a valid token is not a
 * licence to start unbounded concurrent sweeps: each one holds a service role
 * client and runs for up to sixty seconds, so a misconfigured scheduler firing
 * in a loop would stack them against the database.
 */
const unauthorizedWindow = createSlidingWindow({ max: 10, windowMs: 60_000 })
const authorizedWindow = createSlidingWindow({ max: 20, windowMs: 60_000 })

async function runSweep(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    // Counted only on failure, and before any database work: a refused caller
    // must never be able to make this route open a client.
    const attempt = unauthorizedWindow.check(clientIp(request.headers))
    if (!attempt.allowed) {
      return NextResponse.json({ error: 'too many requests' }, { status: 429 })
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (!authorizedWindow.check('sweep').allowed) {
    return NextResponse.json({ error: 'too many requests' }, { status: 429 })
  }

  const db = createAdminClient()

  const { data: monitors, error: monitorsError } = await db
    .from('monitors')
    .select(
      'id, org_id, name, url, interval_seconds, last_checked_at, failing_since, cert_expires_at, cert_alerted_threshold, suppress_until, suppress_set_at',
    )
    .eq('active', true)
  if (monitorsError) {
    logError('cron.monitors.list_failed', 'failed', { error: monitorsError.message })
    return NextResponse.json({ error: 'monitor listing failed' }, { status: 500 })
  }

  // Due when never checked, or when the monitor's own interval has elapsed.
  // Filtered here rather than in SQL because PostgREST cannot compare two
  // columns; the monitor counts this sweeps stay small in Phase 1.
  const now = Date.now()
  const due = monitors.filter(
    (m) =>
      m.last_checked_at === null ||
      now - Date.parse(m.last_checked_at) >= m.interval_seconds * 1000,
  )

  // One query answers "which due monitors have an open incident" for the
  // whole sweep; each monitor appears at most once per sweep, so the map
  // cannot go stale within it.
  const openIncidentByMonitor = new Map<string, string>()
  if (due.length > 0) {
    const { data: openIncidents, error: openError } = await db
      .from('incidents')
      .select('id, monitor_id')
      .in('monitor_id', due.map((m) => m.id))
      .eq('status', 'open')
    if (openError) {
      logError('cron.incidents.list_failed', 'failed', { error: openError.message })
      return NextResponse.json({ error: 'incident listing failed' }, { status: 500 })
    }
    for (const incident of openIncidents) {
      openIncidentByMonitor.set(incident.monitor_id, incident.id)
    }
  }

  // Notification settings, fetched once per sweep for every org with a due
  // monitor (batched, never per monitor). A fetch failure only silences
  // notifications for this sweep; the checks and incident writes proceed.
  // Org timezones ride the same batch: certificate day math runs in the org's
  // zone (the F11 authority, same fallback the digest uses), and a zone fetch
  // failure only defaults the day math for this sweep.
  const settingsByOrg = new Map<string, NotifyChannelSettings>()
  const zoneByOrg = new Map<string, string>()
  if (due.length > 0) {
    const orgIds = [...new Set(due.map((m) => m.org_id))]
    const [settingsRes, orgsRes] = await Promise.all([
      db
        .from('org_notification_settings')
        .select(
          'org_id, notification_email, discord_webhook, email_on_open, email_on_resolve, alert_cooldown_minutes',
        )
        .in('org_id', orgIds),
      db.from('organizations').select('id, timezone').in('id', orgIds),
    ])
    if (settingsRes.error) {
      logError('cron.settings.list_failed', 'failed', { error: settingsRes.error.message })
    } else {
      for (const row of settingsRes.data) {
        settingsByOrg.set(row.org_id, {
          notificationEmail: row.notification_email,
          discordWebhook: row.discord_webhook,
          emailOnOpen: row.email_on_open,
          emailOnResolve: row.email_on_resolve,
          alertCooldownMinutes: row.alert_cooldown_minutes,
        })
      }
    }
    if (orgsRes.error) {
      logError('cron.timezones.list_failed', 'failed', { error: orgsRes.error.message })
    } else {
      for (const org of orgsRes.data) {
        zoneByOrg.set(org.id, org.timezone ?? DEFAULT_TIMEZONE)
      }
    }
  }

  let up = 0
  let down = 0
  const incidentCounts = { opened: 0, reopened: 0, resolved: 0 }
  const failures: string[] = []

  for (let i = 0; i < due.length; i += BATCH_SIZE) {
    const batch = due.slice(i, i + BATCH_SIZE)
    const outcomes = await Promise.all(
      batch.map(async (monitor) => ({
        monitor,
        outcome: await runMonitorCheck(monitor.url),
      })),
    )

    const checkedAt = new Date().toISOString()
    const { data: checkRows, error: insertError } = await db
      .from('monitor_checks')
      .insert(
        outcomes.map(({ monitor, outcome }) => ({
          monitor_id: monitor.id,
          org_id: monitor.org_id,
          checked_at: checkedAt,
          status: outcome.status,
          response_time_ms: outcome.responseTimeMs,
          error_message: outcome.errorMessage,
        })),
      )
      .select('id, monitor_id')
    if (insertError) {
      failures.push(`recording checks: ${insertError.message}`)
      continue
    }
    const checkIdByMonitor = new Map(
      checkRows.map((c) => [c.monitor_id, c.id]),
    )

    for (const { monitor, outcome } of outcomes) {
      if (outcome.status === 'up') up++
      else down++

      // The engine needs the monitor's most recent resolved incident only
      // when this check confirms a failure; that lookup is rare, so it runs
      // lazily here instead of joining for every monitor in the sweep.
      const openIncidentId = openIncidentByMonitor.get(monitor.id) ?? null
      let lastResolved: EngineState['lastResolved'] = null
      if (
        outcome.status === 'down' &&
        monitor.failing_since !== null &&
        openIncidentId === null
      ) {
        const { data: recent, error: recentError } = await db
          .from('incidents')
          .select('id, resolved_at')
          .eq('monitor_id', monitor.id)
          .eq('status', 'resolved')
          .order('resolved_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (recentError) {
          failures.push(`reading last incident: ${recentError.message}`)
          continue
        }
        if (recent?.resolved_at) {
          lastResolved = { incidentId: recent.id, resolvedAt: recent.resolved_at }
        }
      }

      const action = decide(
        {
          failingSince: monitor.failing_since,
          openIncidentId,
          lastResolved,
        },
        {
          id: checkIdByMonitor.get(monitor.id)!,
          status: outcome.status,
          checkedAt,
        },
      )

      let failingSince: string | null | undefined
      try {
        const applied = await applyIncidentAction(
          db,
          monitor,
          action,
          settingsByOrg.get(monitor.org_id),
        )
        failingSince = applied.failingSince
        if (applied.counted) incidentCounts[applied.counted]++
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err))
        // Leave failing_since untouched so the next sweep re-decides from
        // the same state rather than losing the pending confirmation.
        failingSince = undefined
      }

      // Certificate expiry, after the incident work: warnings ride the same
      // sweep and fold their ledger into the same status update below.
      const certColumns = await evaluateCertExpiry(
        monitor,
        outcome.certExpiresAt,
        now,
        zoneByOrg.get(monitor.org_id) ?? DEFAULT_TIMEZONE,
        settingsByOrg.get(monitor.org_id),
      )

      const { error: updateError } = await db
        .from('monitors')
        .update({
          last_checked_at: checkedAt,
          last_status: outcome.status,
          ...(failingSince !== undefined ? { failing_since: failingSince } : {}),
          ...certColumns,
        })
        .eq('id', monitor.id)
      if (updateError) {
        failures.push(`updating monitor status: ${updateError.message}`)
      }
    }
  }

  // Retention: raw rows expire after 30 days; the rollups keep the history.
  // incident_events.check_id references go NULL with the pruned rows; the
  // timeline itself is permanent.
  const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const { error: pruneError } = await db
    .from('monitor_checks')
    .delete()
    .lt('checked_at', cutoff.toISOString())
  if (pruneError) {
    failures.push(`pruning: ${pruneError.message}`)
  }

  // Recompute today's rollups, and yesterday's too so the sweep straddling
  // the UTC day boundary finalizes the previous day.
  for (const day of [utcDay(new Date()), utcDay(new Date(now - 24 * 60 * 60 * 1000))]) {
    const { error: rollupError } = await db.rpc('upsert_monitor_daily_rollups', {
      p_day: day,
    })
    if (rollupError) {
      failures.push(`rollup ${day}: ${rollupError.message}`)
    }
  }

  // No ticket step here any more. Migration 019 retired the 7 day auto close
  // along with the closed state; the sweep writes nothing to tickets at all
  // now, which is why nothing below counts them.

  // Maintenance window catch up, before the digest so a caught up incident
  // is already stamped when the digest reads the day. Never fails the sweep.
  const catchUp = await runSuppressionCatchUp(db, now)

  // The daily digest, last: it reads what the work above has just settled, and
  // it can never fail the sweep. Its own errors are counted and logged inside.
  const digests = await runDailyDigests(db, now, requestBaseUrl(request))

  // The daily Azure cost pull (BRD F23). Same posture as the digest: rides
  // the sweep, cannot fail it, and a tenant's refused credential is that
  // org's staleness banner, never the operator's page.
  const azure = await runAzureCostPulls(db, now)

  if (failures.length > 0) {
    // Reported to the operator channel: this is the platform failing, not one
    // org's configuration, and it is the aggregate rather than the per org
    // noise, so it cannot page every five minutes for a single bad setting.
    logError(
      'cron.sweep.steps_failed',
      'failed',
      { steps: failures.length, reasons: failures.join('; ') },
      { report: true },
    )
  }
  // The heartbeat, after everything else and before the response. A sweep
  // that got this far ran, whether or not every step inside it succeeded, and
  // that distinction is exactly what last_run_at and last_success_at carry.
  await stampHeartbeat(db, now, failures.length)

  logInfo('cron.sweep.complete', failures.length > 0 ? 'failed' : 'ok', {
    active: monitors.length,
    due: due.length,
    up,
    down,
    incidents_opened: incidentCounts.opened,
    incidents_reopened: incidentCounts.reopened,
    incidents_resolved: incidentCounts.resolved,
    suppression_caught_up: catchUp.caughtUp,
    suppression_failed: catchUp.failed,
    digests_due: digests.due,
    digests_sent: digests.sent,
    digests_quiet: digests.quiet,
    digests_failed: digests.failed,
    azure_due: azure.due,
    azure_pulled: azure.pulled,
    azure_failed: azure.failed,
  })

  return NextResponse.json({
    active: monitors.length,
    checked: due.length,
    up,
    down,
    incidents: incidentCounts,
    digests,
    azure,
    failures: failures.length,
  })
}

// The scheduler contract is POST (decision log 2026-07-27). GET stays for
// manual invocation and for anything still holding the old contract; both
// require the same bearer token and run the same sweep.
export async function GET(request: Request) {
  return runSweep(request)
}

export async function POST(request: Request) {
  return runSweep(request)
}
