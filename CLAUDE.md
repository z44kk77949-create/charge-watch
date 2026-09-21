# Charge Watch

Portable-charger custody for event charging tents. Owner: Scott. Built and
maintained through Claude sessions — treat this file as the session bootstrap.

**First action every session: read `docs/JOURNAL.md`** — its top block says
what's current and what's left. **Last action every session: append your entry
to it**, in the same push as your code. It is the cross-device memory.

**The code on `main` is the source of truth. The journal describes it; it never
overrides it.** If an old journal entry disagrees with the code, the code is
right — fix the journal, never "restore" the code to match a note. Dated log
entries are append-only history, not a to-do list.

Sibling app: **Leopard Safety Watch** (`leopard-safety-watch`), which is where
this app's house systems, conventions and design language come from. That repo
holds the MASTER copy of `docs/DESIGN-PREFS.md`; the copy here travels with it.
When Scott expresses a new design preference here, update the local copy **and
say in your summary that it needs syncing back to the master**.

## What it does

A tent takes someone's power bank, charges it, and gives it back to the right
person. Three surfaces on one API:

- **`public/index.html`** — the customer's app (My chargers · Collect · Me).
  No sign-up: a claim code from the tent's slip *is* the account.
- **`public/tent/index.html`** — the handler's console (Take in · Board ·
  Collect). Username + PIN.
- **`public/admin/index.html`** — setup and oversight (Tents · Staff ·
  Oversight). Admins and owners only.

`docs/ARCHITECTURE.md` is the map — where everything lives and why.
`docs/DEPLOY.md` is how it gets to Cloudflare and what each environment
variable does.

## The rules that matter most

### 1. Never check in a platform config file

No `wrangler.toml`/`.json`/`.jsonc`, or any equivalent. A repo-level Cloudflare
config silently becomes the Pages project's source of truth and **destroys the
dashboard-managed environment variables and bindings** — that is how a sibling
app went down at its login gate for over an hour, at night. Bindings and
secrets live in the Cloudflare dashboard, only. Enforced by
`.github/workflows/config-guard.yml` and `tests/guards.test.mjs`. Don't work
around either.

### 2. The client never decides that a customer is verified

`/api/collect` `lookup` only *reports* whether a proof checked out, so the
handler's screen can say so. `release` **re-derives the verdict from scratch**,
for the ticket it was handed. A response that said `verified: true` is not an
input to anything. If you ever find yourself trusting a client-supplied
`verified`, `ticket_id` without a scope check, or an id that didn't come from
the bearer — stop; that is the bug this app exists to avoid.

### 3. Secrets are stored as hashes, and shown once

- **Claim codes** (the slip) — sha-256 in `claim_hash`, plus `claim_hint`, the
  last three characters, so a handler can confirm the right slip without the
  database holding the code. Shown exactly once, at intake. Lost before the
  phone is linked → reissue from the Board, which invalidates the old one.
- **Collection codes** (the app) — never stored at all. Six digits derived by
  HMAC from the ticket id and a five-minute window, recomputed to verify. That
  is why the app can show a code it never received.
- **Staff PINs** — PBKDF2-SHA256, 150k iterations, per-person salt, with
  lockout after five wrong tries.

### 4. Server-side authorisation, every time

Resolve the caller from the bearer (`requireStaff` / `requireCustomer`), then
filter the query to what that caller may see — a handler their own tent, a
customer their own tickets. The UI's buttons are a convenience, never the
permission. Two rails in `staff.js` must stay: **no escalation** (an admin
cannot create or promote an owner, or edit one) and **no owner lockout** (the
last active owner cannot be demoted or deactivated).

### 5. Live settings beat constants

`DEFAULT_SETTINGS` in `_util.js` is a FALLBACK for an unseeded database, not the
live value. The owner tunes these in Admin → Oversight and the DB wins. Editing
the constant does not change what the app uses, and is never the way to
"correct" a live value — if Scott tells you a value, put it in the app or the
journal, not in the code.

### 6. Migrations are idempotent and never revert an edit

Ship `db/migration-NNN.sql` in the same PR as the code that needs it, keep
`db/schema.sql` in step, and guard every `update` on the stale value. You can't
apply it yourself — say clearly in your summary that it needs running in the D1
console.

## House systems — reuse these, don't reinvent

| When you need to… | Use | Never |
|---|---|---|
| confirm / notify | `await cwConfirm(msg,{title,ok,danger})` · `cwToast(msg,{type})` — `shared/dialog.js` | native `confirm()`/`alert()` |
| fetch / escape / format | `api(path)` · `post(path,body)` · `esc(s)` · `fmt(ts)` — `shared/core.js` | inline `fetch` |
| a loading state | `cwSkeleton({cards,lines})` | a bare "Loading…" |
| a failed load | `cwLoadError(retry)` painted in place | a blank view, or `logout()` |
| a QR code | `cwQr.svg(text)` · `cwQr.scanStart(video,…)` — `shared/qr.js` | a CDN library (egress is blocked) |
| any colour | a CSS token (`--surface`, `--accent`, …) in `shared/app.css` | a hardcoded hex |
| a theme | `cwTheme` with the surface's own storage key | a fourth set of theme names |

A network blip must **never** sign someone out: `api`/`post` resolve to
`{ok:false,__neterr:true}` and the renderer paints `cwLoadError` in place. Only
a genuine 401 clears the token.

## Working rules

1. `node tests/run.mjs` before every commit. It syntax-checks every JS file and
   runs seven suites — including `tests/guards.test.mjs`, which enforces the
   rules above statically, and `tests/qr.test.mjs`, which verifies the
   hand-written QR encoder three independent ways.
2. Small, reviewable changes with descriptive commit messages.
3. When you fix a field bug, **sweep its class** — generalise it, hunt every
   other instance, and add a guard in `tests/guards.test.mjs` where you can. One
   report is one category check, not one patch.
4. Never commit a token, key or PIN. Never ask Scott for one — recovery
   procedures are written so he types values into the Cloudflare dashboard
   himself.
5. Data minimisation: the app asks for a display name and nothing else. No
   phone numbers, no email, no ID. Don't add a field because it would be handy.
6. Copy is written for the person reading it, in plain language, stating the
   physical consequence ("Show this at the counter", "The old slip stops
   working straight away").

## Conventions that bite

- **`esc()` everything user-typed that reaches innerHTML.** Names, tag numbers
  and notes all come from a person. `tests/guards.test.mjs` checks this
  statically, and includes a test proving the guard itself still catches a
  miss.
- **Don't duplicate frontend logic across the three surfaces** — extract to
  `public/shared/`. But diff before sharing; the three consoles' dialogs
  legitimately differ in what fields they collect.
- **The service worker caches nothing.** An offline cache on top of the
  `no-cache` headers is how a tent ends up running last week's build mid-event
  with no way to clear it.
- **A write must report failure.** `run()` returns `{ok}` and callers check it —
  a silently dropped insert is how a charger goes missing.
- **Collection is not a status change.** The board cannot set `collected`;
  that path exists only in `/api/collect`, behind the proof check.
- **Time is stored as ISO-8601 UTC strings**, written by the application. Never
  use SQLite's localtime-sensitive helpers.
