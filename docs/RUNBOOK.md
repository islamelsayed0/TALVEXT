# Talvext operations runbook

The things a human owns. Everything else in this repository runs itself; what
is written here either cannot be automated or should not be.

Related documents: `docs/DECISIONS.md` is the ruling log and supersedes the
BRD where they disagree. `docs/DEPLOY_LOG.md` is the dated record of what was
actually deployed and what broke.

---

## 1. The monitoring sweep and its scheduler

**The contract.** An external scheduler (cron-job.org) sends a POST to
`/api/cron/check-monitors` every five minutes with
`Authorization: Bearer <CRON_SECRET>`. There is no Vercel cron entry; the
`crons` block was removed from `vercel.json` when the external scheduler
became the contract (decision log, 2026-07-27). GET works too and runs the same
sweep, for manual invocation.

**Why this has its own section.** This has failed in production. The scheduler
auto disabled its own job after a 405, at a time when the value it was sending
no longer matched the deployment's `CRON_SECRET`, and monitoring simply stopped.
Nothing noticed, because at the time nothing watched it.

**What watches it now, and what each thing can and cannot see:**

| Layer | Catches | Does not catch |
|---|---|---|
| Dashboard banner (admin, every page) | A stale sweep, whenever an admin looks | Anything while nobody is looking |
| `.github/workflows/heartbeat.yml`, every 30 min | A stale sweep, a dead deployment, a dead database | Nothing, within its ~45 minute resolution |
| Talvext monitoring itself (below) | A dead deployment or database, while the sweep is alive | **A dead sweep.** Its own monitors are checked by that same sweep |

Read that last row twice before trusting self monitoring as a safety net. It is
a credibility and demo feature. The GitHub workflow is the actual watcher.

**When the workflow goes red**, in order:

1. Open `https://talvex-chi.vercel.app/api/ops/heartbeat` yourself. A 503 with
   a large `ageSeconds` confirms the sweep, not the workflow, is the problem.
2. Check `https://talvex-chi.vercel.app/api/health`. A 503 there means the
   deployment or the database is the problem, not the scheduler.
3. Open the cron-job.org job. Confirm it is **enabled** (it disables itself
   after repeated failures), the method is **POST**, and the URL is exact.
4. Compare the bearer value in the scheduler against `CRON_SECRET` in the
   Vercel project. This is the pair that has drifted before.
5. If you change `CRON_SECRET` in Vercel, **trigger a fresh build from a new
   commit**. A plain redeploy can reuse the previous deployment's environment
   snapshot, which is exactly how `RESEND_API_KEY` once read as unset.
6. The sweep is self correcting once it runs. The banner clears within one
   interval and the workflow goes green on its next scheduled run; there is
   nothing to replay by hand.

**Do not** point a monitor at `/api/cron/check-monitors`. Without the bearer it
records as permanently down, and with it, every check would trigger a sweep.

---

## 2. Talvext monitors Talvext (BRD S5)

The platform monitors itself and publishes its own status page. This is both a
credibility feature and the permanent demo the BRD asks for.

**The organization is a real Clerk organization**, created the ordinary way and
synced into Postgres by the existing webhook. Do not insert a row into
`organizations` by hand: a fabricated `clerk_org_id` breaks the invariant every
RLS policy depends on, so nobody could sign in to that org, nobody could manage
its monitors, and the webhook would never reconcile it. There is deliberately
no seed script, because it could not run before a human created the Clerk org
anyway, and a service role script in the repository whose only job is inserting
tenant rows is a capability worth not having.

**Setup, about two minutes, once:**

1. Create an organization named `Talvext` in Clerk, signed in as the operator.
2. Confirm the sync landed: Clerk, Webhooks, Message Attempts should show a
   200 for `organization.created`. If `org_members` stays empty, the
   membership event is not subscribed; see `docs/DEPLOY_LOG.md`, which records
   this exact failure happening once already.
3. In Talvext, switch to that org and add three monitors at a 300 second
   interval:
   - `https://talvex-chi.vercel.app/` — the deployment serves.
   - `https://talvex-chi.vercel.app/api/health` — the runtime reaches Postgres.
   - `https://talvex-chi.vercel.app/api/ops/heartbeat` — the endpoint the
     external watcher depends on is itself serving.
