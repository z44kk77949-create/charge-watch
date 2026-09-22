-- migration-003 — store the PIN work factor per row.
--
-- Why: PBKDF2 at the original 150,000 iterations costs ~19 ms of CPU, and the
-- Workers FREE plan allows 10 ms per request. Every PIN operation was being
-- killed by the platform (Cloudflare error 1102) before it could answer, which
-- surfaced in the app as "Network error — check your connection".
--
-- The work factor is now 25,000 by default (~4 ms), settable per deployment
-- with the PIN_ITERATIONS variable, and recorded HERE against each row. Storing
-- it is what makes it changeable: a later increase applies to new and reset
-- PINs while every PIN already set keeps verifying against the count it was
-- written with, so nobody is locked out by a config change.
--
-- Rows written before this column existed verify at 150,000 (see
-- LEGACY_PIN_ITERS in functions/api/_util.js).

alter table staff add column pin_iters integer;
