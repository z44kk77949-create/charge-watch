// Sign-in, sign-out, and the one-time owner bootstrap.
//
// Two kinds of user, one session table:
//   • a CUSTOMER signs in by redeeming a claim code (the slip from the tent, or
//     the QR on it). There is no password — the code IS the credential, and it
//     is the same thing that releases the charger at the counter. Redeeming it
//     creates the account on the spot, which is what makes a walk-up tent work:
//     nobody registers before handing over a charger.
//   • a STAFF member signs in with a username and a PIN, both issued in Admin →
//     Staff. PINs are PBKDF2-hashed and rate-limited with lockout.
//
// Brute force, on the customer side, is not defended with a counter: an 8
// character Crockford-base32 code is 32^8 ≈ 1.1×10^12 possibilities, and every
// guess costs a round trip against Cloudflare's own rate limiting. The staff PIN
// is short enough to guess, so that path IS counted and locked.

import {
  db, noDb, json, all, first, run, now, uuid, clean, isSafeId,
  normCode, sha256hex, createSession, revokeToken, revokeAllForSubject, subjectByToken,
  hashPin, newSalt, isValidPin, lockedFor, recordPinFailure, clearPinFailures,
  timingSafeEqual, audit,
} from "./_util.js";

const SESSION_DAYS_CUSTOMER = 14;
const SESSION_DAYS_STAFF = 7;

export async function onRequestPost(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const b = await request.json().catch(() => ({}));
  const device = clean(request.headers.get("user-agent"), 160);

  switch (b.action) {
    case "claim":     return claim(env, b, device);
    case "staff":     return staffSignIn(env, b, device);
    case "bootstrap": return bootstrap(env, b, device);
    case "logout":    return logout(env, b);
    case "logout_all":return logoutAll(env, b);
    default:          return json({ ok: false, error: "Unknown action" }, 400);
  }
}

// --- Customer: redeem a claim code -----------------------------------------
async function claim(env, b, device) {
  const code = normCode(b.claim_code);
  if (code.length !== 8) return json({ ok: false, error: "A collection code is 8 characters — check the slip and try again." }, 400);

  const hash = await sha256hex(code);
  const ticket = await first(env, "select * from tickets where claim_hash = ?", [hash]);
  if (!ticket) return json({ ok: false, error: "That code doesn’t match a charger. Check it with the tent." }, 404);

  // Already claimed? The code is the account credential for this ticket, so
  // presenting it again signs THAT customer in on another device rather than
  // creating a second account — how a couple sharing one slip both get the
  // "ready" notification. (Whoever holds the slip can also physically collect
  // the charger, so this grants no access the paper didn't already.)
  let customerId = ticket.customer_id;
  let created = false;

  // If the caller is already signed in as a customer, attach this ticket to
  // that existing account instead of making them a second one — the second
  // charger of the night lands on the same phone.
  const caller = b.code ? await subjectByToken(env, b.code) : null;
  const callerCustomerId = caller && caller.type === "customer" ? caller.id : null;

  if (!customerId) {
    if (callerCustomerId) {
      customerId = callerCustomerId;
    } else {
      customerId = uuid();
      const res = await run(env, "insert into customers (id, display_name, created_at, last_seen_at) values (?,?,?,?)",
        [customerId, clean(b.display_name, 60) || null, now(), now()]);
      if (!res.ok) return json({ ok: false, error: "Couldn’t create your account — try again." }, 500);
      created = true;
    }
    const upd = await run(env, "update tickets set customer_id = ?, updated_at = ? where id = ? and customer_id is null",
      [customerId, now(), ticket.id]);
    if (!upd.ok) return json({ ok: false, error: "Couldn’t link that charger — try again." }, 500);
    await audit(env, {
      actorType: "customer", actorId: customerId, action: "claim",
      ticketId: ticket.id, ticketRef: ticket.ref, detail: "Charger linked to its owner’s phone",
    });
  } else if (callerCustomerId && callerCustomerId !== customerId) {
    // The caller holds a session for a different account AND the slip for this
    // one. Hand back a session for the ticket's account; the app switches to it.
    // (Nothing is merged — merging accounts on a scanned code would let a found
    // slip absorb a stranger's other chargers.)
  }

  const token = await createSession(env, "customer", customerId, device, SESSION_DAYS_CUSTOMER);
  if (!token) return json({ ok: false, error: "Couldn’t start your session — try again." }, 500);
  return json({ ok: true, token, kind: "customer", created, ticket_ref: ticket.ref });
}