4. Settings, Status page: enable it with the slug `talvext`. The slug moved
   from `talvex` on 2026-08-04, after the rename, together with the
   `TALVEX_SLUG` default in `tests/e2e/health.spec.mjs`: the two change in
   the same pull request or the verify command below starts checking a slug
   nobody serves. The env var name itself keeps its old spelling, like every
   config shaped identifier.
5. Settings, Notifications: set the notification email, so the platform's own
   incidents go somewhere. Enabling the daily digest here is reasonable too.

**Verify:** `BASE_URL=https://talvex-chi.vercel.app node tests/e2e/health.spec.mjs`

### What this is not

**Self monitoring cannot detect a dead sweep.** The three monitors above are
checked by the same sweep whose health is in question, so when it stops, they
stop being checked and the Talvext status page freezes showing whatever it last
saw, which is usually all green. It will look reassuring at precisely the
moment it should not.

What it does catch, while the sweep is alive, is a dead deployment or a dead
database. That is worth having. It is not a watcher, and it does not replace
`.github/workflows/heartbeat.yml`. Do not let a BRD close out record S5 as
covering what section 1 covers.

**Note the circularity, and accept it deliberately:** the sweep is now checking
Talvext from Talvext, so a total outage takes both the checker and the checked
with it. That is inherent to self monitoring anywhere, and it is the reason the
external watcher in section 1 is not optional.

---

## 3. The operator error channel

`OPS_DISCORD_WEBHOOK` receives Talvext's own platform failures. It is not, and
must never be, any customer's webhook from notification settings.

**Setup:** create a channel in your own Discord server, create a channel
webhook, and set the full URL as `OPS_DISCORD_WEBHOOK` in the Vercel project.
Then trigger a fresh build (same environment snapshot trap as above).

When unset, platform errors are logged once and not posted, which is the
intended behaviour locally.

**What it will and will not tell you:** it rides the same deployment that
produced the error, so it reports a failing step inside a running sweep. It
reports nothing at all if the deployment is down. That case is section 1's
workflow.

---

## 4. Backups and restore (BRD S6)

**What cannot be done, stated plainly.** Supabase point in time recovery is a
paid add on on a paid plan, and this project's Supabase organization is on the
**free** plan. **S6's first clause, "point in time recovery enabled", is not
met and cannot be met without spending money.** That is a budget decision, not
an engineering one, and nothing below substitutes for it. Report S6 as partly
met, never as green.

Compounding it: one Supabase project backs local, preview, and production
(decision log, 2026-07-23). There is nowhere to restore *to* without disturbing
the only database, which is why the drill below restores into a local stack.

**What is met:** S6's second clause, "restore procedure documented and tested
once". The procedure is here and it has been run; see `docs/DEPLOY_LOG.md` for
the dated result.

### Taking a dump

```bash
npm run db:dump          # writes ./backups/<UTC timestamp>/{schema,data}.sql
```

`./backups/` is gitignored. **A dump contains every tenant row in the
database.** Treat the file the way you would treat the database: do not commit
it, do not put it in a shared drive, delete it when the drill is over.

**When to take one by hand**, since nothing takes one on a schedule:

- Before applying any migration that drops or rewrites a column.
- Before any repair of `supabase_migrations.schema_migrations`.
- Before the production project is split out from the shared one.

### The restore drill

The assertion is not that the commands exited zero. It is that the **isolation
suite passes against the restored data**, which exercises every RLS policy,
grant, trigger, and check constraint the schema is supposed to carry.

```bash
npm run db:start
# wipe the local public schema, then load the dump into it
docker exec -i supabase_db_TALVEX psql -U postgres -d postgres -q \
  -c "drop schema if exists public cascade; create schema public;"
docker exec -i supabase_db_TALVEX psql -U postgres -d postgres -q < backups/<ts>/schema.sql
docker exec -i supabase_db_TALVEX psql -U postgres -d postgres -q < backups/<ts>/data.sql
npx vitest run tests/isolation      # this passing is the proof
npm run db:reset                    # put the local stack back to migration state
```

