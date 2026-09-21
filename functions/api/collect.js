// Collection — proving the person at the counter owns the charger, then
// releasing it.
//
// The security property this endpoint exists to hold: **the client never
// decides that a customer is verified.** `lookup` reports whether a proof
// checked out, purely so the handler's screen can say so; `release` re-verifies
// the same proof from scratch before it writes. A tampered response, a replayed
// "verified: true", or a handler tapping Release on the wrong row all fail at
// the second check.
//
// Three proofs are accepted, in the order a busy counter meets them:
//   1. the QR on the customer's phone      → CW1:<ref>:<6 digits>, HMAC-checked
//   2. the ticket ref + the 6-digit code   → same check, read aloud or typed
//   3. the 8-character code from the slip  → matched against its stored hash
// Anything else is a SEARCH, not a proof: it returns candidates and leaves the
// handler to release manually with a written reason, which is flagged for the
// owner in Oversight.

import {
  db, noDb, json, all, first, run, now, clean, isSafeId,
  requireStaff, tentScope, audit, getSettings, settingOn,
  normCode, sha256hex, parseQrPayload, verifyCollectCode,
  STATUS_LABEL,
} from "./_util.js";
import { notifyCustomer } from "./_notify.js";

const SELECT = `select t.*, n.name as tent_name, n.location as tent_location,
                       c.display_name as customer_name, c.telegram_chat_id as customer_tg
                  from tickets t
                  join tents n on n.id = t.tent_id
                  left join customers c on c.id = t.customer_id`;

// Resolve whatever the handler scanned or typed into { ticket, verified }.
// Returns { ticket: null } when nothing matched a proof — the caller then falls
// back to search.
async function resolveProof(env, scope, raw) {
  const q = clean(raw, 60);
  if (!q || !scope.length) return { ticket: null, verified: false };
  const marks = scope.map(() => "?").join(",");

  // 1 & 2 — a ref with a six-digit rotating code.
  const qr = parseQrPayload(q);
  const pair = qr || (() => {
    const m = q.toUpperCase().match(/^([A-Z0-9]+-\d+)[\s:,-]+(\d{6})$/);
    return m ? { ref: m[1], code: m[2] } : null;
  })();
  if (pair) {
    const t = await first(env, `${SELECT} where upper(t.ref) = ? and t.tent_id in (${marks})`, [pair.ref, ...scope]);
    if (!t) return { ticket: null, verified: false, reason: "no_ticket" };
    return { ticket: t, verified: await verifyCollectCode(env, t.id, pair.code), reason: "code" };
  }

  // 3 — the 8-character claim code from the slip. Matched by hash, so the code
  // itself is never compared against anything stored in the clear.
  const claim = normCode(q);
  if (claim.length === 8) {
    const t = await first(env, `${SELECT} where t.claim_hash = ? and t.tent_id in (${marks})`, [await sha256hex(claim), ...scope]);
    if (t) return { ticket: t, verified: true, reason: "slip" };
  }

  return { ticket: null, verified: false };
}

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const b = await request.json().catch(() => ({}));
  const staff = await requireStaff(env, b.code);
  if (!staff) return json({ ok: false, error: "Not signed in" }, 401);
  const scope = await tentScope(env, staff);
  if (!scope.length) return json({ ok: false, error: "You're not assigned to a tent." }, 403);

  if (b.action === "lookup") return lookup(env, scope, b);
  if (b.action === "release") return release(env, staff, scope, b);
  return json({ ok: false, error: "Unknown action" }, 400);
}

