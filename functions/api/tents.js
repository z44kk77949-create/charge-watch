// Tents — the setup surface's list of physical charging points.
// Read: any signed-in staff member (the intake screen needs the names).
// Write: admin and above only.

import {
  db, noDb, json, all, first, run, now, uuid, clean, isSafeId,
  requireStaff, isAdmin, audit,
} from "./_util.js";

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const staff = await requireStaff(env, new URL(request.url).searchParams.get("code"));
  if (!staff) return json({ ok: false, error: "Not signed in" }, 401);

  const tents = await all(env, "select * from tents order by code");
  // Live occupancy per tent, so the setup screen shows what closing one would
  // strand rather than just a name and a toggle.
  const counts = await all(env, "select tent_id, status, count(*) as n from tickets group by tent_id, status");
  const byTent = {};
  for (const c of counts) {
    const t = (byTent[c.tent_id] = byTent[c.tent_id] || { open: 0, ready: 0, collected: 0 });
    if (c.status === "collected") t.collected += Number(c.n);
    else { t.open += Number(c.n); if (c.status === "ready") t.ready += Number(c.n); }
  }
  return json({ ok: true, can_edit: isAdmin(staff), tents: tents.map(t => ({ ...t, active: !!t.active, ...(byTent[t.id] || { open: 0, ready: 0, collected: 0 }) })) });
}

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const b = await request.json().catch(() => ({}));
  const staff = await requireStaff(env, b.code, "admin");
  if (!staff) return json({ ok: false, error: "Only an admin can change tents." }, 403);

  if (b.action === "create") {
    const name = clean(b.name, 60);
    // The code prefixes every ticket ref in that tent ("A-041"), so it must be
    // short, spoken easily, and unique.
    const code = clean(b.tent_code, 4).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!name || !code) return json({ ok: false, error: "Give the tent a name and a short code (e.g. A)." }, 400);
    const clash = await first(env, "select id from tents where upper(code) = ?", [code]);
    if (clash) return json({ ok: false, error: `Code ${code} is already used by another tent.` }, 409);

    const id = uuid();
    const res = await run(env, "insert into tents (id, name, code, location, slots, active, created_at) values (?,?,?,?,?,1,?)",
      [id, name, code, clean(b.location, 120) || null, Number(b.slots) > 0 ? Math.min(999, Math.floor(Number(b.slots))) : null, now()]);
    if (!res.ok) return json({ ok: false, error: "Couldn't create that tent — the code may be taken." }, 500);
    await audit(env, { actorType: "staff", actorId: staff.id, actorName: staff.name, action: "tent", detail: `Created tent ${name} (${code})` });
    return json({ ok: true, id });
  }

  if (b.action === "update") {
    if (!isSafeId(b.id)) return json({ ok: false, error: "Bad tent" }, 400);
    const t = await first(env, "select * from tents where id = ?", [b.id]);
    if (!t) return json({ ok: false, error: "No such tent" }, 404);

    // Closing a tent that still holds chargers would hide them from every
    // board — the tickets have to go home first.
    if ("active" in b && !b.active && t.active) {
      const open = await first(env, "select count(*) as n from tickets where tent_id = ? and status != 'collected'", [t.id]);
      if (open && Number(open.n) > 0) return json({ ok: false, error: `${open.n} charger${Number(open.n) === 1 ? " is" : "s are"} still in that tent. Collect or move them first.` }, 409);
    }

    const sets = [], params = [];
    if ("name" in b) { const v = clean(b.name, 60); if (!v) return json({ ok: false, error: "A tent needs a name." }, 400); sets.push("name = ?"); params.push(v); }
    if ("location" in b) { sets.push("location = ?"); params.push(clean(b.location, 120) || null); }
    if ("slots" in b) { sets.push("slots = ?"); params.push(Number(b.slots) > 0 ? Math.min(999, Math.floor(Number(b.slots))) : null); }
    if ("active" in b) { sets.push("active = ?"); params.push(b.active ? 1 : 0); }
    if (!sets.length) return json({ ok: true, unchanged: true });
    params.push(t.id);

    const res = await run(env, `update tents set ${sets.join(", ")} where id = ?`, params);
    if (!res.ok) return json({ ok: false, error: "Couldn't save that tent — try again." }, 500);
    await audit(env, { actorType: "staff", actorId: staff.id, actorName: staff.name, action: "tent", detail: `Updated tent ${clean(b.name, 60) || t.name}` });
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown action" }, 400);
}
