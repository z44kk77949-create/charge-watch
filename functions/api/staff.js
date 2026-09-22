// Staff accounts — who can work a tent, and with what rights.
//
// Two safety rails, both enforced server-side:
//   • No escalation. An admin cannot create or promote an owner, so the account
//     that runs the app can only ever be granted by an existing owner.
//   • No owner lockout. The last active owner cannot be deactivated or demoted
//     — by anyone, including themselves — or the app would have nobody who can
//     grant rights again.
//
// A PIN is shown exactly once, at the moment it is set, and stored hashed. There
// is no "show PIN" anywhere: a forgotten one is reset, never recovered.

import {
  db, noDb, json, all, first, run, now, uuid, clean, isSafeId,
  requireStaff, hashPin, newSalt, isValidPin, pinIters, MIN_PIN_LEN,
  revokeAllForSubject, audit,
} from "./_util.js";

const ROLES = ["handler", "admin", "owner"];

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const staff = await requireStaff(env, new URL(request.url).searchParams.get("code"), "admin");
  if (!staff) return json({ ok: false, error: "Only an admin can see staff accounts." }, 403);

  const rows = await all(env,
    `select s.id, s.name, s.username, s.role, s.tent_id, s.active, s.created_at, s.last_seen_at,
            s.pin_set_at, s.locked_until, n.name as tent_name
       from staff s left join tents n on n.id = s.tent_id
      order by case s.role when 'owner' then 0 when 'admin' then 1 else 2 end, s.name`);
  return json({
    ok: true, me: staff.id, my_role: staff.role,
    staff: rows.map(r => ({ ...r, active: !!r.active, has_pin: !!r.pin_set_at, locked: !!(r.locked_until && new Date(r.locked_until) > new Date()) })),
  });
}

