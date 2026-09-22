-- Charge Watch — full schema (Cloudflare D1 / SQLite).
--
-- This file is the CURRENT-STATE reference: what a fresh database looks like
-- after every migration has run. It is NOT the thing you apply to a live
-- database — that's `db/migration-NNN.sql`, applied in order. Keep this file in
-- step whenever you add a migration.
--
-- Conventions (mirrored from the Leopard Safety Watch house rules):
--   • Every migration is idempotent (`if not exists` / `on conflict do nothing`)
--     because the migrate workflow re-runs every file on every push.
--   • An UPDATE of an existing row guards on the stale value, so a re-run can
--     never revert an edit made in the app.
--   • Timestamps are ISO-8601 UTC strings (`2026-09-21T18:51:33.812Z`), written
--     by the application, never by SQLite's localtime-sensitive helpers.
--   • Ids are application-generated UUIDv4 strings.

-- ---------------------------------------------------------------------------
-- settings — live, owner-tunable values. Code holds fallbacks only; the DB wins.
-- ---------------------------------------------------------------------------
create table if not exists settings (
  key         text primary key,
  value       text not null,
  updated_at  text
);

-- ---------------------------------------------------------------------------
-- tents — the physical charging points. A ticket always belongs to exactly one.
-- ---------------------------------------------------------------------------
create table if not exists tents (
  id          text primary key,
  name        text not null,
  code        text not null unique,   -- short prefix used in ticket refs, e.g. "A"
  location    text,                   -- free text: "Next to the main stage bar"
  slots       integer,                -- informational capacity, not enforced
  active      integer not null default 1,
  created_at  text not null
);
create index if not exists idx_tents_active on tents(active);

-- ---------------------------------------------------------------------------
-- staff — the people running the tents. Sign in with username + PIN.
--   role: 'handler' (one tent) | 'admin' (all tents + setup) | 'owner' (admin,
--   and cannot be demoted or deactivated by anyone but another owner).
-- ---------------------------------------------------------------------------
create table if not exists staff (
  id            text primary key,
  name          text not null,
  username      text not null unique collate nocase,
  pin_hash      text,                 -- PBKDF2-SHA256, hex
  pin_salt      text,                 -- hex
  pin_iters     integer,              -- the work factor this hash was made with
  pin_set_at    text,
  role          text not null default 'handler',
  tent_id       text references tents(id),
  active        integer not null default 1,
  fail_count    integer not null default 0,
  locked_until  text,
  created_at    text not null,
  last_seen_at  text
);
create index if not exists idx_staff_active on staff(active);

-- ---------------------------------------------------------------------------
-- customers — the people whose chargers these are. Created when a claim code is
-- first redeemed; they never type a password. `display_name` is whatever they
-- choose to be called, and is the only personal data we ask for.
-- ---------------------------------------------------------------------------
create table if not exists customers (
  id                text primary key,
  display_name      text,
  telegram_chat_id  text,
  notify_telegram   integer not null default 1,
  notify_push       integer not null default 1,
  created_at        text not null,
  last_seen_at      text
);
create index if not exists idx_customers_tg on customers(telegram_chat_id);

-- ---------------------------------------------------------------------------
-- tickets — one row per charger handed over. The heart of the app.
--
-- Two identifiers, deliberately different in kind:
--   ref        public, human, spoken across a counter ("A-041"). Not a secret.
--   claim code secret, 8 characters, issued once at intake and never stored in
--              the clear — only `claim_hash` (sha-256) and `claim_hint` (the
--              last 3 characters, so staff can confirm they're looking at the
--              right slip without the database holding the code itself).
--
-- status: received -> charging -> ready -> collected, plus `held` for anything
-- that needs a human (damaged unit, wrong label, dispute). Staff may move a
-- ticket backwards; every move is written to audit_log.
-- ---------------------------------------------------------------------------
create table if not exists tickets (
  id            text primary key,
  ref           text not null unique,
  tent_id       text not null references tents(id),
  customer_id   text references customers(id),
  owner_name    text,                 -- what the handler wrote on the label
  label         text,                 -- the physical tag number on the charger
  device_desc   text,                 -- "black Anker 20000mAh, blue cable"
  slot          text,                 -- bay / port the unit is plugged into
  status        text not null default 'received',
  claim_hash    text not null,
  claim_hint    text,
  notes         text,
  received_at   text not null,
  charging_at   text,
  ready_at      text,
  collected_at  text,
  received_by   text references staff(id),
  ready_by      text references staff(id),
  collected_by  text references staff(id),
  released_manually integer not null default 0,
  release_note  text,                 -- required reason when released without the code
  reminded_at   text,                 -- last "still waiting" nudge, so we send one per window
  created_at    text not null,
  updated_at    text not null
);
create index if not exists idx_tickets_status   on tickets(status);
create index if not exists idx_tickets_tent     on tickets(tent_id, status);
create index if not exists idx_tickets_customer on tickets(customer_id);
create index if not exists idx_tickets_claim    on tickets(claim_hash);
create index if not exists idx_tickets_label    on tickets(label);

-- ---------------------------------------------------------------------------
-- sessions — the bearer for every request, for BOTH kinds of user.
-- Only the sha-256 of the token is stored, so a database read can never yield a
-- working credential.
-- ---------------------------------------------------------------------------
create table if not exists sessions (
  id            text primary key,
  token_hash    text not null unique,
  subject_type  text not null,        -- 'customer' | 'staff'
  subject_id    text not null,
  device        text,
  created_at    text not null,
  last_seen_at  text,
  expires_at    text not null,
  revoked_at    text
);
create index if not exists idx_sessions_subject on sessions(subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- push_subscriptions — one row per installed browser that accepted push.
-- ---------------------------------------------------------------------------
create table if not exists push_subscriptions (
  id            text primary key,
  subject_type  text not null,
  subject_id    text not null,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  created_at    text not null
);
create index if not exists idx_push_subject on push_subscriptions(subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- audit_log — append-only. Every status change, release and setup edit.
-- Oversight reads it; nothing in the app deletes from it.
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id           text primary key,
  at           text not null,
  actor_type   text,                  -- 'staff' | 'customer' | 'system'
  actor_id     text,
  actor_name   text,                  -- denormalised so history survives deletion
  action       text not null,         -- 'intake' | 'status' | 'release' | ...
  ticket_id    text,
  ticket_ref   text,
  detail       text,                  -- short human sentence
  flagged      integer not null default 0
);
create index if not exists idx_audit_at      on audit_log(at);
create index if not exists idx_audit_ticket  on audit_log(ticket_id);
create index if not exists idx_audit_flagged on audit_log(flagged);
