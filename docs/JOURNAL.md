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

`/api/health` confirmed green on 22 Sep: database bound and reachable,
`pair_signing` true, Telegram and push not configured (as intended).

**Next, in order:**

1. **Create the owner account** at `/admin/` using the setup key, with a
   **6-digit** PIN. The form closes permanently once one staff row exists.
2. **Set up a tent and one handler** (Admin → Tents, Admin → Staff).
3. **Walk one charger end to end on real phones**: take it in at `/tent/`, scan
   the slip with a phone camera, mark it ready, collect it with the code in the
   app. A desk cannot find what that will find.
4. **Rotate `ADMIN_INIT_KEY`** once the owner account exists — it was generated
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

### 2026-09-22 — deployed, and the first real bug

Live on Cloudflare Pages. Repo created, pushed, project connected, D1 bound as
`DB`, `ADMIN_INIT_KEY` and `PAIR_SECRET` set in the dashboard. `/api/health`
came back fully green.

Then the owner-setup form failed with "Network error — check your connection",
and it was neither the network nor the connection.

**Root cause: the Workers FREE plan allows 10 ms of CPU per request, and PBKDF2
at 150,000 iterations costs ~19 ms.** Every PIN operation was being killed by
the platform (Cloudflare error 1102) before it could answer. `/api/health`
worked throughout because it barely uses any CPU, which is what made the
failure look like a routing or connectivity problem rather than a resource one.

Three fixes, and a class swept rather than a patch:

- **The work factor now fits the budget.** 25,000 iterations (~4 ms measured),
  overridable per deployment with `PIN_ITERATIONS` for anyone on Workers Paid,
  and **recorded against each row** (`pin_iters`, migration-003) so it can be
  raised later without invalidating PINs already set. `tests/util.test.mjs`
  guards the default against creeping back over the budget, with the
  measurements in the comment so the next person doesn't have to re-derive
  them.
- **PINs are now 6 to 10 digits, not 4.** This is the change that actually
  improves security. At four digits there are ten thousand candidates and no
  work factor rescues that; six digits is a hundred times harder and costs a
  handler nothing. The iteration count only ever raised the offline cost from
  trivial to inconvenient — the real controls are the length floor and the
  lockout.
- **The error message was its own bug.** The frontend treated *any* non-JSON
  response as a dropped connection, so a crashed or killed function told the
  user to check their wifi. There is now one shared reader (`__readJson` in
  `core.js`) that distinguishes a server fault from a network one and says
  which, plus `postRaw` so all three sign-in screens report it identically
  instead of each rolling their own `fetch`. A guard in
  `tests/guards.test.mjs` bans a surface from calling `fetch("/api/...")`
  directly again.

Lesson worth keeping: **a serverless platform limit can look exactly like a
network fault**, and the app's own error copy decides which one the operator
goes hunting for. Getting that wrong cost a diagnostic round trip with the
owner standing at the dashboard.

### 2026-09-22 — the slip's QR wouldn't scan

Owner account created; first intake produced a slip whose QR a phone camera
would not pick up. The encoder was not at fault — `tests/qr.test.mjs` decodes
every matrix back to its input — because the bug was in the *rendering*, which
those tests didn't reach.

Two causes, both now fixed:

- **The quiet zone was 2 modules. The specification requires 4.** The quiet
  zone is how a camera finds the code's boundary at all, and the white plate's
  own padding is no substitute because the scanner sees the whole frame, not
  the CSS. This alone can make a perfectly valid code invisible to a detector.
- **Each module was drawn as its own 1×1 rectangle.** With `crispEdges` and a
  fractional module size, adjacent squares snap to device pixels independently
  and can leave hairline white seams through the dark blocks. The renderer now
  emits one rectangle per horizontal RUN of dark modules, which removes almost
  every internal seam and shrinks the markup.

Also enlarged the plate (280 → 330 px on screen, 230 → 270 in print) for more
pixels per module.

The lesson to keep: **a passing encoder test says nothing about whether the
thing on the glass can be read.** The suite verified bits and geometry all the
way down to Reed-Solomon syndromes, and still missed a two-line rendering
choice that made the whole feature useless in the field. The new tests check
the drawn output — quiet zone and run coverage — not just the matrix.

Also, at the owner's request: **the "What it looks like" field is gone from
intake.** The tag number and the charging point are what a handler needs at the
counter; a description is a keystroke in a queue. The field remains on the Edit
dialog for the rare disputed charger, and the column is untouched.
