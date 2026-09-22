# Journal

The running memory for this app. **Read the top block first; append to the log
last, in the same push as your code.**

The code on `main` is the source of truth — this file describes it and never
overrides it. Dated log entries are append-only history, not a to-do list.
Outstanding work lives only in "Held for later" below.

---

## Where we stopped

**Live on Cloudflare Pages**, deployed from `z44kk77949-create/charge-watch`.
Not yet used at a real tent.

Done: repo created and pushed; Pages project `charge-watch` connected to `main`
(no build command, output `public`); D1 `charge-watch` bound as `DB`;
`ADMIN_INIT_KEY` and `PAIR_SECRET` set in the dashboard; migrations 001 and 002
already applied to the database.

**Next, in order:**

1. **Confirm `/api/health`** reports `database.bound`, `database.reachable` and
   `pair_signing` all true. That is the whole configuration, checked in one
   request, and it never reveals a value.
2. **Create the owner account** at `/admin/` using the setup key. The form
   closes permanently once one staff row exists.
3. **Set up a tent and one handler** (Admin → Tents, Admin → Staff).
4. **Walk one charger end to end on real phones**: take it in at `/tent/`, scan
   the slip with a phone camera, mark it ready, collect it with the code in the
   app. A desk cannot find what that will find.
5. **Rotate `ADMIN_INIT_KEY`** once the owner account exists — it was generated
   in a chat session, and after setup it is only needed for the one-time
   Telegram webhook registration.

Deliberately not done yet: Telegram, web push, and the reminder cron. All three
are dormant until their variables are set, and none of them block a first run.

### Held for later

- **The app name is a first suggestion, not a decision.** "Charge Watch" was
  chosen to sit in the same family as Safety Watch and Duty Watch. If Scott
  wants something else, it changes in few places: the three `<title>`s and
  headers, the three manifests, and the repo name — the code never says it.
- **The "Charge" brand theme (slate + cyan) is new to the family** and needs
  Scott's eye. Light and Dark reuse the family palettes exactly; only the brand
  theme is this app's own. If he'd rather it matched the black-and-gold, that's
  a token block in `public/shared/app.css`.
- **No guided tour and no "what's new" changelog yet.** Both are house systems
  in the sibling app. They were left out deliberately for a first version aimed
  at a single event — a tour that teaches three tabs is longer than the tabs.
  Worth adding if the app outlives XWB.
- **Printing the slip** uses the browser's print dialog and a print stylesheet.
  If the tents end up with a thermal label printer, that wants its own path.
- **No bulk actions on the board.** "Mark all of bay B ready" is the obvious
  one; deliberately deferred until a real shift shows whether it's needed.
- **Reminders fire on a 30-minute GitHub schedule.** If the event runs somewhere
  with a hard curfew, a "last call" broadcast to everyone still holding a
  charger would be more useful than a per-ticket nudge.

### Decisions worth remembering

- **The claim code is the customer's credential, not just a lookup.** Presenting
  an already-claimed code signs you into that same account rather than creating
  a second one, so two people sharing one slip both get the notification.
  Whoever holds the slip can already collect the charger physically, so this
  grants nothing the paper didn't.
- **Collection codes are derived, never stored.** The claim code is kept only as
  a hash, so the app genuinely cannot re-display it — the six-digit rotating
  code exists to fill that gap, and expires on its own.
- **Releasing without a code is allowed, and recorded.** Refusing outright would
  just move the problem to a handler improvising. It needs a written reason and
  shows flagged in Oversight.
- **A handler with no tent sees nothing, not everything.** An unassigned account
  is a setup mistake; failing closed is the safe reading.

---

## Log

### 2026-09-21 — built, end to end

First build. Cloudflare Pages + Functions + D1, three surfaces, no build step,
no dependencies.

- **Backend** — 16 endpoints under `functions/api/`. Sessions for both customers
  and staff in one table, bearer tokens stored as hashes. PBKDF2 PINs with
  lockout. Claim codes hashed; collection codes derived by HMAC over a
  five-minute window and never stored. Telegram and Web Push both dormant until
  configured.
- **Frontend** — the house kit ported from Leopard Safety Watch (`core.js`,
  `dialog.js`, `app-refresh.js`) with the `lsw*` prefix renamed to `cw*`, plus a
  new `theme.js` and a shared `app.css` carrying the design tokens and four
  themes. The feedback-photo helpers were dropped — there is no feedback inbox
  here, and an unused house system drifts.
- **QR** — written from the specification (`public/shared/qr.js`), because the
  deploy environment has no npm and no egress. `tests/qr.test.mjs` verifies it
  by Reed-Solomon syndromes, BCH divisibility, fixed geometry, and a round trip
  through a separately written decoder at every length from 1 to 213 bytes. It
  caught a reversed generator polynomial on its first run — the encoder had been
  building `(a^i + x)` instead of `(x + a^i)`, so no code would have scanned.
- **Icons** — generated by `tools/make-icons.py` (pure stdlib), three identities
  so the customer app, tent console and admin console are distinguishable on a
  home screen.
- **Tests** — seven suites, 120-odd assertions, no install required.
  `tests/guards.test.mjs` enforces the rules statically: no Cloudflare config
  file, no native dialogs, no hardcoded colours, no unescaped user data in HTML,
  no SQL interpolation, no credential in a response, every migration idempotent.
- **Database** — `charge-watch` created in APAC;
  `migration-001` and `migration-002` applied.

Not deployed. See "Where we stopped".
