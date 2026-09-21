# Charge Watch — architecture map

Orientation for any session editing this app. `CLAUDE.md` is the bootstrap (the
rules); `docs/JOURNAL.md` is the running memory (what changed). This file is the
*map* — where things live, how a charger moves through them, and the patterns to
follow. Keep it current when structure changes.

## Big picture

- **No build step.** Static assets in `public/`, serverless functions in
  `functions/api/`. Push to `main` → Cloudflare Pages deploys in about a minute.
- **Three surfaces, one API, one database.** The customer app (`public/`), the
  tent console (`public/tent/`) and the admin console (`public/admin/`) all talk
  to `functions/api/` over a D1 (SQLite) database bound as `DB`.
- **Two kinds of user, one session table.** A customer signs in by redeeming a
  claim code; a staff member with a username and PIN. Both get a `CWs_…` bearer
  token whose sha-256 is what's stored.
- **Notifications out, never in.** Telegram and Web Push are both optional and
  dormant until configured; the app is fully usable with neither.

## Repository layout

```
public/
  index.html              customer app   (My chargers · Collect · Me)
  tent/index.html         tent console   (Take in · Board · Collect)
  admin/index.html        admin console  (Tents · Staff · Oversight)
  shared/
    app.css               the shell: design tokens, four themes, every component
    core.js               api() · post() · esc() · fmt() · cwSkeleton · cwLoadError
    dialog.js             cwToast · cwConfirm · the offline bar
    theme.js              cwTheme — options fixed, choice per surface
    qr.js                 QR encoder (SVG out) + camera scanner
    app-refresh.js        pull-to-refresh + new-build detection
  sw.js                   push notifications only; caches nothing
  _headers                no-cache for the shell, long cache for icons
  manifest.json           one per surface, each its own installable identity
  icons/                  generated — see tools/make-icons.py

functions/api/
  _util.js                D1 helpers, sessions, codes, PINs, settings, audit
  _notify.js              Telegram + push fan-out, and the "ready" wording
  _webpush.js             RFC 8291 / 8292 over Web Crypto
  auth.js                 claim redemption, staff PIN sign-in, owner bootstrap
  me.js                   who is calling + what their surface needs to boot
  mine.js                 the customer's own tickets and notification settings
  intake.js               a charger becomes a ticket; the only place the claim
                          code exists in the clear
  board.js                the tent's live list and its state changes
  collect.js              proof checking and release  ← the security centre
  tents.js  staff.js      setup, admin-only
  oversight.js            numbers, audit history, and the live settings
  push-subscribe.js       one row per browser that accepted push
  telegram/init.js        one-time webhook registration
  telegram/webhook.js     pairing, /status, /stop
  cron/reminders.js       the "still waiting" nudge, driven by GitHub Actions
  health.js               what's configured (never what it's configured to)

db/       schema.sql (current state) + migration-NNN.sql (what you apply)
tests/    run.mjs + seven suites, dependency-free
tools/    make-icons.py · vapid-keys.mjs
```

## The life of a charger

```
            ┌──────────┐  handler takes it in, writes a tag number
            │ received │  a ticket is created: ref A-041, claim code issued once
            └────┬─────┘
                 │  plugged in  (or straight here, if auto_charging_on_intake)
            ┌────▼─────┐
            │ charging │
            └────┬─────┘
                 │  handler marks ready  →  Telegram + push go out
            ┌────▼─────┐
            │  ready   │  ← reminders nudge from here, every reminder_hours
            └────┬─────┘
                 │  proof checked at the counter
            ┌────▼──────┐
            │ collected │  receipt sent; terminal
            └───────────┘

   held ── anything that needs a human; reachable from and back to charging
```

Every move is written to `audit_log`, with `flagged = 1` for the ones a person
had to override (a release without a code, a reissued slip). Oversight reads
those first.

## Identity, and the three proofs

The question this app really answers is *"is this your charger?"*. Three things
can answer it, and the server checks all three the same way — by recomputing,
never by trusting.

| Proof | Where it comes from | How it's checked |
|---|---|---|
| **Claim code** — 8 characters, Crockford base32 | the printed slip | sha-256 compared against `claim_hash` |
| **Collection code** — 6 digits + ticket ref | the customer's app | HMAC over (ticket id, 5-minute window), recomputed |
| **QR** — `CW1:<ref>:<digits>` | the customer's screen | parsed, then the same HMAC check |

The claim code is also the customer's **credential**: presenting it signs you
in, which is what makes a walk-up tent work — nobody registers before handing
over a charger. Presenting an already-claimed code signs you into *that same
account* rather than creating a second one, so a couple sharing one slip both
get the notification. Whoever holds the slip could also walk up and collect the
charger, so this grants nothing the paper didn't.

Because the claim code is stored only as a hash, the app **cannot** re-display
it — hence the rotating collection code, which is derived rather than stored.
That is the whole reason it exists.

Anything that isn't one of the three proofs is a **search**, and a search is not
a proof: it returns candidates, and releasing from there is a manual release
that needs a written reason and shows flagged in Oversight.

## Authorisation

`subjectByToken` resolves a bearer to `{ type, id, row }`, refusing anything
expired, revoked, or belonging to a deactivated staff account. On top of it:

- `requireCustomer(env, cred)` — the customer endpoints, which then filter every
  query by `customer_id = ?`.
- `requireStaff(env, cred, minRole?)` — `handler` < `admin` < `owner`.
- `tentScope(env, staff)` — the tent ids this person may act on: every tent for
  an admin, their own for a handler, and **an empty list means nothing visible**,
  never "all". Every board and collect query is filtered by it, so a ticket id
  from another tent simply resolves to nothing.

Two rails in `staff.js`: no escalation (an admin can neither create, promote
nor edit an owner) and no owner lockout (the last active owner can't be demoted
or deactivated). Deactivating an account or resetting a PIN also revokes that
person's sessions — otherwise the account keeps working on a phone that's
already signed in.

## The frontend shell

All three surfaces are the same chassis: a dark appbar that persists across
themes, bottom tabs as primary navigation, a ⋮ kebab for everything secondary,
and one stylesheet of design tokens. A renderer paints `cwSkeleton` while it
loads and `cwLoadError` in place if the load fails — never a blank view, and
never a sign-out on a network blip.

Four themes, named identically to the rest of the app family: **Charge** (this
app's brand, slate and cyan), Automatic, Light, Dark. The *options* are fixed
across the family; the *choice* is per surface, because an installed PWA has its
own storage.

## Why the QR code is hand-written

`public/shared/qr.js` is a QR model 2 encoder (byte mode, error correction level
M, versions 1–10) written from the specification. The deploy environment has no
npm and no network egress, so vendoring a library isn't available — and level M
rather than L because a slip lives in a pocket and gets scanned in the dark.

It is verified three independent ways in `tests/qr.test.mjs`: the Reed-Solomon
output by its syndromes and the BCH strings by divisibility (algebra, not a
restatement of the encoder); the fixed geometry of finder, timing and alignment
patterns; and a round trip through a decoder written separately, across every
payload length from 1 to 213 bytes. That suite caught a reversed generator
polynomial on the first run, which is exactly what it was for.

Scanning uses `BarcodeDetector` where it exists and says so plainly where it
doesn't — on iOS it doesn't, so the collect screen always offers typing as well,
and the printed slip carries a plain URL that any phone camera can open.
