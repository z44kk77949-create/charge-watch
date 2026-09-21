// Intake — a charger is handed over the counter and becomes a ticket.
//
// This is the one moment the claim code exists in the clear: it is generated
// here, written into the response so the handler can show or print the slip,
// and thereafter only its hash is kept. If the customer loses the slip before
// linking their phone, the code cannot be recovered — it is reissued from the
// board instead (which invalidates the old one).

import {
  db, noDb, json, first, run, now, uuid, clean,
  requireStaff, tentScope, newClaimCode, prettyCode, codeHint, sha256hex,
  nextRef, audit, getSettings, settingOn, isSafeId,
} from "./_util.js";

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const b = await request.json().catch(() => ({}));
  const staff = await requireStaff(env, b.code);
  if (!staff) return json({ ok: false, error: "Not signed in" }, 401);

  // The tent is chosen by the client but validated against what this member of
  // staff may actually work — a handler cannot book a charger into another
  // tent by editing the request.
  const scope = await tentScope(env, staff);
  const tentId = isSafeId(b.tent_id) ? b.tent_id : (scope.length === 1 ? scope[0] : null);
  if (!tentId || !scope.includes(tentId)) return json({ ok: false, error: "Choose a tent you're working at." }, 403);

  const tent = await first(env, "select id, name, code, location from tents where id = ? and active = 1", [tentId]);
  if (!tent) return json({ ok: false, error: "That tent isn't active." }, 400);

  const label = clean(b.label, 40);
  if (!label) return json({ ok: false, error: "Write the tag number on the charger and enter it here." }, 400);

  const settings = await getSettings(env);
  const status = settingOn(settings, "auto_charging_on_intake") ? "charging" : "received";
  const ts = now();
  const claim = newClaimCode();
  const claimHash = await sha256hex(claim);

  // `ref` is computed from the tent's current highest number, so two handlers
  // working the same tent in the same second can collide on it. The unique
  // constraint catches that; retry with a freshly-read number rather than
  // handing the customer a duplicate ticket.
  let ticketId = null, ref = null;
  for (let attempt = 0; attempt < 5 && !ticketId; attempt++) {
    const id = uuid();
    ref = await nextRef(env, tent);
    const res = await run(env,
      `insert into tickets (id, ref, tent_id, owner_name, label, device_desc, slot, status,
                            claim_hash, claim_hint, notes, received_at, charging_at, received_by, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, ref, tent.id, clean(b.owner_name, 60) || null, label, clean(b.device_desc, 120) || null,
       clean(b.slot, 20) || null, status, claimHash, codeHint(claim), clean(b.notes, 300) || null,
       ts, status === "charging" ? ts : null, staff.id, ts, ts]);
    if (res.ok) ticketId = id;
  }
  if (!ticketId) return json({ ok: false, error: "Couldn't book that charger in — try again." }, 500);

  await audit(env, {
    actorType: "staff", actorId: staff.id, actorName: staff.name, action: "intake",
    ticketId, ticketRef: ref, detail: `Taken in at ${tent.name}${b.slot ? `, slot ${clean(b.slot, 20)}` : ""}`,
  });

  // The slip's QR is a plain URL so a phone's built-in camera opens it — no app,
  // no scanner, no instructions. The app reads the code out of the fragment.
  const origin = env.APP_BASE_URL || new URL(request.url).origin;
  return json({
    ok: true,
    ticket: { id: ticketId, ref, label, slot: clean(b.slot, 20) || null, status, tent_name: tent.name, received_at: ts },
    claim_code: prettyCode(claim),
    claim_url: `${origin}/#c=${claim}`,
  });
}