**Expect seven errors on the data step**, all of the form
`relation "storage.<table>" does not exist`. The local stack does not run the
Storage service and Talvext stores no files, so those tables are empty and their
absence is harmless. Any error naming a `public.` table is real and must be
investigated.

### What this does not cover

- **No schedule.** RPO is "whenever the operator last ran `npm run db:dump`".
- **No off site copy.** The dump lives wherever it was written.
- **No automated verification.** The drill is manual.

Automated dumps into GitHub Actions artifacts were considered and **rejected**:
it would put a second complete copy of the tenant database somewhere with
weaker access controls and 90 day retention, which is a downgrade dressed as
progress. When there is customer data worth protecting there will also be a
budget, and the right answer then is the paid feature. Recorded so it is not
proposed again as a free win.

**This must change before the first real customer**, together with moving
production to its own Supabase project. Those two decisions move as a pair.

---

## 5. The pre commit secret scan

`npm ci` runs `git config core.hooksPath .githooks`, so `.githooks/pre-commit`
installs itself and scans staged changes with
`gitleaks protect --staged --redact`.

**It fails closed when gitleaks is missing**, which means a fresh machine
cannot commit until `brew install gitleaks` has run. That is deliberate: a hook
that passes when the scanner is absent produces confidence without cover, the
same reasoning that removed the escape hatch from the migration drift guard.
To commit without scanning, do it explicitly with `git commit --no-verify`.

The hook is a convenience that catches the mistake before it enters history.
**The CI gitleaks job is the boundary**, because a local hook is bypassable and
absent on any machine that has not installed dependencies. S2 asked for pre
commit scanning and this delivers it; it does not upgrade the hook into a
security control.

---

## 6. Environment variables

Every variable is documented in `.env.example`, which
`tests/env-hygiene.test.ts` keeps honest. Two traps worth repeating because
both have cost real debugging time:

- **`NEXT_PUBLIC_*` values are inlined at build time.** Changing one in the
  Vercel dashboard does nothing until a new build runs.
- **A plain redeploy can reuse the original deployment's environment
  snapshot.** After setting or changing any variable, push a commit.

Preview deployments are **partly** configured: seven variables target Preview,
but the four `NEXT_PUBLIC_*` values, `CLERK_SECRET_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` do not. Those are exactly auth and database, so a
preview build still has neither and the practical conclusion is unchanged.
Finishing it is a dashboard task, tracked in `docs/DEPLOY_LOG.md`.

---

## 7. The domain, and the Clerk production instance

**Status: partly done.** Steps 1 and 2 were completed on 2026-08-04:
`talvext.com` is attached to the Vercel project and serves the app, with
`www` as a 308 redirect to the apex. DNS lives at Cloudflare but the records
are DNS only, deliberately: the proxy was tried and reversed the same day,
and the superseding entry in `docs/DECISIONS.md` (2026-08-04) records why and
what it would take to turn it back on. Clerk
still runs **development** keys, so steps 3 through 9 remain. Every step here
is yours: it involves DNS and three dashboards, and none of it can or should
be automated.

**Why it is worth an evening.** The development instance costs more than the
banner suggests. A signed out visitor who deep links to `/dashboard` gets a
**404 instead of a redirect to sign in**, because a development instance
establishes session context through a dev browser token that a cold link does
not carry (`x-clerk-auth-reason: protect-rewrite, dev-browser-missing`). That
is recorded in `docs/DECISIONS.md` (2026-07-22) and in the README's honest
boundaries. It is also the difference between a demo link and the portfolio
artifact BRD C5 asks for.

**Do the steps in order.** Several of them are gated on DNS propagating, and
step 5 has a failure mode that looks like a bug somewhere else entirely.

### 1. The domain is chosen: talvext.com

`talvext.com` was purchased on 2026-08-03 at standard price, within the budget
BRD section 9.1 set. The purchase followed the product rename recorded in
`docs/DECISIONS.md` (2026-08-03): the Talvex domain space was economically
closed, so the name moved and the domain came with it.

The choice matters this much because the name gets baked into `clerk.<domain>`
and `accounts.<domain>` DNS records, into a Google OAuth client, into a Clerk
webhook endpoint, and into the records below. Changing it later is this whole
section again, which is exactly what the naming rule in the decision log
exists to prevent happening a fourth time.

### 2. Vercel: attach the domain

