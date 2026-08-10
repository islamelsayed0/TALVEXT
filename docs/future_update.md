# Talvext — Future Updates

A running list of enhancements we want but are deliberately not building yet,
so the idea is captured without pulling scope into the current task. Newest on
top. Each entry says what, why, and enough of the how that whoever picks it up
is not starting cold. Promote an item into a real task when its phase comes.

Shipped, so no longer listed here: the migration history repair and the 001/002
GRANTs backfill (2026-07-24), which also removed `auto_expose_new_tables` and
added the CI migration drift guard. See docs/DECISIONS.md for all three.

---

## Cloud costs: a multi tenant OAuth connect button instead of the pasted service principal

**Raised 2026-08-10** while building Azure cost monitoring (BRD F23). The v1
connect flow is honest but manual: the admin runs one Azure CLI command that
mints a Cost Management Reader service principal and pastes back three
values. The upgrade is a "Connect Azure" button backed by a multi tenant
Entra app registration: the admin signs in, consents, and Talvext receives
delegated or app credentials without anyone handling a secret by hand.

**Why not now.** A multi tenant app registration is a real operational
commitment: a verified publisher domain, admin consent flows that differ by
tenant policy, certificate credentials with rotation, and a Microsoft
partner verification queue. None of that teaches anything the v1 flow does
not, and the pasted flow keeps the buyer in full control of scope and
revocation, which is the pitch.

**What picking it up looks like.**

1. **Register the multi tenant app** with a certificate credential, publisher
   verified, requesting only Cost Management Reader consent.
2. **Replace the wizard's paste form** with the consent redirect and store
   the returned credential in the same vault row shape; the pull path does
   not change.
3. **Keep the CLI path** as the fallback for tenants whose policy blocks
   third party consent, which is common in exactly the IT literate shops
   Talvext sells to.

**The cost of leaving it.** Some connect friction for the admin, roughly
five careful minutes with a wizard that explains each step. No security
cost: the pasted flow is narrower, not wider, than the OAuth one.

---

## Process: the chat isolation CI flake, now cited, and the audit that nearly buried it

**Raised 2026-07-30** at the portfolio close out. This entry records two
things: a real flake, and a near miss in how it was almost dismissed.

**The conflict, written down because it is the more useful half.** The Block A
landing session reported that `tests/isolation/chat-isolation.test.ts` had
failed twice in CI during that landing, seeding, upstream error, green on
rerun. The close out audit then went looking for those failures and **found
none**, and the entry was first written to say the flake was unwitnessed. The
audit was wrong, and it was wrong in a way worth naming: it queried
`gh run list` and `gh pr checks`, and **a rerun replaces a run's top level
conclusion**, so a run that failed and then passed reports `success` and its
failed attempt is invisible to every top level query. Searching for red runs
finds nothing precisely because someone already made them green.

The query that actually sees it:

```sh
gh api "repos/<owner>/<repo>/actions/runs?per_page=100" \
  --jq '.workflow_runs[] | select(.run_attempt > 1) | [.id, .name, .head_branch] | @tsv'
gh run view <id> --attempt 1 --log-failed
```

**Both failures, cited.** Exactly two, exactly as reported, both on 2026-07-30
during the Block A landing, both `quality` on attempt 1 with attempt 2 green:

| Run | Branch | Failed at | Message |
|---|---|---|---|
| `30553918121` | `ops/backup-runbook` | `chat-isolation.test.ts:77`, the conversation insert | `Seeding conversation failed: An invalid response was received from the upstream server` |
| `30554451292` | `ops/self-monitoring` | `chat-isolation.test.ts:93`, the messages insert | `Seeding messages failed: An invalid response was received from the upstream server` |

Both runs: 1 file failed, 55 passed, all 28 chat tests skipped because the
`beforeAll` threw. Neither branch touched the chat suite, the chat code, or
migration 008.

**What the evidence already rules out.** That wording is the API gateway's own
502 body, not PostgREST's and not Postgres's, so nothing here is a policy, a
grant, or a statement. One failure hit the **member's RLS client** and the other
hit the **service role client**, at different statements, which rules out one
role, one table, and one query shape. What is left is the API layer being
transiently unavailable to a suite that starts hitting it hard immediately
after `supabase start`.

**What picking it up looks like.**

1. **Reproduce against a cold stack.** Loop `npm run db:start` then
   `npx vitest run tests/isolation` on a cold Docker, and watch for the 502.
   The suite runs files concurrently, so chat is not special; it is just often
   first into the gateway with a burst.
2. **Confirm it is readiness, not load.** If a short wait or a gateway health
   probe before the first request removes it, it is readiness. If it survives
   that and tracks concurrency, it is load, and the fix is different.