async function lookup(env, scope, b) {
  const { ticket, verified } = await resolveProof(env, scope, b.q);
  if (ticket) {
    return json({
      ok: true, verified,
      ticket: view(ticket),
      // When the code didn't check out, say so plainly rather than falling back
      // to a silent search — a handler who thinks they scanned a valid code and
      // sees the right charger appear would hand it over.
      message: verified ? null : "That code has expired or doesn’t match. Ask them to refresh the app, or release manually with a reason.",
    });
  }

  // Search — by ref, tag number, name or slot. Never a proof.
  const q = clean(b.q, 40);
  if (!q) return json({ ok: true, verified: false, matches: [] });
  const marks = scope.map(() => "?").join(",");
  const like = `%${q.toUpperCase()}%`;
  const rows = await all(env,
    `${SELECT} where t.tent_id in (${marks}) and t.status != 'collected'
       and (upper(t.ref) like ? or upper(t.label) like ? or upper(t.owner_name) like ? or upper(t.slot) like ?)
     order by t.received_at asc limit 25`,
    [...scope, like, like, like, like]);
  return json({ ok: true, verified: false, matches: rows.map(view) });
}

function view(t) {
  return {
    id: t.id, ref: t.ref, label: t.label, owner_name: t.owner_name, device_desc: t.device_desc,
    slot: t.slot, status: t.status, status_label: STATUS_LABEL[t.status] || t.status,
    notes: t.notes, tent_name: t.tent_name, claim_hint: t.claim_hint,
    customer_name: t.customer_name || null, linked: !!t.customer_id,
    received_at: t.received_at, ready_at: t.ready_at, collected_at: t.collected_at,
  };
}

async function release(env, staff, scope, b) {
  if (!isSafeId(b.ticket_id)) return json({ ok: false, error: "Bad ticket" }, 400);
  const marks = scope.map(() => "?").join(",");
  const t = await first(env, `${SELECT} where t.id = ? and t.tent_id in (${marks})`, [b.ticket_id, ...scope]);
  if (!t) return json({ ok: false, error: "That charger isn't in your tent." }, 403);
  if (t.status === "collected") return json({ ok: false, error: `Already collected${t.collected_at ? ` at ${new Date(t.collected_at).toLocaleTimeString("en-SG")}` : ""}.` }, 409);

  // Re-verify from scratch. The proof must resolve to THIS ticket — a valid
  // code for a different charger proves nothing about this one.
  const proof = await resolveProof(env, scope, b.proof);
  const verified = !!(proof.ticket && proof.ticket.id === t.id && proof.verified);

  const settings = await getSettings(env);
  const note = clean(b.note, 300);
  if (!verified && settingOn(settings, "collect_requires_code") && note.length < 4) {
    return json({
      ok: false, needs_note: true,
      error: "No valid code for this charger. To release it anyway, write who you handed it to and how you checked.",
    }, 400);
  }

  const ts = now();
  const res = await run(env,
    "update tickets set status = 'collected', collected_at = ?, collected_by = ?, released_manually = ?, release_note = ?, updated_at = ? where id = ? and status != 'collected'",
    [ts, staff.id, verified ? 0 : 1, verified ? null : note, ts, t.id]);
  if (!res.ok) return json({ ok: false, error: "Couldn't release that charger — try again." }, 500);

  await audit(env, {
    actorType: "staff", actorId: staff.id, actorName: staff.name, action: "release",
    ticketId: t.id, ticketRef: t.ref,
    detail: verified
      ? `Released on a verified ${proof.reason === "slip" ? "slip code" : "app code"}`
      : `Released WITHOUT a code — ${note}`,
    flagged: verified ? 0 : 1,
  });

  // A receipt closes the loop for the customer, and is the thing that tells
  // them if someone else walked off with their charger.
  if (t.customer_id) {
    const customer = await first(env, "select * from customers where id = ?", [t.customer_id]);
    await notifyCustomer(env, customer, {
      title: `${t.label ? `Charger ${t.label}` : `Ticket ${t.ref}`} collected`,
      body: `Handed back at ${t.tent_name} just now.${verified ? "" : " Released without a code check — tell the tent immediately if this wasn’t you."}`,
      url: "/",
    });
  }

  return json({ ok: true, verified, ticket: { ...view(t), status: "collected", collected_at: ts } });
}
