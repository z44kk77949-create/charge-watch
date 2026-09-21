-- migration-002 — seed the live, owner-tunable settings and a first tent.
--
-- Idempotent AND non-reverting: every insert is `on conflict do nothing`, so a
-- re-run on a later deploy can never overwrite a value the owner has since
-- changed in the app. (This is the rule that bit the Safety Watch: the migrate
-- workflow re-runs every file on every push, so an unconditional UPDATE quietly
-- resets owner edits each deploy. Never write one here.)
--
-- What each setting does:
--   event_name              shown in the header of all three surfaces
--   ready_message           the notification text sent when a charger is ready
--   reminder_hours          how long a READY charger waits before its owner is
--                           nudged again (0 disables the reminder entirely)
--   collect_requires_code   1 = the claim code (or its QR) is required to
--                           release a charger; a release without one is still
--                           possible but is recorded as a manual release with a
--                           reason and shows flagged in Oversight.
--   auto_charging_on_intake 1 = a new ticket goes straight to `charging` rather
--                           than sitting in `received` (for tents that plug a
--                           unit in as they take it).

insert into settings (key, value, updated_at) values
  ('event_name',              'XWB',                                                  '2026-09-21T00:00:00.000Z'),
  ('ready_message',           'Your charger is fully charged and ready to collect.',  '2026-09-21T00:00:00.000Z'),
  ('reminder_hours',          '2',                                                    '2026-09-21T00:00:00.000Z'),
  ('collect_requires_code',   '1',                                                    '2026-09-21T00:00:00.000Z'),
  ('auto_charging_on_intake', '1',                                                    '2026-09-21T00:00:00.000Z')
on conflict (key) do nothing;

-- A first tent so Intake works the moment the app is deployed. The owner
-- renames it (or adds more) in Admin → Tents; because this is `do nothing`, a
-- rename survives every later deploy.
insert into tents (id, name, code, location, slots, active, created_at) values
  ('11111111-1111-4111-8111-111111111111', 'Tent A', 'A', null, 24, 1, '2026-09-21T00:00:00.000Z')
on conflict (id) do nothing;
