// The tent board — everything currently in the handlers' care, and the actions
// that move it along.
//
// Read scoping: a handler sees their own tent, an admin sees every tent, and
// both see only what they asked for within that. Write scoping: the ticket's
// own tent must be in the caller's scope, re-checked on the server for every
// action — the board's buttons are a convenience, not the permission.

import {
  db, noDb, json, all, first, run, now, clean, isSafeId,
  requireStaff, tentScope, audit, getSettings,
  STATUSES, STATUS_LABEL, newClaimCode, prettyCode, codeHint, sha256hex,
} from "./_util.js";
import { notifyCustomer, readyText } from "./_notify.js";

export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const url = new URL(request.url);
  const staff = await requireStaff(env, url.searchParams.get("code"));
  if (!staff) return json({ ok: false, error: "Not signed in" }, 401);

  const scope = await tentScope(env, staff);
  if (!scope.length) return json({ ok: true, tickets: [], counts: emptyCounts(), tents: [] });

  // Narrow to one tent if asked, but only within scope.
  const want = url.searchParams.get("tent");
  const tents = isSafeId(want) && scope.includes(want) ? [want] : scope;
  const marks = tents.map(() => "?").join(",");

  const status = url.searchParams.get("status");
  const q = clean(url.searchParams.get("q"), 40);

  let sql = `select t.id, t.ref, t.label, t.owner_name, t.device_desc, t.slot, t.status, t.notes,
                    t.received_at, t.charging_at, t.ready_at, t.collected_at, t.customer_id,
                    t.claim_hint, t.released_manually,
                    n.name as tent_name, n.code as tent_code
               from tickets t join tents n on n.id = t.tent_id
              where t.tent_id in (${marks})`;
  const params = [...tents];

  if (status && STATUSES.includes(status)) { sql += " and t.status = ?"; params.push(status); }
  else if (status === "open") sql += " and t.status != 'collected'";

  if (q) {
    sql += " and (upper(t.ref) like ? or upper(t.label) like ? or upper(t.owner_name) like ? or upper(t.slot) like ?)";
    const like = `%${q.toUpperCase()}%`;
    params.push(like, like, like, like);
  }

  // Ready first — the queue at the counter is what a handler is looking at — then
  // oldest-first within each group so nothing quietly ages at the bottom.
  sql += ` order by case t.status when 'ready' then 0 when 'held' then 1 when 'charging' then 2
                                  when 'received' then 3 else 4 end,
                    t.received_at asc
           limit 300`;

  const rows = await all(env, sql, params);
  const counts = await countsFor(env, tents);
  const tentRows = await all(env, `select id, name, code, location, slots from tents where id in (${marks}) order by code`, tents);

  return json({
    ok: true,
    tickets: rows.map(r => ({ ...r, status_label: STATUS_LABEL[r.status] || r.status, linked: !!r.customer_id })),
    counts, tents: tentRows,
  });
}

function emptyCounts() { return { received: 0, charging: 0, ready: 0, held: 0, collected: 0, open: 0 }; }

async function countsFor(env, tents) {
  const marks = tents.map(() => "?").join(",");
  const rows = await all(env, `select status, count(*) as n from tickets where tent_id in (${marks}) group by status`, tents);
  const c = emptyCounts();
  for (const r of rows) { c[r.status] = Number(r.n); if (r.status !== "collected") c.open += Number(r.n); }
  return c;
}

// Load a ticket and prove the caller may touch it, in one place so no action
// can forget the check.
async function ticketInScope(env, staff, ticketId) {
  if (!isSafeId(ticketId)) return null;
  const t = await first(env,
    `select t.*, n.name as tent_name, n.location as tent_location from tickets t
       join tents n on n.id = t.tent_id where t.id = ?`, [ticketId]);
  if (!t) return null;
  const scope = await tentScope(env, staff);
  return scope.includes(t.tent_id) ? t : null;
}

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const b = await request.json().catch(() => ({}));
  const staff = await requireStaff(env, b.code);
  if (!staff) return json({ ok: false, error: "Not signed in" }, 401);

  const t = await ticketInScope(env, staff, b.ticket_id);
  if (!t) return json({ ok: false, error: "That charger isn't in your tent." }, 403);

  if (b.action === "status") return setStatus(env, staff, t, b);
  if (b.action === "edit") return edit(env, staff, t, b);
  if (b.action === "reissue") return reissue(env, staff, t);
  return json({ ok: false, error: "Unknown action" }, 400);
}