3. **Fix the cause, never the symptom.** A bounded retry on the transport, in
   `tests/isolation/local-stack.ts` so every suite gets it once rather than
   each file inventing its own, is acceptable **if** the diagnosis is a
   readiness race. Loosening, skipping, or conditionally running an isolation
   assertion is not, under any diagnosis (CLAUDE.md rule 8).

**The cost of leaving it.** A rerun, roughly two minutes. The real cost is the
reflex: a suite that is sometimes red for no reason teaches its reader to rerun
first and think second, and that is exactly the habit that would wave through a
genuine isolation failure. The second cost is the one this entry documents, that
a rerun erases the evidence, so the next occurrence is again invisible to anyone
who does not know to ask for attempt 1.

---

## Ops: watch the watcher, and re-verify the prod secret alignment periodically

**Raised 2026-07-27** after the monitor sweep silently stopped: cron-job.org
had auto disabled the job (405, because it was POSTing to a route that only
had GET deployed at the time), and separately the live `CRON_SECRET` had
drifted from `.env.local`, so authenticated calls 401'd. Both were invisible
until an email arrived and chat also failed to decrypt its key. See the
2026-07-27 external scheduler decision, which names this residual: nothing
watches the watcher.

**Also learned (2026-07-28), F10 email setup.** A Vercel env var only reaches
the app on a build created after it was set, and a plain "Redeploy" can reuse
the original deployment's env snapshot, so `RESEND_API_KEY` read as unset at
runtime until a fresh build (a new commit) picked it up. The self check below
should therefore assert a value is actually visible at runtime, not just that
it exists in the Vercel dashboard.

**What.** Two follow ups.

1. **A heartbeat for the external sweep.** cron-job.org calling the endpoint is
   the only thing keeping monitoring alive, and its own health is unmonitored.
   Add a dead man's switch: record the last successful sweep time (a timestamp
   the sweep writes, or a healthchecks.io style ping the sweep makes at the end)
   and surface a loud "monitoring has not run in N minutes" state on the admin
   dashboard, so a stopped scheduler is visible in the product, not only in a
   cron-job.org email. Vercel Pro cron is the first party alternative if the
   third party residual keeps biting.

2. **A periodic prod config self check.** The outage was really a secret
   alignment drift between `.env.local`, Vercel, and cron-job.org, plus a key
   encrypted under a different `API_KEY_ENCRYPTION_SECRET` than prod runs. Worth
   a small, safe check to run on a schedule (or before each deploy): confirm the
   authenticated sweep returns 200 (secret aligned + service role good) and that
   the chat send path can decrypt at least one org key (secret aligned + key
   re-encrypted under the live secret). Read only, no secrets logged. This is
   the "check back later that everything is still ok" the owner asked for.

**Why not now.** Both are real features (a schema touch for the heartbeat, a
guarded diagnostic endpoint for the self check) that deserve their own task and
tests, not a bolt on while shipping F10. The immediate incident is resolved:
the sweep is green again and chat decrypts. Capture the hardening; build it when
the notifications feature it protects has settled.

---

## Assistant: gate the floating popup on entitlement once billing lands

**Raised 2026-07-27** when the floating Talvext AI popup shipped for everyone. The
popup (`src/app/dashboard/_shell/ask-talvext-widget.tsx`) reuses the BYOK chat, so
today it is effectively gated by the org having a provider key connected: no key,
and it shows a "needs a key" state instead of taking input.

