import 'server-only'

import { createClient } from '@supabase/supabase-js'

import type { Database } from './types'

/**
 * The service role client cannot be built because its env var is missing. A
 * deployment configuration problem, not a user error: thrown so callers (the
 * chat route) can tell it apart from a real failure and say so honestly.
 */
export class AdminConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdminConfigError'
  }
}

/**
 * Service role client. BYPASSES ROW LEVEL SECURITY ENTIRELY.
 *
 * Permitted callers, exhaustively:
 *   - src/app/api/webhooks/clerk/route.ts  (syncing Clerk orgs and members;
 *     webhooks carry no user session, so there is no token to scope by)
 *   - src/app/api/cron/check-monitors/route.ts  (the cron sweep; cron
 *     invocations carry no user session either, and it must write check
 *     results and rollups across every org in one pass)
 *   - src/lib/chat/key-vault.ts  (reads and decrypts an org's provider key at
 *     the moment of a chat provider call; the ciphertext column is withheld
 *     from the authenticated SELECT grant, so only the service role can read
 *     it, and the plaintext lives only in that request scope, ruling 2/3)
 *   - src/lib/chat/engine.ts  (writes chat_messages; those rows are system
 *     written like monitor_checks, so authenticated has no insert verb and the
 *     server is the only writer, migration 008)
 *   - src/lib/monitoring/first-check.ts  (the immediate check after a
 *     monitor is created; it writes the same sweep owned rows and columns
 *     the cron route does, scheduled by the create action via after(), and
 *     it is the create path's only reach into service role territory)
 *   - src/app/api/webhooks/stripe/route.ts  (syncing subscription state into
 *     org_billing; same posture as the Clerk webhook, no user session, the
 *     signature is the authentication, migration 022)
 *   - src/lib/billing/entitlements.ts, managed-ai.ts, org-access.ts  (READ
 *     ONLY: resolving an org's effective entitlements, the managed AI meter,
 *     and the per user org allowance. The org_billing select grant is the
 *     org's own admins, but plan limits bind every session, member sessions
 *     included, and the org allowance spans orgs a single session can never
 *     see together, so these read past RLS server side and hand gates plan
 *     facts, never Stripe identifiers)
 *   - src/app/dashboard/settings/billing/actions.ts  (via src/lib/db/
 *     billing.ts: recording clickwrap acceptance on org_billing, where no
 *     user session holds a write verb by design, migration 022. The action
 *     proves the viewer is an org admin before the write)
 *   - src/lib/azure/credential-vault.ts  (reads and decrypts an Azure
 *     connection's service principal secret at the moment of the daily cost
 *     pull; the ciphertext column is withheld from the authenticated SELECT
 *     grant, migration 026, so only the service role can read it, and the
 *     plaintext lives only in that request scope, ruling 2/3)
 *   - future cron route handlers and migration tooling, added to this list
 *     when they exist
 *
 * Never import this from a component, a page, or anything reachable from
 * one. Every use outside this list is a tenant isolation bug by definition.
 * The 'server-only' import makes any client bundle inclusion a build error,
 * and SUPABASE_SERVICE_ROLE_KEY has no NEXT_PUBLIC_ prefix so the key
 * cannot reach the browser (CLAUDE.md security rules 1 and 4).
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    throw new AdminConfigError(
      'SUPABASE_SERVICE_ROLE_KEY is not set. It lives in .env.local and in ' +
        'Vercel env vars, never in the repo. See .env.example.',
    )
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl) {
    throw new AdminConfigError('NEXT_PUBLIC_SUPABASE_URL is not set.')
  }

  return createClient<Database>(supabaseUrl, key, {
    auth: { persistSession: false },
  })
}