Vercel, project **talvex**, Settings, Domains, Add.

**What the screen asks for** depends on where the domain lives:

- **Bought through Vercel:** nothing further. DNS is configured for you.
- **Bought elsewhere:** Vercel shows one of two options. Either point the
  registrar's nameservers at Vercel, or keep your registrar's DNS and add the
  records it displays, normally an `A` record on the apex and a `CNAME` on
  `www`. Vercel shows the exact values; do not type them from memory.

Vercel issues the TLS certificate itself once DNS resolves. Expect minutes,
occasionally hours.

Decide now whether the canonical host is the apex (`talvext.com`) or `www`, and
set the other to redirect. Whichever you choose is the one that goes in every
record in the table at the end of this section.

### 3. Clerk: create the production instance

Clerk dashboard, the **Talvex** application, then the environment switcher at
the top: **create a production instance**. This is not a new application.

Clerk offers to clone your development settings. Take it, then **check each
setting afterwards anyway**, because not everything clones and the two that
matter most are in steps 4 and 5.

**What it asks for:** the production domain. It then returns a set of DNS
records to add at your registrar:

- `clerk.<domain>` — a CNAME, the Frontend API.
- `accounts.<domain>` — a CNAME, the hosted account pages.
- Email records: a `clkmail` CNAME and two DKIM CNAMEs
  (`clk._domainkey` and `clk2._domainkey`).

**These records are the whole reason this was deferred.** They cannot be added
to a `*.vercel.app` subdomain because Vercel owns that zone, which is why
"free subdomain" and "Clerk production instance" were mutually exclusive
(`docs/DECISIONS.md`, 2026-07-22).

**Every one of these records must be DNS only (grey cloud) in Cloudflare.**
Cloudflare defaults new records to Proxied, and a proxied `clerk.` or
`accounts.` CNAME fails Clerk's verification with no error pointing at the
cloud icon. The whole zone is DNS only by decision, so any orange cloud on
this zone is a mistake.

Clerk verifies them on its own screen. Give it time before assuming failure.

### 4. Google: your own OAuth application, now mandatory

The development instance used Clerk's **shared** Google credentials, which is
why the consent screen currently says `accounts.dev`. A production instance
may not use them. This is queued item 3 in `docs/DEPLOY_LOG.md`, which was
optional when it was written and is not any more.

1. Google Cloud Console, create or select a project for Talvext.
2. APIs and Services, OAuth consent screen. External user type. App name,
   support email, developer contact.
3. Credentials, Create Credentials, OAuth client ID, Web application.
4. **The redirect URI is not a guess.** In Clerk, go to User and
   Authentication, Social Connections, Google, and toggle off "Use shared
   credentials". Clerk then displays the exact redirect URI. Paste that.
5. Paste the Google client ID and secret back into that same Clerk screen.

### 5. Supabase: third party auth, and the trap that costs a night

Clerk's setup page at `dashboard.clerk.com/setup/supabase` configures a Clerk
instance for Supabase. **Run it against the production instance**, not the
development one you already did this for. Then, in the Supabase dashboard for
project `rdfuzadtraxzrrthhnnp`: Authentication, Third Party Auth, add a Clerk
integration for the **new** domain.

**Read this part twice.** That setup adds a `role: authenticated` claim to
Clerk session tokens, and **it is configured per instance. It does not carry
over from development.**

If you miss it, nothing looks broken. The app deploys, the domain resolves,
Google sign in works, and the dashboard comes up **completely empty**, because
the token reaches Postgres without the role, so every RLS predicate matches
nothing and every query returns zero rows. That is the failure shape the
2026-07-21 `hidePersonal` entry calls the worst kind in this system: it is
indistinguishable from an account that genuinely has no data, so it gets
diagnosed as a bug in whatever screen happened to be open.

**Nothing else about the database changes.** The RLS claim pattern is the
same, so there is no migration, and the isolation suite is unaffected because
it mints its own tokens against a local stack and never talks to Clerk at all.

### 6. Vercel: swap exactly two environment variables

In the **Production** environment:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — `pk_test_...` becomes `pk_live_...`
- `CLERK_SECRET_KEY` — `sk_test_...` becomes `sk_live_...`