// --- Move a ticket along -----------------------------------------------------
async function setStatus(env, staff, t, b) {
  const next = String(b.status || "");
  if (!STATUSES.includes(next)) return json({ ok: false, error: "Unknown status" }, 400);

  // Collection is not a status change — it is a release, and it goes through
  // /api/collect where the customer's proof is checked. Letting the board set
  // `collected` would route around that check entirely.
  if (next === "collected") return json({ ok: false, error: "Use Collect to release a charger." }, 400);
  if (t.status === "collected") return json({ ok: false, error: "That charger has already been collected." }, 409);
  if (t.status === next) return json({ ok: true, unchanged: true });

  const ts = now();
  const sets = ["status = ?", "updated_at = ?"], params = [next, ts];
  if (next === "charging" && !t.charging_at) { sets.push("charging_at = ?"); params.push(ts); }
  if (next === "ready") {
    sets.push("ready_at = ?", "ready_by = ?", "reminded_at = ?");
    params.push(ts, staff.id, null);
  }
  params.push(t.id);

  const res = await run(env, `update tickets set ${sets.join(", ")} where id = ?`, params);
  if (!res.ok) return json({ ok: false, error: "Couldn't update that charger — try again." }, 500);

  await audit(env, {
    actorType: "staff", actorId: staff.id, actorName: staff.name, action: "status",
    ticketId: t.id, ticketRef: t.ref,
    detail: `${STATUS_LABEL[t.status] || t.status} → ${STATUS_LABEL[next] || next}`,
  });

  // The notification is a side effect of going ready, and a failure to deliver
  // it must not undo the state change — the charger IS ready either way, and
  // the app will show it. `notified` reports what actually went out.
  let notified = 0;
  if (next === "ready" && t.customer_id) {
    const [settings, customer] = await Promise.all([
      getSettings(env),
      first(env, "select * from customers where id = ?", [t.customer_id]),
    ]);
    const msg = readyText(settings, t, { name: t.tent_name, location: t.tent_location });
    notified = await notifyCustomer(env, customer, { ...msg, url: "/#collect" });
  }
  return json({ ok: true, status: next, notified, linked: !!t.customer_id });
}

// --- Correct the details -----------------------------------------------------
async function edit(env, staff, t, b) {
  const fields = { slot: 20, label: 40, owner_name: 60, device_desc: 120, notes: 300 };
  const sets = [], params = [], changed = [];
  for (const [k, max] of Object.entries(fields)) {
    if (!(k in b)) continue;
    const v = clean(b[k], max);
    if ((t[k] || "") === v) continue;
    sets.push(`${k} = ?`); params.push(v || null); changed.push(k.replace("_", " "));
  }
  if (!sets.length) return json({ ok: true, unchanged: true });
  sets.push("updated_at = ?"); params.push(now(), t.id);

  const res = await run(env, `update tickets set ${sets.join(", ")} where id = ?`, params);
  if (!res.ok) return json({ ok: false, error: "Couldn't save that — try again." }, 500);
  await audit(env, {
    actorType: "staff", actorId: staff.id, actorName: staff.name, action: "edit",
    ticketId: t.id, ticketRef: t.ref, detail: `Edited ${changed.join(", ")}`,
  });
  return json({ ok: true });
}

// --- Lost slip ---------------------------------------------------------------
// Issues a fresh claim code and invalidates the old one. Deliberately blocked
// once a phone is linked: at that point the customer already has a working
// collection code in the app, and a handler reissuing over the counter would be
// handing a new credential for someone else's charger to whoever asked.
async function reissue(env, staff, t) {
  if (t.customer_id) return json({ ok: false, error: "This charger is linked to its owner's phone — they collect with the code in the app." }, 409);
  if (t.status === "collected") return json({ ok: false, error: "That charger has already been collected." }, 409);

  const claim = newClaimCode();
  const res = await run(env, "update tickets set claim_hash = ?, claim_hint = ?, updated_at = ? where id = ?",
    [await sha256hex(claim), codeHint(claim), now(), t.id]);
  if (!res.ok) return json({ ok: false, error: "Couldn't reissue the code — try again." }, 500);

  await audit(env, {
    actorType: "staff", actorId: staff.id, actorName: staff.name, action: "reissue",
    ticketId: t.id, ticketRef: t.ref, detail: "Collection code reissued — the previous slip no longer works", flagged: 1,
  });
  return json({ ok: true, claim_code: prettyCode(claim) });
}