async function activeOwners(env, excludeId) {
  const r = await first(env, "select count(*) as n from staff where role = 'owner' and active = 1" + (excludeId ? " and id != ?" : ""), excludeId ? [excludeId] : []);
  return r ? Number(r.n) : 0;
}

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const b = await request.json().catch(() => ({}));
  const me = await requireStaff(env, b.code, "admin");
  if (!me) return json({ ok: false, error: "Only an admin can change staff accounts." }, 403);

  if (b.action === "create") {
    const name = clean(b.name, 60);
    const username = clean(b.username, 40).toLowerCase();
    if (!name || !/^[a-z0-9_.-]{3,40}$/.test(username)) return json({ ok: false, error: "Enter a name and a username (letters, numbers, dot, dash or underscore)." }, 400);
    if (!isValidPin(b.pin)) return json({ ok: false, error: `Set a PIN of ${MIN_PIN_LEN} to 10 digits.` }, 400);

    const role = ROLES.includes(b.role) ? b.role : "handler";
    if (role === "owner" && me.role !== "owner") return json({ ok: false, error: "Only an owner can create another owner." }, 403);

    const tentId = isSafeId(b.tent_id) ? b.tent_id : null;
    if (tentId && !(await first(env, "select id from tents where id = ?", [tentId]))) return json({ ok: false, error: "No such tent" }, 400);
    if (role === "handler" && !tentId) return json({ ok: false, error: "A handler needs a tent to work at." }, 400);

    const clash = await first(env, "select id from staff where lower(username) = ?", [username]);
    if (clash) return json({ ok: false, error: `Username "${username}" is taken.` }, 409);

    const id = uuid(), salt = newSalt(), iters = pinIters(env);
    const res = await run(env,
      "insert into staff (id, name, username, pin_hash, pin_salt, pin_iters, pin_set_at, role, tent_id, active, created_at) values (?,?,?,?,?,?,?,?,?,1,?)",
      [id, name, username, await hashPin(b.pin, salt, iters), salt, iters, now(), role, tentId, now()]);
    if (!res.ok) return json({ ok: false, error: "Couldn't create that account — try again." }, 500);
    await audit(env, { actorType: "staff", actorId: me.id, actorName: me.name, action: "staff", detail: `Created ${role} account "${username}" for ${name}` });
    return json({ ok: true, id });
  }

  if (!isSafeId(b.id)) return json({ ok: false, error: "Bad account" }, 400);
  const target = await first(env, "select * from staff where id = ?", [b.id]);
  if (!target) return json({ ok: false, error: "No such account" }, 404);
  // An admin may not edit an owner at all — otherwise "no escalation" is only
  // one careless field away from being bypassed.
  if (target.role === "owner" && me.role !== "owner") return json({ ok: false, error: "Only an owner can change an owner's account." }, 403);

  if (b.action === "update") {
    const sets = [], params = [], notes = [];
    if ("name" in b) { const v = clean(b.name, 60); if (!v) return json({ ok: false, error: "A name is needed." }, 400); sets.push("name = ?"); params.push(v); notes.push("name"); }

    if ("role" in b && b.role !== target.role) {
      if (!ROLES.includes(b.role)) return json({ ok: false, error: "Unknown role" }, 400);
      if (b.role === "owner" && me.role !== "owner") return json({ ok: false, error: "Only an owner can grant owner." }, 403);
      if (target.role === "owner" && b.role !== "owner" && (await activeOwners(env, target.id)) === 0) {
        return json({ ok: false, error: "That's the last owner — make someone else an owner first." }, 409);
      }
      sets.push("role = ?"); params.push(b.role); notes.push(`role → ${b.role}`);
    }

    if ("tent_id" in b) {
      const tentId = isSafeId(b.tent_id) ? b.tent_id : null;
      if (tentId && !(await first(env, "select id from tents where id = ?", [tentId]))) return json({ ok: false, error: "No such tent" }, 400);
      const finalRole = ("role" in b && ROLES.includes(b.role)) ? b.role : target.role;
      if (finalRole === "handler" && !tentId) return json({ ok: false, error: "A handler needs a tent to work at." }, 400);
      sets.push("tent_id = ?"); params.push(tentId); notes.push("tent");
    }

    if ("active" in b && !!b.active !== !!target.active) {
      if (!b.active && target.role === "owner" && (await activeOwners(env, target.id)) === 0) {
        return json({ ok: false, error: "That's the last owner — the app would have nobody who can grant rights." }, 409);
      }
      sets.push("active = ?"); params.push(b.active ? 1 : 0); notes.push(b.active ? "reactivated" : "deactivated");
    }

    if (!sets.length) return json({ ok: true, unchanged: true });
    params.push(target.id);
    const res = await run(env, `update staff set ${sets.join(", ")} where id = ?`, params);
    if (!res.ok) return json({ ok: false, error: "Couldn't save that account — try again." }, 500);

    // Deactivating has to end the sessions too, or the account keeps working on
    // whatever phone it is already signed in on until the token expires.
    if ("active" in b && !b.active) await revokeAllForSubject(env, "staff", target.id, null);

    await audit(env, { actorType: "staff", actorId: me.id, actorName: me.name, action: "staff", detail: `Updated "${target.username}": ${notes.join(", ")}` });
    return json({ ok: true });
  }

  if (b.action === "set_pin") {
    if (!isValidPin(b.pin)) return json({ ok: false, error: `A PIN is ${MIN_PIN_LEN} to 10 digits.` }, 400);
    const salt = newSalt(), iters = pinIters(env);
    const res = await run(env, "update staff set pin_hash = ?, pin_salt = ?, pin_iters = ?, pin_set_at = ?, fail_count = 0, locked_until = null where id = ?",
      [await hashPin(b.pin, salt, iters), salt, iters, now(), target.id]);
    if (!res.ok) return json({ ok: false, error: "Couldn't set that PIN — try again." }, 500);
    // A new PIN means the old one is gone; anything signed in with it goes too,
    // which is the whole point when a phone has been lost.
    await revokeAllForSubject(env, "staff", target.id, null);
    await audit(env, { actorType: "staff", actorId: me.id, actorName: me.name, action: "staff", detail: `Reset the PIN for "${target.username}" — their other devices were signed out` });
    return json({ ok: true });
  }

  if (b.action === "unlock") {
    await run(env, "update staff set fail_count = 0, locked_until = null where id = ?", [target.id]);
    await audit(env, { actorType: "staff", actorId: me.id, actorName: me.name, action: "staff", detail: `Unlocked "${target.username}"` });
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown action" }, 400);
}