`CLERK_WEBHOOK_SIGNING_SECRET` waits for step 7, because it does not exist
yet.

**Change nothing else, and one of those matters more than the rest:** rotating
`API_KEY_ENCRYPTION_SECRET` would invalidate every stored BYOK provider key
and every org would have to re add theirs. `CRON_SECRET`, the Supabase keys,
`RESEND_*` and `OPS_DISCORD_WEBHOOK` are all unrelated to this change and
should be left alone.

### 7. Clerk: recreate the webhook endpoint

Webhook endpoints belong to an instance, so the development one does not
follow you.

Clerk (production instance), Configure, Webhooks, Add Endpoint.

- URL: `https://talvex-chi.vercel.app/api/webhooks/clerk` — the vercel.app
  hostname, **not** the domain. The hostname is immune to whatever sits in
  front of the domain, now or later: a future proxy, an edge rule, or a DNS
  change could challenge or drop webhook deliveries, which does not error,
  it silently stops org sync, the exact fault shape of `docs/DEPLOY_LOG.md`
  Fault 2. The external watcher and the cron scheduler target the vercel.app
  hostname for the same reason.
- Subscribe to exactly these six, the ones `src/lib/db/clerk-sync.ts` handles:
  `organization.created`, `organization.updated`, `organization.deleted`,
  `organizationMembership.created`, `organizationMembership.updated`,
  `organizationMembership.deleted`.
- Copy the new signing secret (`whsec_...`) into
  `CLERK_WEBHOOK_SIGNING_SECRET` in Vercel Production.

**Signing secrets are per endpoint.** Reusing the development value produces a
400 on every delivery, which reads as a broken app rather than a wrong secret.

### 8. Redeploy from a new commit

Not a plain redeploy. Both reasons are in section 6 above: `NEXT_PUBLIC_*`
values are inlined at build time, and a plain redeploy can reuse the previous
deployment's environment snapshot. The reference update pull request in the
table below is a convenient real commit to be that build.

### 9. Verify, in this order

The order matters: each check rules out a cause for the next one.

1. `https://<domain>/` returns 200 and there is **no Clerk development
   banner**.
2. `https://<domain>/dashboard`, signed out, in a private window,
   **redirects to sign in rather than returning 404**. This is the defect the
   whole section exists to remove. If it still 404s, the deployment is still
   running development keys, so step 6 or step 8 did not take.
3. Google sign in shows **your** consent screen, not `accounts.dev`.
4. **The real test of steps 5 and 7.** Create a throwaway organization. In
   Clerk, Webhooks, Message Attempts, confirm a 200 for **both**
   `organization.created` and `organizationMembership.created`. Then confirm
   matching rows landed in `public.organizations` and `public.org_members`.
   A missing membership row is the exact fault recorded in
   `docs/DEPLOY_LOG.md` under Fault 2, and it silently disables every admin
   gated feature.
5. **The zero rows check.** Sign in as an existing user with real data and
   confirm the dashboard shows it. An empty dashboard here means the step 5
   role claim is missing, not that anything else is wrong.
6. `BASE_URL=https://<domain> node tests/e2e/health.spec.mjs`

### 10. Afterwards: the monitors are database rows, not code

The three self monitoring monitors from section 2 point at
`talvex-chi.vercel.app`. They live in the `monitors` table, so they are
changed in the app (Monitors, each one, Edit), not in a pull request. Until
they are, the platform is watching a hostname that still answers as a Vercel
alias but is no longer the truth.

The old `talvex-chi.vercel.app` alias keeps working. Nothing breaks the moment
you attach a domain; things merely become stale, which is the harder problem
to notice.

### The `vercel.app` references, and which of them may change

One small pull request after the domain is live. **The split matters:** a
find and replace across the repository would rewrite the historical record,
which is the opposite of what these documents are for.

**Update these. They point at the running deployment:**

| Where | What it is |
|---|---|
| `.github/workflows/heartbeat.yml` | the external watcher's actual target |
| `tests/ops-heartbeat.test.ts` | asserts the workflow contains that URL, so **it changes in the same commit or CI goes red** |
| `README.md` | the Live link, and the `/status/talvext` link |
| `docs/RUNBOOK.md` | section 1's two checks, and section 2's three monitor URLs |
| `docs/DEMO.md` | the demo target and its preflight check |
| `tests/e2e/health.spec.mjs` | the usage example in the header comment |

