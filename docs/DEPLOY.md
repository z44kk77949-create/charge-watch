# Deploying Charge Watch

Cloudflare Pages + Pages Functions + a D1 database. No build step, no npm
install — Pages serves `public/` and runs `functions/` as the API.

**The rule that outranks everything else on this page: bindings, environment
variables and secrets are configured in the Cloudflare dashboard, and nowhere
else.** Never add a `wrangler.toml` (or `.json`/`.jsonc`) to this repo. A
checked-in platform config silently becomes the Pages project's source of truth
and destroys the dashboard-managed variables — that is how a sibling app went
down at its login gate for over an hour, at night, with nobody able to get back
in. Two guards enforce it (`.github/workflows/config-guard.yml` and
`tests/guards.test.mjs`); don't work around them.

---

## 1. The Pages project

Connect this repository in **Cloudflare → Workers & Pages → Create → Pages →
Connect to Git**, then:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | None |
| Build command | *(leave empty)* |
| Build output directory | `public` |
| Root directory | `/` |

Pages picks up `functions/` from the repository root automatically, regardless
of the output directory. A push to `main` deploys in about a minute; every other
branch gets its own preview URL.

## 2. The database

A D1 database named **`charge-watch`** already exists, in the APAC region:

```
database id: fec09cd1-6e7d-42f2-b2b2-d2c50e6b1d67
```

Bind it to the Pages project under **Settings → Functions → D1 database
bindings**, for both Production and Preview:

| Variable name | Database |
|---|---|
| `DB` | `charge-watch` |

Until that binding exists, every endpoint answers `503` with a plain message and
the app tells you the database isn't connected. That is deliberate — an
unconfigured deployment is dormant, never broken with a stack trace.

### Migrations

`db/migration-001.sql` (schema) and `db/migration-002.sql` (seed settings and a
first tent) **have already been applied** to that database. For anything new:

1. Write `db/migration-NNN.sql` in the same pull request as the code that needs
   it. It must be idempotent — `if not exists`, `on conflict do nothing` — and
   any `update` must guard on the stale value, or re-running it will revert an
   edit made in the app.
2. Apply it in **Cloudflare → Storage & Databases → D1 → charge-watch →
   Console**: paste the file and run it.
3. Update `db/schema.sql` so it still describes a fresh database.

`tests/guards.test.mjs` fails the build if a migration isn't idempotent.

## 3. Environment variables

**Settings → Environment variables**, for Production (and Preview if you use
it). Anything not set simply leaves that feature dormant.

| Variable | Needed? | What it does |
|---|---|---|
| `ADMIN_INIT_KEY` | **Required once** | Unlocks the first-run owner account at `/admin/`. Also the fallback signing secret if `PAIR_SECRET` is unset. Make it long and random. |
| `PAIR_SECRET` | Strongly recommended | Signs Telegram pairing links **and the rotating collection codes**. Changing it invalidates every code currently on a customer's screen, so set it before the event and leave it alone. |
| `APP_BASE_URL` | Recommended | e.g. `https://charge-watch.pages.dev`. Used for the slip's QR link and the Telegram webhook. Falls back to the request's own origin. |
| `CRON_KEY` | For reminders | Authenticates `/api/cron/reminders`. Must match the GitHub secret of the same name. |
| `TELEGRAM_BOT_TOKEN` | For Telegram | From @BotFather. |
| `TELEGRAM_BOT_USERNAME` | For Telegram | The bot's username **without** the `@`. The app only offers "Connect Telegram" when this is set. |
| `TELEGRAM_WEBHOOK_SECRET` | For Telegram | A random string. Once set, the webhook rejects anything that isn't genuinely from Telegram. Set it. |
| `VAPID_PUBLIC_KEY` | For web push | See below. |
| `VAPID_PRIVATE_KEY` | For web push | See below. |
| `VAPID_SUBJECT` | For web push | `mailto:` address push services can contact. |
| `PIN_ITERATIONS` | Only on Workers Paid | PBKDF2 work factor for staff PINs. Leave unset on the **free plan** — the default 25,000 is chosen to fit its 10 ms CPU budget. See below. |

