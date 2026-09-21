// Oversight — the numbers, the history, and the owner-tunable settings.
//
// One endpoint, one page: an admin opening this tab wants "how is the night
// going, what needed a human, and what are the rules" together, not three
// screens that each half-answer it.

import {
  db, noDb, json, all, first, run, now, clean,
  requireStaff, getSettings, DEFAULT_SETTINGS, audit,
} from "./_util.js";

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const staff = await requireStaff(env, new URL(request.url).searchParams.get("code"), "admin");
  if (!staff) return json({ ok: false, error: "Only an admin can see oversight." }, 403);

  const [settings, byTent, totals, durations, flagged, recent] = await Promise.all([
    getSettings(env),
    all(env, `select n.id, n.name, n.code, t.status, count(*) as n_count
                from tickets t join tents n on n.id = t.tent_id
               group by n.id, t.status order by n.code`),
    first(env, `select count(*) as total,
                       sum(case when status != 'collected' then 1 else 0 end) as open,
                       sum(case when status = 'ready' then 1 else 0 end) as ready,
                       sum(case when status = 'collected' then 1 else 0 end) as collected,
                       sum(case when released_manually = 1 then 1 else 0 end) as manual
                  from tickets`),
    // Averages in minutes, computed in SQL over the rows that actually have both
    // ends of the interval — a charger still on the bench has no charge time yet
    // and must not drag the average toward zero.
    first(env, `select
        avg(case when ready_at is not null then (julianday(ready_at) - julianday(received_at)) * 1440 end) as avg_charge_min,
        avg(case when collected_at is not null and ready_at is not null then (julianday(collected_at) - julianday(ready_at)) * 1440 end) as avg_wait_min
      from tickets`),
    all(env, `select * from audit_log where flagged = 1 order by at desc limit 30`),
    all(env, `select * from audit_log order by at desc limit 80`),
  ]);

  // Chargers that have been ready a long time and nobody has come for — the one
  // number a tent lead acts on at closing time.
  const stale = await all(env,
    `select t.ref, t.label, t.slot, t.ready_at, t.customer_id, n.name as tent_name
       from tickets t join tents n on n.id = t.tent_id
      where t.status = 'ready' and t.ready_at is not null
      order by t.ready_at asc limit 50`);

  const tents = {};
  for (const r of byTent) {
    const t = (tents[r.id] = tents[r.id] || { id: r.id, name: r.name, code: r.code, received: 0, charging: 0, ready: 0, held: 0, collected: 0, open: 0 });
    t[r.status] = Number(r.n_count);
    if (r.status !== "collected") t.open += Number(r.n_count);
  }

  return json({
    ok: true,
    settings, defaults: DEFAULT_SETTINGS,
    totals: {
      total: num(totals && totals.total), open: num(totals && totals.open),
      ready: num(totals && totals.ready), collected: num(totals && totals.collected),
      manual: num(totals && totals.manual),
      avg_charge_min: round(durations && durations.avg_charge_min),
      avg_wait_min: round(durations && durations.avg_wait_min),
    },
    tents: Object.values(tents).sort((a, b) => String(a.code).localeCompare(String(b.code))),
    waiting: stale.map(s => ({ ...s, linked: !!s.customer_id })),
    flagged, recent,
  });
}

const num = (v) => Number(v || 0);
const round = (v) => (v == null || !isFinite(Number(v)) ? null : Math.round(Number(v)));

// Settings the owner may tune. Anything not on this list cannot be written
// through the API at all — an unknown key would otherwise sit in the table
// forever, looking like a feature.
const WRITABLE = {
  event_name: (v) => clean(v, 40) || null,
  ready_message: (v) => clean(v, 200) || null,
  reminder_hours: (v) => (/^\d{1,2}$/.test(String(v)) ? String(Number(v)) : null),
  collect_requires_code: (v) => (v ? "1" : "0"),
  auto_charging_on_intake: (v) => (v ? "1" : "0"),
};

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const b = await request.json().catch(() => ({}));
  const staff = await requireStaff(env, b.code, "admin");
  if (!staff) return json({ ok: false, error: "Only an admin can change settings." }, 403);
  if (b.action !== "settings") return json({ ok: false, error: "Unknown action" }, 400);

  const changed = [];
  for (const [key, coerce] of Object.entries(WRITABLE)) {
    if (!(key in b)) continue;
    const v = coerce(b[key]);
    if (v == null) return json({ ok: false, error: `That value isn't valid for ${key.replace(/_/g, " ")}.` }, 400);
    const res = await run(env,
      "insert into settings (key, value, updated_at) values (?,?,?) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at",
      [key, v, now()]);
    if (res.ok) changed.push(key.replace(/_/g, " "));
  }
  if (!changed.length) return json({ ok: true, unchanged: true });
  await audit(env, { actorType: "staff", actorId: staff.id, actorName: staff.name, action: "settings", detail: `Changed ${changed.join(", ")}` });
  return json({ ok: true, settings: await getSettings(env) });
}
