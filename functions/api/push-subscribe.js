// Store or remove one browser's Web Push subscription.
//
// Works for both kinds of user — a customer wants "your charger is ready" on
// their phone, and a handler's console may later want alerts of its own — so the
// row is keyed by (subject_type, subject_id) resolved from the bearer, never
// from anything the client claims to be.

import { db, noDb, json, run, uuid, now, subjectByToken } from "./_util.js";

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const b = await request.json().catch(() => ({}));
  const s = await subjectByToken(env, b.code);
  if (!s) return json({ ok: false, error: "Not signed in" }, 401);

  if (b.action === "unsubscribe") {
    // Scoped to the caller's own rows: knowing an endpoint string must not be
    // enough to unsubscribe somebody else's device.
    if (b.endpoint) await run(env, "delete from push_subscriptions where endpoint = ? and subject_type = ? and subject_id = ?", [String(b.endpoint), s.type, s.id]);
    return json({ ok: true });
  }

  const sub = b.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ ok: false, error: "subscription required" }, 400);

  // A device that re-subscribes gets a new endpoint but may also reuse one that
  // belonged to a previous sign-in on the same browser — upsert on the endpoint
  // so it moves to whoever is signed in now.
  const res = await run(env,
    `insert into push_subscriptions (id, subject_type, subject_id, endpoint, p256dh, auth, created_at)
     values (?,?,?,?,?,?,?)
     on conflict (endpoint) do update set subject_type = excluded.subject_type, subject_id = excluded.subject_id,
                                          p256dh = excluded.p256dh, auth = excluded.auth`,
    [uuid(), s.type, s.id, String(sub.endpoint), String(sub.keys.p256dh), String(sub.keys.auth), now()]);
  if (!res.ok) return json({ ok: false, error: "Couldn't save that subscription." }, 500);
  return json({ ok: true });
}