// --- Staff: username + PIN --------------------------------------------------
async function staffSignIn(env, b, device) {
  const username = clean(b.username, 40).toLowerCase();
  const pin = String(b.pin || "");
  if (!username || !pin) return json({ ok: false, error: "Enter your username and PIN." }, 400);

  const staff = await first(env, "select * from staff where lower(username) = ? and active = 1", [username]);

  // Uniform failure text for "no such user", "wrong PIN" and "no PIN set" — a
  // sign-in screen that distinguishes them enumerates the staff list for anyone
  // who asks.
  const deny = () => json({ ok: false, error: "That username or PIN isn’t right." }, 401);
  if (!staff || !staff.pin_hash || !staff.pin_salt) return deny();

  const mins = lockedFor(staff);
  if (mins) return json({ ok: false, error: `Too many wrong PINs. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` }, 429);

  const got = await hashPin(pin, staff.pin_salt);
  if (!timingSafeEqual(got, staff.pin_hash)) {
    const locked = await recordPinFailure(env, staff);
    if (locked) return json({ ok: false, error: `Too many wrong PINs. Try again in ${locked} minutes.` }, 429);
    return deny();
  }
  await clearPinFailures(env, staff);

  const token = await createSession(env, "staff", staff.id, device, SESSION_DAYS_STAFF);
  if (!token) return json({ ok: false, error: "Couldn’t start your session — try again." }, 500);
  return json({ ok: true, token, kind: "staff", role: staff.role, name: staff.name });
}

// --- First run: create the owner account ------------------------------------
// Open ONLY while the staff table is empty, and only to someone holding
// ADMIN_INIT_KEY (a Cloudflare environment variable the owner sets). Both
// conditions: the key alone would leave a permanent back door, and the empty
// table alone would let the first passer-by take the app.
async function bootstrap(env, b, device) {
  const existing = await first(env, "select count(*) as n from staff");
  if (existing && Number(existing.n) > 0) return json({ ok: false, error: "This app is already set up. Ask an admin for an account." }, 409);
  if (!env.ADMIN_INIT_KEY || !timingSafeEqual(String(b.key || ""), env.ADMIN_INIT_KEY)) {
    return json({ ok: false, error: "Setup key not accepted." }, 403);
  }
  const name = clean(b.name, 60), username = clean(b.username, 40).toLowerCase();
  if (!name || !/^[a-z0-9_.-]{3,40}$/.test(username)) return json({ ok: false, error: "Enter a name and a username (letters, numbers, dot, dash or underscore)." }, 400);
  if (!isValidPin(b.pin)) return json({ ok: false, error: "Choose a PIN of 4 to 10 digits." }, 400);

  const salt = newSalt(), id = uuid();
  const res = await run(env,
    "insert into staff (id, name, username, pin_hash, pin_salt, pin_set_at, role, active, created_at) values (?,?,?,?,?,?,?,1,?)",
    [id, name, username, await hashPin(b.pin, salt), salt, now(), "owner", now()]);
  if (!res.ok) return json({ ok: false, error: "Couldn’t create the account — the username may be taken." }, 500);

  await audit(env, { actorType: "staff", actorId: id, actorName: name, action: "bootstrap", detail: "Owner account created" });
  const token = await createSession(env, "staff", id, device, SESSION_DAYS_STAFF);
  return json({ ok: true, token, kind: "staff", role: "owner", name });
}

// --- Sessions ---------------------------------------------------------------
async function logout(env, b) {
  await revokeToken(env, b.code);
  return json({ ok: true });
}

async function logoutAll(env, b) {
  const s = await subjectByToken(env, b.code);
  if (!s) return json({ ok: false, error: "Not signed in" }, 401);
  await revokeAllForSubject(env, s.type, s.id, b.code);
  return json({ ok: true });
}

// List my own sessions, so a lost phone can be signed out from a working one.
export async function onRequestGet(ctx) {
  const { env, request } = ctx;
  if (!db(env)) return noDb();
  const cred = new URL(request.url).searchParams.get("code");
  const s = await subjectByToken(env, cred);
  if (!s) return json({ ok: false, error: "Not signed in" }, 401);
  const rows = await all(env,
    "select id, device, created_at, last_seen_at, expires_at from sessions where subject_type = ? and subject_id = ? and revoked_at is null order by last_seen_at desc",
    [s.type, s.id]);
  return json({ ok: true, sessions: rows.map(r => ({ ...r, current: r.id === s.sessionId })) });
}
