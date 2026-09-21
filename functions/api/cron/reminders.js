// "Still waiting" reminders — the nudge for a charger that has been ready a
// while and nobody has come for.
//
// Called on a schedule by .github/workflows/reminders.yml (Cloudflare Pages has
// no cron of its own), authenticated with CRON_KEY. Safe to call as often as
// you like: `reminded_at` makes each ticket eligible again only once per
// reminder window, so a double-fired schedule sends nothing twice.
//
// Setting `reminder_hours` to 0 turns the whole thing off, which is the right
// answer for a short event where the tent would rather just call out names.

import { db, noDb, json, all, first, run, now, getSettings, timingSafeEqual, audit } from "../_util.js";
import { notifyCustomer } from "../_notify.js";

const MAX_PER_RUN = 100;

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!env.CRON_KEY || !timingSafeEqual(key, env.CRON_KEY)) return new Response("forbidden", { status: 403 });
  if (!db(env)) return noDb();

  const settings = await getSettings(env);
  const hours = Number(settings.reminder_hours);
  if (!isFinite(hours) || hours <= 0) return json({ ok: true, disabled: true, sent: 0 });

  const cutoff = new Date(Date.now() - hours * 3600e3).toISOString();
  // Ready long enough, linked to a phone we can actually reach, and either never
  // reminded or last reminded a full window ago.
  const due = await all(env,
    `select t.*, n.name as tent_name, n.location as tent_location
       from tickets t join tents n on n.id = t.tent_id
      where t.status = 'ready' and t.customer_id is not null
        and t.ready_at is not null and t.ready_at <= ?
        and (t.reminded_at is null or t.reminded_at <= ?)
      order by t.ready_at asc limit ?`,
    [cutoff, cutoff, MAX_PER_RUN]);

  let sent = 0;
  for (const t of due) {
    const customer = await first(env, "select * from customers where id = ?", [t.customer_id]);
    const waited = Math.floor((Date.now() - new Date(t.ready_at).getTime()) / 3600e3);
    const n = await notifyCustomer(env, customer, {
      title: `${t.label ? `Charger ${t.label}` : `Ticket ${t.ref}`} is still waiting`,
      body: `It has been ready for ${waited} hour${waited === 1 ? "" : "s"} at ${t.tent_name}${t.tent_location ? ` — ${t.tent_location}` : ""}.\n\nCollect it before the tent closes.`,
      url: "/#collect",
    });
    // Stamp regardless of delivery: a customer with notifications off must not
    // make this query return the same row on every run forever.
    await run(env, "update tickets set reminded_at = ? where id = ?", [now(), t.id]);
    if (n > 0) { sent++; await audit(env, { actorType: "system", action: "reminder", ticketId: t.id, ticketRef: t.ref, detail: `Reminded after ${waited}h waiting` }); }
  }

  return json({ ok: true, considered: due.length, sent });
}