That test and workflow pairing is deliberate rather than an annoyance: it is
what stops the watcher quietly pointing at a hostname nobody serves any more.

**Leave these alone. They are dated records of what was true at the time:**
`docs/DEPLOY_LOG.md` (every occurrence), the 2026-07-22 entry in
`docs/DECISIONS.md`, `docs/PHASE_0_PLAN.md`, and `docs/BRD.md`.

**That pull request also carries the decision log entry**, superseding the
2026-07-22 ruling that Talvext ships on a development instance, plus a deploy
log entry recording what actually happened and anything that surprised you.
Neither is written in advance: this log records decisions taken, not planned.

---

## 8. The platform AI key

Managed AI answers (F13 PR 3) run on a platform key: my money per request,
serving orgs whose plan includes answers and who have no BYOK key of their
own. BYOK chat never touches it. The key is provider agnostic: the env
contract is `PLATFORM_AI_PROVIDER` (`anthropic` or `openai`) plus the
MATCHING key variable, `PLATFORM_ANTHROPIC_API_KEY` or
`PLATFORM_OPENAI_API_KEY`. Exactly one configured pair is valid. The
provider unset, unrecognized, or naming a provider whose key variable is
empty all mean the managed path is off: entitled orgs see the honest
unavailable copy and the ticket door, BYOK is unaffected, and nothing
fails at boot.

**The shape of the protection, two layers.** The database cap is the first
layer: each org is metered against its monthly allowance by counting the
`chat_messages` rows that are the answers, and at the cap the product
refuses with the Get Help door. The provider side limit is the second
layer, the backstop behind the cap: it bounds the SUM across all orgs plus
anything a bug could ever leak past the per org meter. The cap protects
each tenant's experience; the limit protects the bank account. Both exist
on purpose; neither replaces the other.

**Setup, Anthropic.** Create a dedicated workspace in the Anthropic console
(so the spend limit and the usage graphs cover exactly this product and
nothing else you run), set a monthly workspace spend limit you would not
mind losing entirely, and create the key inside that workspace. Set
`PLATFORM_AI_PROVIDER=anthropic` and the key as
`PLATFORM_ANTHROPIC_API_KEY` in the Vercel project.

**Setup, OpenAI.** The equivalent guard rail is a dedicated project: create
one in the OpenAI platform settings (again, this product only), set a
monthly budget limit on the project, and create the key scoped to that
project. Set `PLATFORM_AI_PROVIDER=openai` and the key as
`PLATFORM_OPENAI_API_KEY` in the Vercel project.

Either way, finish with a fresh build: the section 6 trap applies in full,
a plain redeploy can reuse the old environment snapshot.

**Models.** The managed path answers on its own model table,
`PLATFORM_MODELS` in `src/lib/chat/providers.ts`, cheap tier by default and
deliberately separate from the BYOK defaults beside it: moving the managed
tier must never move what a customer's own key pays for, or the reverse.

**What the ops events mean.**

- `chat.platform_key.not_configured` (once per process): an org that paid
  for managed answers asked while no valid provider and key pair was set.
  Fix the pair or expect the unavailable degrade to stay up.
- `chat.platform_key.failed` (posted to the operator channel once per
  process, name only; the log records every failure): the provider refused
  the key at answer time. The three usual reasons are the spend or budget
  limit firing, rate limiting, and a revoked or invalid key. Members saw
  the unavailable copy and the ticket door, never an error page, and no
  retry was attempted: the send path makes exactly one attempt per answer,
  because a retry would multiply spend against the very limit that is
  firing.

**Rotation.** Create the new key in the same workspace or project, update
the matching key variable in Vercel, then push a commit or trigger a fresh
build (the section 6 trap again: a plain redeploy can reuse the old
environment snapshot and keep answering on the old key). When the new
build is live, delete the old key in the console and watch the operator
channel: a `chat.platform_key.failed` after rotation means a stale build
or a mispasted key. Switching providers is the same dance with
`PLATFORM_AI_PROVIDER` changed too; the old provider's key variable can
then be deleted.
