-- Azure cost monitoring, part 1 of the cloud spend feature (BRD F23, the
-- Phase 3 item pulled forward as the portfolio's credential handling proof).
-- This is the first table holding a customer's CLOUD credentials, so the
-- whole BYOK vault posture (migration 007, security rulings 2 and 3) governs:
--
--   - The service principal secret arrives encrypted (AES-256-GCM, applied in
--     the application layer by src/lib/chat/encryption.ts before the value
--     reaches Postgres) and the ciphertext column is WITHHELD from the
--     authenticated SELECT grant. No user session, not even the admin who
--     pasted the secret, can ever read it back. Only the service role, in the
--     pull path, decrypts it, and the plaintext lives only in that request.
--   - Pull bookkeeping (last_pull_at, last_pull_status, last_success_at) and
--     the budget alert ledger (budget_alerted_for_month) are sweep owned
--     ledgers, the migration 017/020 posture: no user session holds a write
--     grant on any of them, so an org cannot forge freshness or replay an
--     alert by clearing its own dedup stamp.
--   - Daily cost rollups are shaped on monitor_daily_rollups (migration 003):
--     org denormalized so RLS never joins, service role written only. Reads
--     are ADMIN only, not member wide: spend is money data, scoped like the
--     billing screen, not like uptime.
--   - Rollups carry the subscription id, not a foreign key to the connection
--     row, ON PURPOSE: disconnecting deletes the credential and must keep the
--     cost history (the release address idiom applies to the secret, not to
--     the org's own historical numbers).
--
-- The pull itself rides the five minute sweep with a one attempt per day due
-- check; there is no new scheduler and no new cron entry (the daily digest
-- precedent, decision log 2026-07-27).

-- ---------------------------------------------------------------------------
-- azure_connections: one row per connected Azure subscription.

create table public.azure_connections (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references public.organizations (id) on delete cascade,
  -- The three identifiers the setup command prints. All are GUIDs; the shape
  -- check refuses a pasted secret or display name landing in the wrong field.
  subscription_id          text not null check (
    subscription_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  tenant_id                text not null check (
    tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  client_id                text not null check (
    client_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  -- AES-256-GCM ciphertext of the service principal client secret, encrypted
  -- before it reaches this table. Deliberately absent from the authenticated
  -- SELECT grant below.
  encrypted_secret         text not null check (btrim(encrypted_secret) <> ''),
  -- When the client secret the admin minted stops working, as pasted from the
  -- setup command output. Drives the expiry warnings (the SSL cert pattern).
  credential_expires_at    timestamptz,
  created_by               text not null,
  -- Sweep owned pull ledger. last_pull_at stamps every attempt, success or
  -- failure, and drives the one attempt per day due check. last_success_at
  -- moves only on success and is what the staleness banner measures against
  -- (the platform_heartbeat last_run_at / last_success_at split).
  last_pull_at             timestamptz,
  last_pull_status         text check (last_pull_status in ('ok', 'failed')),
  last_success_at          timestamptz,
  -- The one budget number per subscription (v1 ruling). NULL means no budget
  -- set. The admin writes this; the alert ledger next to it is sweep owned.
  monthly_budget           numeric check (monthly_budget > 0),
  -- Which org timezone month ('YYYY-MM-01') has already alerted. One alert
  -- per month per subscription; the month rolling over is what resets it.
  budget_alerted_for_month date,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- One connection per subscription per org; reconnecting is an update.
  unique (org_id, subscription_id)
);

comment on table public.azure_connections is
  'Azure service principal credentials for cost monitoring (BRD F23), one row per connected subscription. The secret is AES encrypted in the application layer and unreadable through any user session; pull and alert ledgers are sweep owned.';
comment on column public.azure_connections.encrypted_secret is
  'AES-256-GCM ciphertext of the client secret. Withheld from the authenticated SELECT grant (migration 007 posture): only the service role reads it, in the pull path.';
comment on column public.azure_connections.credential_expires_at is
  'When the minted client secret expires, as recorded at connect time. Warned at 14 and 3 days, the cert expiry thresholds.';
comment on column public.azure_connections.last_pull_at is
  'When the sweep last attempted a cost pull, success or failure. One attempt per UTC day. Written only by the cron sweep (service role).';
comment on column public.azure_connections.last_pull_status is
  'Outcome of the most recent pull attempt (ok, failed). NULL means never pulled. Written only by the cron sweep (service role).';
comment on column public.azure_connections.last_success_at is
  'When a pull last succeeded. What the staleness banner measures against. Written only by the cron sweep (service role).';
comment on column public.azure_connections.monthly_budget is
  'The admin set monthly budget for this subscription, in the subscription''s billing currency. NULL means no budget.';
comment on column public.azure_connections.budget_alerted_for_month is
  'First day of the org timezone month that has already sent its budget alert. The dedup ledger: one alert per month per subscription. Written only by the cron sweep (service role); no user session holds a grant on it.';

create trigger azure_connections_set_updated_at
before update on public.azure_connections
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- azure_daily_costs: per subscription per day cost rollups, the
-- monitor_daily_rollups shape. Keyed by subscription id rather than the
-- connection row so disconnecting keeps the history. Azure restates recent
-- days as usage settles, so the pull re-upserts a trailing window and the
-- upsert must stay idempotent.

create table public.azure_daily_costs (
  org_id          uuid not null references public.organizations (id) on delete cascade,
  subscription_id text not null check (
    subscription_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  -- Azure Cost Management usage date. Azure buckets these days itself; they
  -- are the billing system's days, not the org timezone's (the usage screen
  -- discloses the same few hours of edge skew).
  day             date not null,
  -- Can be negative: credits and refunds land as negative cost.
  total_cost      numeric not null,
  currency        text not null check (btrim(currency) <> ''),
  -- Cost by Azure service for the day, top services only, bounded in the
  -- pull code: { "Virtual Machines": 1.23, ... }. Small structured facts,
  -- never resource level detail (v1 ruling: no per resource drill down).
  by_service      jsonb not null default '{}'::jsonb,
  primary key (org_id, subscription_id, day)
);

comment on table public.azure_daily_costs is
  'Daily Azure cost rollups per subscription (BRD F23). Written only by the cron sweep (service role); admin readable, org scoped. Survives disconnect on purpose: the credential dies, the history stays.';
comment on column public.azure_daily_costs.day is
  'Azure Cost Management usage date (the billing system''s day bucket, effectively UTC).';
comment on column public.azure_daily_costs.by_service is
  'Cost by Azure service name for this day, top services only (bounded in the pull path). Values are numbers in the row currency.';

create index azure_daily_costs_org_id_day_idx
  on public.azure_daily_costs (org_id, day);

-- ---------------------------------------------------------------------------
-- RLS. Enabled before any policy so a mistake below fails closed, not open.

alter table public.azure_connections enable row level security;
alter table public.azure_daily_costs enable row level security;

-- Connections: admin only, org scoped, in the established idiom. The insert
-- pins created_by to the session user (the 007 WITH CHECK construction);
-- update deliberately has no created_by pin, because setting a budget on a
-- connection a different admin created is normal administration.

create policy "org admins read their azure connections"
on public.azure_connections
for select
to authenticated
using (
  org_id in (
    select id from public.organizations
    where clerk_org_id = (select public.clerk_active_org_id())
  )
  and public.is_org_admin(org_id)
);

create policy "org admins connect azure subscriptions"
on public.azure_connections
for insert
to authenticated
with check (
  org_id in (
    select id from public.organizations
    where clerk_org_id = (select public.clerk_active_org_id())
  )
  and public.is_org_admin(org_id)
  and created_by = (select public.clerk_user_id())
);

create policy "org admins update their azure connections"
on public.azure_connections
for update
to authenticated
using (
  org_id in (
    select id from public.organizations
    where clerk_org_id = (select public.clerk_active_org_id())
  )
  and public.is_org_admin(org_id)
)
with check (
  org_id in (
    select id from public.organizations
    where clerk_org_id = (select public.clerk_active_org_id())
  )
  and public.is_org_admin(org_id)
);

create policy "org admins disconnect azure subscriptions"
on public.azure_connections
for delete
to authenticated
using (
  org_id in (
    select id from public.organizations
    where clerk_org_id = (select public.clerk_active_org_id())
  )
  and public.is_org_admin(org_id)
);

-- Rollups: admin read only. No write policy for user sessions on purpose;
-- the cron sweep writes these through the service role, which bypasses RLS.
-- Spend is money data: scoped to admins like the billing screen, not to
-- every member like uptime rollups.

create policy "org admins read their azure daily costs"
on public.azure_daily_costs
for select
to authenticated
using (
  org_id in (
    select id from public.organizations
    where clerk_org_id = (select public.clerk_active_org_id())
  )
  and public.is_org_admin(org_id)
);

-- ---------------------------------------------------------------------------
-- GRANTs. Migration 003 pattern: revoke everything, grant back exactly the
-- verbs (and here, columns) each role needs. anon gets nothing.

revoke all on table public.azure_connections from anon, authenticated;
-- SELECT is column level and DELIBERATELY EXCLUDES encrypted_secret: the
-- ciphertext is never selectable through the authenticated role, not even by
-- an admin (ruling 3, the migration 007 asymmetry). It also excludes nothing
-- else: the pull and alert ledgers are readable facts, just not writable.
grant select (
  id, org_id, subscription_id, tenant_id, client_id, credential_expires_at,
  created_by, last_pull_at, last_pull_status, last_success_at,
  monthly_budget, budget_alerted_for_month, created_at, updated_at
) on table public.azure_connections to authenticated;
-- A session may WRITE ciphertext (connect and reconnect), never read it back.
grant insert (
  org_id, subscription_id, tenant_id, client_id, encrypted_secret,
  credential_expires_at, created_by
) on table public.azure_connections to authenticated;
-- Reconnect updates the secret and its expiry; budget is the one setting.
-- The pull and alert ledgers are absent: service role only (020 posture).
grant update (encrypted_secret, credential_expires_at, monthly_budget)
  on table public.azure_connections to authenticated;
grant delete on table public.azure_connections to authenticated;
grant all on table public.azure_connections to service_role;

revoke all on table public.azure_daily_costs from anon, authenticated;
grant select on table public.azure_daily_costs to authenticated;
grant all on table public.azure_daily_costs to service_role;

-- ---------------------------------------------------------------------------
-- Audit vocabulary, extended by constraint swap exactly as 013 planned.

alter table public.audit_log drop constraint audit_log_action_allowed;
alter table public.audit_log add constraint audit_log_action_allowed check (
  action in (
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
    'monitor_alerts_paused',
    'monitor_alerts_resumed',
    'azure_connected',
    'azure_disconnected',
    'azure_budget_changed'
  )
);

-- Azure connection fanout, the 013 definer pattern. Detail carries the
-- subscription id (an identifier the admin screen already shows) and, for a
-- budget change, the changed field NAME only: the budget amount is
-- configuration, not an audit fact, and the secret's value is simply never
-- read here. Sweep ledger stamps (last_pull_*, last_success_at,
-- budget_alerted_for_month) record nothing: bookkeeping, not administration.

create function public.audit_azure_connections_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (org_id, action, actor, detail)
    values (
      new.org_id,
      'azure_connected',
      public.clerk_user_id(),
      jsonb_build_object('subscription_id', new.subscription_id)
    );
  elsif tg_op = 'UPDATE' then
    -- A new secret is a reconnect: the same fact as connecting.
    if new.encrypted_secret is distinct from old.encrypted_secret then
      insert into public.audit_log (org_id, action, actor, detail)
      values (
        new.org_id,
        'azure_connected',
        public.clerk_user_id(),
        jsonb_build_object('subscription_id', new.subscription_id)
      );
    end if;
    if new.monthly_budget is distinct from old.monthly_budget then
      insert into public.audit_log (org_id, action, actor, detail)
      values (
        new.org_id,
        'azure_budget_changed',
        public.clerk_user_id(),
        jsonb_build_object(
          'subscription_id', new.subscription_id,
          'changed', jsonb_build_array('monthly_budget')
        )
      );
    end if;
  else
    -- Deletes fire during an org cascade too; skip when the org row is
    -- already gone (the 013 construction).
    if exists (select 1 from public.organizations where id = old.org_id) then
      insert into public.audit_log (org_id, action, actor, detail)
      values (
        old.org_id,
        'azure_disconnected',
        public.clerk_user_id(),
        jsonb_build_object('subscription_id', old.subscription_id)
      );
    end if;
  end if;
  return null;
end;
$$;

create trigger azure_connections_audit
after insert or update or delete on public.azure_connections
for each row execute function public.audit_azure_connections_change();

revoke execute on function public.audit_azure_connections_change()
  from public, anon, authenticated;
