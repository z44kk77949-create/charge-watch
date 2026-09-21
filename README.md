# Charge Watch

Portable-charger custody for event charging tents: take someone's power bank in,
charge it, tell them when it's ready, and give it back to the right person.

- **Customers** (`/`) never sign up. The slip from the tent carries a code and a
  QR; scanning it with a phone camera signs them in, links the charger, and
  shows its status. They get a Telegram message or a push notification the
  moment it's ready, and a rotating code to show at the counter.
- **Handlers** (`/tent/`) take chargers in, run the board, and hand them back —
  scanning the customer's code or typing it, on a phone or a laptop.
- **Organisers** (`/admin/`) set up tents and staff, tune how it runs, and see
  what needed a human.

Cloudflare Pages + Pages Functions + D1. No build step, no dependencies.

```bash
node tests/run.mjs        # syntax check + seven suites, no install needed
```

| | |
|---|---|
| **Setting it up** | [`docs/DEPLOY.md`](docs/DEPLOY.md) |
| **How it fits together** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| **Rules for changing it** | [`CLAUDE.md`](CLAUDE.md) |
| **What changed, and what's next** | [`docs/JOURNAL.md`](docs/JOURNAL.md) |
