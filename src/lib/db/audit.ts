import { createOrgScopedClient } from './client'
import type { AuditAction, AuditEntry } from './types'

/**
 * Typed data layer for the audit log (BRD F12, CLAUDE.md code rule 7). The
 * log is written ONLY by SECURITY DEFINER triggers in the database (migration
 * 013); nothing in the application can write it, including this module. RLS
 * makes reading admin only and org scoped before any code here sees a row, so
 * for a member every query below simply returns nothing.
 *
 * The pure helpers translate stored rows into the sentences the audit screen
 * shows. They are display only: a wrong label can misdescribe an action but
 * can never change what the database recorded or who may read it.
 */

/** Everything migration 013 allows in audit_log.action, for the unit tests
 * and the screen. Extending the vocabulary means a migration plus this list
 * plus a label below, and the tests fail loudly when the three drift. */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'member_role_changed',
  'api_key_added',
  'api_key_replaced',
  'api_key_deleted',
  'monitor_deleted',
  'status_page_enabled',
  'status_page_disabled',
  'status_page_slug_changed',
  'timezone_changed',
  'notification_settings_changed',
  'article_created',
  'article_published',
  'article_unpublished',
  'article_updated',
  'article_deleted',
  'member_tags_changed',
  'inventory_item_created',
  'inventory_item_updated',
  'inventory_item_deleted',
  'ticket_status_changed',
  'ticket_canceled',
  'ticket_reopened',
  'azure_connected',
  'azure_disconnected',
  'azure_budget_changed',
]

const ACTION_LABELS: Record<AuditAction, string> = {
  member_role_changed: 'Member role changed',
  api_key_added: 'AI provider key added',
  api_key_replaced: 'AI provider key replaced',
  api_key_deleted: 'AI provider key deleted',
  monitor_deleted: 'Monitor deleted',
  status_page_enabled: 'Status page enabled',
  status_page_disabled: 'Status page disabled',
  status_page_slug_changed: 'Status page slug changed',
  timezone_changed: 'Usage timezone changed',
  notification_settings_changed: 'Notification settings changed',
  article_created: 'Article created',
  article_published: 'Article published',
  article_unpublished: 'Article unpublished',
  article_updated: 'Article updated',
  article_deleted: 'Article deleted',
  member_tags_changed: 'Member tags changed',
  inventory_item_created: 'Inventory item added',
  inventory_item_updated: 'Inventory item updated',
  inventory_item_deleted: 'Inventory item deleted',
  ticket_status_changed: 'Ticket status changed',
  ticket_canceled: 'Ticket canceled',
  ticket_reopened: 'Ticket reopened',
  azure_connected: 'Azure subscription connected',
  azure_disconnected: 'Azure subscription disconnected',
  azure_budget_changed: 'Azure budget changed',
}

/** Human label for an action. Unknown values (a newer vocabulary than this
 * build, mid deploy) fall back to the raw action rather than crashing. */
export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action as AuditAction] ?? action
}

/** A detail value when it is a plain string, else null. The detail column is
 * jsonb and this layer never trusts its shape blindly. */
function detailString(detail: AuditEntry['detail'], key: string): string | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    return null
  }
  const value = detail[key]
  return typeof value === 'string' ? value : null
}

/** A detail value when it is an array of strings, else null. */
function detailStrings(detail: AuditEntry['detail'], key: string): string[] | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    return null
  }
  const value = detail[key]
  if (!Array.isArray(value)) return null
  return value.every((v) => typeof v === 'string') ? (value as string[]) : null
}

/** The changed field names a settings row carries, as prose. Field names are
 * the whole detail by design: values are configuration, not audit facts. */
function changedFieldsSummary(detail: AuditEntry['detail']): string {
  const changed = detailStrings(detail, 'changed')
  if (!changed || changed.length === 0) return ''
  return changed.map((f) => f.replaceAll('_', ' ')).join(', ')
}

/**
 * The one line of supporting facts under an action label, built from the
 * structured detail the trigger recorded. Falls back to nothing rather than
 * rendering raw JSON at a user.
 */
