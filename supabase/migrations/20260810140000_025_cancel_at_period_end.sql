-- Migration 025: org_billing.cancel_at_period_end (F13 follow up).
--
-- A subscription canceled at period end stays active until the period turns,
-- and until now that intention was invisible to the app: the webhook kept
-- writing status active (true) and the billing screen said Active with no
-- hint the plan was ending. The flag makes the scheduled ending a stored
-- fact the screen can say honestly, whichever door scheduled it, the in app
-- cancel page or the Stripe portal.
--
-- Same posture as every other entitlement column (migration 022): the
-- webhook writes it on the service role, admins read it through the existing
-- select policy, no user session holds a write verb. Default false keeps
-- every existing row truthful.

alter table public.org_billing
  add column cancel_at_period_end boolean not null default false;

comment on column public.org_billing.cancel_at_period_end is
  'The subscription is scheduled to end at current_period_end. Written by the webhook from the Stripe subscription; access continues until the period turns.';