**What.** When Phase 2 billing (F13) and a platform managed AI key (F7's "platform
managed key on paid tiers") exist, the assistant should be usable when the org
**subscribes to the platform AI model** OR **has its own key connected** — and
the popup should reflect that entitlement rather than only BYOK presence. The
current `hasKey` prop from the layout is the seam: replace it with an
`assistantEnabled` entitlement check that is true for a subscribed org or a
BYOK org.

**Why not now.** There is no billing or platform key yet, so entitlement is
exactly "has a BYOK key." Building a gate before there is a second path to gate
on would be speculative. Capture it; wire it when F13 lands.

---

## Ops: verify Clerk membership sync end to end, and consider a self heal

**Raised 2026-07-24** after finding `org_members` had zero rows in production
(docs/DEPLOY_LOG.md, Fault 2): the founding user's
`organizationMembership.created` was never delivered because the event was not
subscribed at org creation time. Backfilled by hand; events are subscribed now.

**What.** Two follow ups. First, a real verification that membership sync works:
add a second member (or a test org) and confirm a 200 on
`organizationMembership.created` in Clerk's Message Attempts and a matching
`org_members` row. Second, consider a small self heal so a missed membership
event is not a silent, permanent admin lockout: for example, a lightweight
reconcile that, when a signed in user's token carries an org admin role claim but
no `org_members` row exists for them, logs it loudly (or, more cautiously,
surfaces a "membership not synced" state on the dashboard, which step 6/7 of the
Phase 0 deploy checklist already gesture at) rather than silently rendering the
member view.

**Why not a bigger fix now.** The handler (src/lib/db/clerk-sync.ts) is correct;
the failure was configuration plus a one time missed event, both resolved. A
self heal that trusts the token claim to write a role row would undermine the
Task 3 decision that the database column, not the claim, is the role authority,
so any reconcile must be read only or admin reviewed, not an automatic role
grant. Capture the idea; design it carefully when membership management (the
owner/technician ladder, docs below) is built.

---

## Chat: let the assistant see the org's live Talvext data (tool use)

**What.** Today the support assistant is stateless about the tenant: it cannot
see this org's monitors, incidents, tickets, devices, or any live Talvext data,
and its system prompt makes it say so plainly and point the user to the right
dashboard page or offer to escalate. The enhancement is to give the assistant
read only tool access over the org's own data, scoped by the same RLS the app
uses, so it can answer "is the mail server down?" or "what is the status of my
ticket?" directly instead of deflecting.

**Why not now.** Tool use over tenant data is a real security surface: every
tool call must run under the caller's RLS (or a tightly scoped equivalent), must
never cross the org boundary, and must never let a prompt injection in a user
message pull data the user could not otherwise see. That is its own design and
isolation test effort, and BRD F14 (knowledge base retrieval) is the more
valuable retrieval feature to build first. The honest deflection is the correct
behavior until the tool layer exists; the assistant never guesses about system
status.

**How (sketch).** A small set of read only tools (monitor status, incident
list, ticket lookup for the caller) exposed to the provider via the abstraction
in `src/lib/chat/providers.ts`, each executed server side through the org scoped
client so RLS filters exactly as it does for the dashboard. Per provider tool
calling differs (Anthropic tools, OpenAI functions, Google function calling),
so the abstraction grows a normalized tool interface. Add isolation tests that a
tool call as org A can never surface org B data, and that a member's tool call
sees only what that member's RLS allows. Update the system prompt's honesty
rules once the assistant genuinely can see the data.

---

## Chat: streaming replies, per org model choice, conversation sharing

**What.** Three deferred chat niceties: stream the assistant reply token by
token instead of the current non streaming "thinking" state; let an admin pick
the model per org (not just the hardcoded cheap default per provider); and let a
member share or export a conversation. Also parked: file uploads into chat and
the managed AI tier (platform key plus metering, BRD F11/F13).

**Why not now.** Task 5 chose non streaming deliberately: streaming three
providers through one abstraction means per provider SSE parsing and partial
state on the client, real complexity for a support chat where replies are
short. Per org model choice needs a settings surface and a place to store the
choice. The managed tier needs billing. Each is a clean follow up, none blocks
the MVP.

**How (sketch).** Streaming: switch the provider abstraction to return a stream
and the route to a `ReadableStream`, and have the client pane append deltas;
persist the full assistant message on completion (the DB write path is
unchanged). Model choice: a nullable `model` column on a per org chat settings
row, defaulting to the current constants in `src/lib/chat/providers.ts`.

---

## Tickets: deleting tickets, submitting on behalf, and a deeper role ladder

**What.** Three ideas raised after using the feature live: let admins remove
tickets, let admins open a ticket for someone else (the walk up and phone
call case), and split the admin tier into a super admin for IT people and a
lighter admin for staff.

**Where things stand today, so the gap is precise.** Resolving needs no new
power: an admin already moves any ticket through open, in progress,
resolved, and closed with the status control, and the sweep closes resolved
tickets after 7 days. What nobody can do is delete a ticket, and everyone
submits only as themselves. Both are deliberate, which is why each idea
below gets a pros and cons pass instead of a straight yes.

**Deleting tickets: pros and cons.**
- *Pros.* Real queues accumulate junk: spam, test submissions, duplicates,
  accidents. Admins will want a broom. Deletion is also the blunt tool for
  privacy requests when a ticket body contains personal information someone
  wants gone.
- *Cons.* The whole trust story of the trail is that what happened,
  happened: comments and events are immutable and nobody edits history.
  Hard delete is the biggest possible edit of history. It also silently
  destroys other people's words (comments cascade away with the ticket),
  skews the future reporting numbers (BRD F18 sells resolution counts to
  MSP clients), and hands an admin the tool to make an embarrassing miss
  disappear.
- *Recommendation.* Archive, not delete: an `archived_at` column, admin
  only, hiding the ticket from every default view behind an Archived
  filter. History stays intact, junk leaves the queue, and nothing lies.
  Hard delete stays service role only, reserved for genuine privacy
  removals, and lands in the audit log (BRD F12) when that exists.

**Submitting on behalf of someone: pros and cons.**
- *Pros.* Persona P2 lives on walk ups and phone calls; the IT person
  should be able to capture "Dana at the front desk called about the
  scanner" as Dana's ticket, so Dana can follow it.
- *Cons.* `submitted_by` is currently pinned to the session by RLS, and
  that pin is what makes the submitter claim trustworthy. Loosening it for
  admins would quietly weaken the whole visibility model.
- *Recommendation.* Do not loosen the pin. Add a separate `requested_for`
  column the admin may set: `submitted_by` stays the person who typed it
  (true), `requested_for` says who it is for, and the member policy widens
  to "tickets you submitted or tickets requested for you."

**Super admin for IT, admin for staff: pros and cons.** The schema already
reserved the ladder for this in migration 001: owner, admin, technician,
member (BRD F1). So this needs no new invention, only activation: owner is
the super tier, technician is the "IT staff who work tickets" tier, and
admin sits between.
- *Pros.* Least privilege: a technician can work every ticket without being
  able to change org membership or billing; an office manager admin can
  watch the queue without touching org settings. Accountability improves
  because the trail's actor means a narrower thing.
- *Cons.* Every table's policies grow more clauses, and the isolation suite
  grows a case for each role and verb; the permission matrix is real
  ongoing cost. A solo MSP gains nothing from four tiers (they are all four
  roles at once). And Clerk sync only maps admin and member today, so owner
  and technician need in app role management built first (clerk-sync.ts
  assigns them in app by design).
- *Recommendation.* Activate technician together with assignment (both
  answer "whose desk is this on") rather than as its own task, keep member
  exactly as simple as it is, and treat owner vs admin separation as a
  Phase 2 concern when billing (F13) gives owner something only owners
  should touch.

---

## Tickets: the follow ups parked by the Task 3 ruling

**What.** Four things the tickets feature deliberately shipped without:
email notifications on ticket activity, assignment (whose desk is this on),
priorities and categories, and the separate client portal for people outside
the org. Also parked, smaller: comment editing (comments are immutable in
this build; a wrong comment is corrected by a follow up comment).

**Why.** Task 3 scoped tickets to lifecycle, role based visibility, the
system trail, and the Get help surface. Each parked item pulls in real
design work (notifications need per org preferences and BRD F10 plumbing;
assignment wants the technician role to mean something; the portal is BRD
persona P3 with its own auth story). Capturing them here keeps the task PR
honest without losing the ideas.

**How (sketch).** Notifications ride the existing Resend/Discord work when
BRD F10 lands, triggered where ticket_events are written. Assignment is a
nullable assigned_to column plus a policy widening and a queue filter.
Priorities are a column and a sort tweak; resist building them before a real
queue is long enough to need triage. The portal reuses the Get help surface
per BRD D4, scoped to a portal role.

---

## Monitors: run the first check immediately on save

**What.** When a user adds a monitor and presses save, check the URL once right
away, instead of leaving it Pending until the next cron sweep. After that first
immediate check, the monitor falls back to its configured interval as normal.

**Why.** Today a new monitor shows Pending until the daily sweep runs (and on
the free Vercel Hobby plan that can be up to a day away), so the user gets no
confirmation that the URL they entered is even reachable. An instant first
check turns the add flow into immediate feedback: green, red, or a clear error
the moment they save. It also makes the empty to populated transition feel
alive rather than dormant.

**How (sketch).** In the create path (`src/app/dashboard/monitors/actions.ts`
→ `createMonitor` in `src/lib/db/monitors.ts`), after the row is inserted, run
one check and record it:

- Reuse `runMonitorCheck` from `src/lib/monitoring/check.ts` so the SSRF guard,
  the 10 second timeout, and the up/down logic are identical to the sweep. Do
  not fork a second checker.
- Writing the result means writing `monitor_checks` and updating
  `monitors.last_status` / `last_checked_at`, which are service role only by
  design (RLS + GRANTs). A user session cannot write them, so the immediate
  check has to go through a server side path that uses the admin client, the
  same narrow exception the cron route already uses. Keep that write in one
  place; do not widen the grants.
- The check can take up to 10 seconds. Decide whether the save waits for it
  (simpler, but the form hangs on a slow target) or the row is created first
  and the check runs right after so the redirect is instant and the result
  lands a moment later. The second reads better and matches how the cron sweep
  already separates "record the monitor" from "record a check."
- The interval logic already treats `last_checked_at = null` as due, so once
  the first check stamps that column, the existing sweep math carries the
  monitor forward on its normal interval with no special casing.

**Blocked on nothing.** This is a self contained follow up to Phase 1 Task 1;
it can land any time after the monitors feature without touching incidents.
