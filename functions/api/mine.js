// The customer's own view: my chargers, and the settings that control how I'm
// told about them.
//
// Scoping is absolute and server-side: every read is `where customer_id = ?`
// against the caller resolved from their bearer. A ticket id in the request
// body is never used to select a row.

import {
  db, noDb, json, all, first, run, now, clean, uuid,
  requireCustomer, subjectByToken, collectCode, qrPayload, normCode, sha256hex,
  STATUS_LABEL, audit, getSettings,
} from "./_util.js";

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const cred = new URL(request.url).searchParams.get("code");
  const me = await requireCustomer(env, cred);
  if (!me) return json({ ok: false, error: "Not signed in" }, 401);

  const rows = await all(env,
    `select t.id, t.ref, t.label, t.device_desc, t.slot, t.status, t.notes,
            t.received_at, t.charging_at, t.ready_at, t.collected_at,
            n.name as tent_name, n.location as tent_location
       from tickets t
       left join tents n on n.id = t.tent_id
      where t.customer_id = ?
      order by case t.status when 'ready' then 0 when 'charging' then 1 when 'received' then 2 when 'held' then 3 else 4 end,
               t.received_at desc`,
    [me.id]);

  // A collection code is minted only for a charger that is still here. There is
  // nothing to collect once it has gone home, and showing a live code against a
  // collected ticket invites a confusing second visit to the counter.
  const tickets = [];
  for (const t of rows) {
    const collectable = t.status !== "collected";
    const cc = collectable ? await collectCode(env, t.id) : null;
    tickets.push({
      ...t,
      status_label: STATUS_LABEL[t.status] || t.status,
      collect_code: cc ? cc.code : null,
      collect_qr: cc ? qrPayload(t.ref, cc.code) : null,
      collect_expires_in: cc ? cc.expires_in : null,
    });
  }
  return json({ ok: true, tickets });
}

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const b = await request.json().catch(() => ({}));
  const me = await requireCustomer(env, b.code);
  if (!me) return json({ ok: false, error: "Not signed in" }, 401);

  if (b.action === "profile") {
    const name = clean(b.display_name, 60);
    await run(env, "update customers set display_name = ?, notify_telegram = ?, notify_push = ? where id = ?",
      [name || null, b.notify_telegram ? 1 : 0, b.notify_push ? 1 : 0, me.id]);
    return json({ ok: true });
  }

  if (b.action === "unlink_telegram") {
    await run(env, "update customers set telegram_chat_id = null where id = ?", [me.id]);
    return json({ ok: true });
  }

  // Add a second charger to this account — the same claim code redemption as
  // sign-in, but for someone already signed in, so it attaches rather than
  // creating another account.
  if (b.action === "add") {
    const code = normCode(b.claim_code);
    if (code.length !== 8) return json({ ok: false, error: "A collection code is 8 characters." }, 400);
    const t = await first(env, "select id, ref, customer_id from tickets where claim_hash = ?", [await sha256hex(code)]);
    if (!t) return json({ ok: false, error: "That code doesn’t match a charger." }, 404);
    if (t.customer_id === me.id) return json({ ok: true, already: true, ref: t.ref });
    if (t.customer_id) return json({ ok: false, error: "That charger is already linked to another phone. Ask the tent for help." }, 409);
    const upd = await run(env, "update tickets set customer_id = ?, updated_at = ? where id = ? and customer_id is null", [me.id, now(), t.id]);
    if (!upd.ok) return json({ ok: false, error: "Couldn’t link that charger — try again." }, 500);
    await audit(env, { actorType: "customer", actorId: me.id, action: "claim", ticketId: t.id, ticketRef: t.ref, detail: "Second charger linked to an existing account" });
    return json({ ok: true, ref: t.ref });
  }

  return json({ ok: false, error: "Unknown action" }, 400);
}