export function auditDetailSummary(entry: {
  action: string
  detail: AuditEntry['detail']
}): string {
  switch (entry.action) {
    case 'member_role_changed': {
      const oldRole = detailString(entry.detail, 'old_role')
      const newRole = detailString(entry.detail, 'new_role')
      return oldRole && newRole ? `${oldRole} to ${newRole}` : ''
    }
    case 'api_key_added':
    case 'api_key_replaced':
    case 'api_key_deleted': {
      const provider = detailString(entry.detail, 'provider')
      const lastFour = detailString(entry.detail, 'key_last_four')
      if (!provider) return ''
      return lastFour ? `${provider}, ending ${lastFour}` : provider
    }
    case 'monitor_deleted':
      return detailString(entry.detail, 'name') ?? ''
    case 'status_page_enabled':
    case 'status_page_disabled':
    case 'status_page_slug_changed':
    case 'timezone_changed':
    case 'notification_settings_changed':
      return changedFieldsSummary(entry.detail)
    case 'article_created':
    case 'article_published':
    case 'article_unpublished':
    case 'article_deleted':
      return detailString(entry.detail, 'title') ?? ''
    case 'inventory_item_created':
    case 'inventory_item_deleted':
      return detailString(entry.detail, 'name') ?? ''
    case 'inventory_item_updated': {
      const name = detailString(entry.detail, 'name')
      const changed = detailStrings(entry.detail, 'changed')
      if (!name) return ''
      if (!changed || changed.length === 0) return name
      return `${name} (${changed.map((f) => f.replaceAll('_', ' ')).join(', ')})`
    }
    case 'article_updated': {
      const title = detailString(entry.detail, 'title')
      const changed = detailStrings(entry.detail, 'changed')
      if (!title) return ''
      if (!changed || changed.length === 0) return title
      return `${title} (${changed.map((f) => f.replaceAll('_', ' ')).join(', ')})`
    }
    // Statuses and who kind of person did it. Never the title, never a
    // comment, never a note: the log records that a transition happened, not
    // what anybody wrote about it (migration 019).
    case 'ticket_status_changed':
    case 'ticket_canceled':
    case 'ticket_reopened': {
      const from = detailString(entry.detail, 'from')
      const to = detailString(entry.detail, 'to')
      const kind = detailString(entry.detail, 'actor_kind')
      const move =
        from && to
          ? `${from.replaceAll('_', ' ')} to ${to.replaceAll('_', ' ')}`
          : ''
      const by = kind === 'member' ? 'by the requester' : kind === 'system' ? 'by Talvext' : ''
      return [move, by].filter(Boolean).join(', ')
    }
    // The subscription id is an identifier the connections screen already
    // shows. The budget change carries the field name alone, never the
    // amount: values are configuration, not audit facts (migration 026).
    case 'azure_connected':
    case 'azure_disconnected':
      return detailString(entry.detail, 'subscription_id') ?? ''
    case 'azure_budget_changed': {
      const subscription = detailString(entry.detail, 'subscription_id')
      const changed = changedFieldsSummary(entry.detail)
      if (!subscription) return changed
      return changed ? `${subscription} (${changed})` : subscription
    }
    case 'member_tags_changed': {
      const tags = detailStrings(entry.detail, 'tags')
      if (!tags) return ''
      return tags.length === 0 ? 'all tags removed' : tags.join(', ')
    }
    default:
      return ''
  }
}

/** The Clerk user id of the person an action was done TO, when the action has
 * a target (today: role changes). The screen resolves it to a name. */
export function auditTargetUserId(entry: {
  action: string
  detail: AuditEntry['detail']
}): string | null {
  if (entry.action !== 'member_role_changed' && entry.action !== 'member_tags_changed') {
    return null
  }
  return detailString(entry.detail, 'target_user_id')
}

/**
 * The most recent audit entries this session may see: for an org admin their
 * org's log newest first, for anyone else nothing, both enforced by RLS.
 */
export async function listAuditLog(limit = 200): Promise<AuditEntry[]> {
  const { client } = await createOrgScopedClient()
  const { data, error } = await client
    .from('audit_log')
    .select()
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data
}