### The free plan's CPU budget

Workers Free allows **10 ms of CPU per request**, and PIN hashing is the only
thing in this app that comes near it. Measured: 25,000 PBKDF2 iterations is
about 4 ms; 150,000 is about 19 ms, which the platform *kills* (Cloudflare
error 1102) before the function can answer — and a killed function returns an
HTML error page, not JSON, so the app can only report a fault at our end.

So the default is 25,000. On the **Workers Paid** plan the CPU limit is 30
seconds and you can safely set `PIN_ITERATIONS` to 150000 or higher. The work
factor is recorded against each row, so raising it applies to new and reset
PINs and locks nobody out.

Staff PINs are **6 to 10 digits**. The length floor matters more than the work
factor: four digits is ten thousand candidates, which no iteration count can
protect if the database ever leaks.

**Environment variables only reach the running app on a fresh deployment.**
After saving one, trigger a new deploy (push a commit, or use *Retry deployment*
in the dashboard) — do not assume the dashboard applied it to the live version.

Check what actually landed at **`/api/health`**. It reports whether each piece is
configured and never what it is configured to:

```json
{ "ok": true, "database": { "bound": true, "reachable": true, "tickets": 0 },
  "telegram": true, "telegram_webhook_secret": true, "push": false, "pair_signing": true }
```

## 4. First run

1. Set `ADMIN_INIT_KEY`, deploy, and open **`/admin/`**.
2. It offers a setup form, because no staff account exists yet. Enter the setup
   key, your name, a username and a PIN. That creates the **owner** account.
   The form is closed from that moment — it needs both the key *and* an empty
   staff table, so it cannot be reopened by anyone who later learns the key.
3. **Tents** — rename "Tent A", set where it is, add the others. The short code
   prefixes every ticket number in that tent (`A-041`), so keep it to a
   character or two, and note it can't be changed afterwards.
4. **Staff** — add a person per handler, each assigned to their tent, each with
   a PIN you tell them. PINs are never shown again; a forgotten one is reset.
5. **Oversight → How it runs** — event name, the "ready" message, the reminder
   window, and whether a code is required to hand a charger back.
6. Handlers open **`/tent/`** and sign in. Customers use **`/`** and never sign
   up for anything — their claim code is their account.

## 5. Telegram

1. Talk to **@BotFather** → `/newbot`, take the token.
2. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and
   `TELEGRAM_WEBHOOK_SECRET` in the dashboard, then **redeploy**.
3. Visit `https://<your-domain>/api/telegram/init?key=<ADMIN_INIT_KEY>` once. It
   registers the webhook and confirms the secret was registered with it.
4. In the customer app, **Me → Connect Telegram** now appears. The deep link
   carries a signed token, so a link seen by somebody else is useless to them.

The bot also answers `/status` (what's in the tents for that person) and `/stop`
(turn the messages off).

## 6. Web push

```bash
node tools/vapid-keys.mjs
```

Run it on your own machine, put the three values in the dashboard, redeploy.
Push is then offered in the customer app's **Me** tab. On iOS it only works once
the app has been added to the Home Screen — which is why Telegram is the primary
channel and push the convenience.

## 7. Reminders

`.github/workflows/reminders.yml` calls the app every 30 minutes and it decides
what is actually due (the window is the `reminder_hours` setting; `Never` turns
it off). Add two repository secrets under **GitHub → Settings → Secrets and
variables → Actions**:

- `APP_BASE_URL` — e.g. `https://charge-watch.pages.dev`
- `CRON_KEY` — the same value as the Cloudflare variable

Without them the workflow exits quietly rather than failing.

## 8. After any infrastructure change

A green deploy is not a healthy site. After touching deployment, auth, routing
or functions, actually open the app: the customer page loads, `/tent/` signs in,
`/api/health` is all true. If you can't reach it yourself, ask someone who can
before moving on.
