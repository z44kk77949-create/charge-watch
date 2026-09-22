// Shared helpers for every Charge Watch API function (Cloudflare Pages Functions
// over a D1 database bound as `DB`).
//
// Three things every endpoint in this app does, in this order:
//   1. `const d = db(env)` — and answer 503 if the binding is missing, so an
//      unconfigured deployment is DORMANT, never broken with a stack trace.
//   2. Resolve the caller server-side (`requireStaff` / `requireCustomer`) from
//      the bearer token. A client-supplied id is never trusted.
//   3. Filter the query to what that caller may see — a handler sees their own
//      tent, a customer sees their own tickets, and nothing else.

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

export function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();

// The D1 handle, or null when the binding isn't configured yet. Bindings are
// set in the Cloudflare dashboard (Settings → Functions → D1 bindings) — never
// from a checked-in config file, which would take over the Pages project's
// settings and wipe the dashboard-managed environment variables.
export function db(env) {
  return env && env.DB ? env.DB : null;
}

export function noDb() {
  return json({ ok: false, error: "The database isn't connected yet. Bind a D1 database as DB in the Cloudflare dashboard." }, 503);
}

// Query helpers. Each degrades rather than throwing, so one bad read can never
// 500 a whole page — the caller gets [] / null and paints an empty state.
export async function all(env, sql, params = []) {
  try {
    const r = await db(env).prepare(sql).bind(...params).all();
    return Array.isArray(r.results) ? r.results : [];
  } catch (e) { return []; }
}
export async function first(env, sql, params = []) {
  try { return await db(env).prepare(sql).bind(...params).first(); } catch (e) { return null; }
}
// Writes DO surface failure — a silently dropped insert is how a ticket goes
// missing — so `run` returns { ok } and callers check it.
export async function run(env, sql, params = []) {
  try { await db(env).prepare(sql).bind(...params).run(); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

export async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison for anything secret-shaped (token hashes, PIN
// hashes, webhook secrets). A plain `===` on hex leaks position of the first
// differing byte through timing.
export function timingSafeEqual(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// Input-boundary guard. Ids reach us from the client and go into bound SQL
// parameters (so they can't inject), but a malformed id can still poison a
// guard query by matching nothing — reject anything that isn't id-shaped.
export function isSafeId(s) { return typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s); }

export function clean(s, max = 200) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Claim codes
//
// The code is the customer's proof of ownership: it is what binds a charger to
// their phone and what releases it at the counter. So it is generated with a
// CSPRNG, shown exactly once (on the slip at intake), and stored only as a
// sha-256 hash — a dump of the tickets table yields nothing that opens a locker.
//
// Crockford base32 (no I, L, O or U) so a code read aloud across a noisy tent,
// or squinted at off a printed slip, survives the obvious misreadings — `norm`
// folds O→0 and I/L→1 before hashing, so those typos still resolve.
// ---------------------------------------------------------------------------
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LEN = 8;

export function newClaimCode() {
  const b = new Uint8Array(CODE_LEN * 2);
  crypto.getRandomValues(b);
  let out = "";
  // Rejection sampling: 256 is not a multiple of 32, so taking `% 32` of every
  // byte would bias the first 8 symbols. Draw again instead of folding.
  for (let i = 0, n = 0; n < CODE_LEN; i++) {
    if (i >= b.length) { crypto.getRandomValues(b); i = 0; }
    if (b[i] >= 256 - (256 % ALPHABET.length)) continue;
    out += ALPHABET[b[i] % ALPHABET.length];
    n++;
  }
  return out;
}

// Fold a typed/scanned code to its canonical form. Accepts the pretty
// "ABCD-EFGH" the slip prints, lowercase, stray spaces, and the classic
// look-alike substitutions.
export function normCode(s) {
  return String(s == null ? "" : s)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export const prettyCode = (c) => (c && c.length === 8 ? c.slice(0, 4) + "-" + c.slice(4) : c || "");
export const codeHint = (c) => (c || "").slice(-3);

// ---------------------------------------------------------------------------
// Sessions — the bearer for both customers and staff
//
// `CWs_` + 32 random bytes, base64url. Only the sha-256 is stored, and every
// session carries an absolute expiry, so a token that leaks is both revocable
// and self-limiting.
// ---------------------------------------------------------------------------
export const SESSION_PREFIX = "CWs_";

export function newSessionToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let bin = ""; for (const x of b) bin += String.fromCharCode(x);
  return SESSION_PREFIX + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createSession(env, subjectType, subjectId, device, days) {
  const token = newSessionToken();
  const hash = await sha256hex(token);
  const ttl = Math.max(1, Number(days) || 14);
  const res = await run(env,
    "insert into sessions (id, token_hash, subject_type, subject_id, device, created_at, last_seen_at, expires_at) values (?,?,?,?,?,?,?,?)",
    [uuid(), hash, subjectType, subjectId, clean(device, 160) || null, now(), now(), new Date(Date.now() + ttl * 864e5).toISOString()]
  );
  // A token whose session row was never written would read as "not signed in"
  // on the very next request. Report the failure instead of handing one back.
  return res.ok ? token : null;
}

// Resolve a bearer to { type, id, row } or null. Bumps last_seen_at at most
// once every 5 minutes so the devices list stays useful without a write per
// request.
export async function subjectByToken(env, token) {
  if (!token || typeof token !== "string" || !token.startsWith(SESSION_PREFIX)) return null;
  const hash = await sha256hex(token);
  const s = await first(env, "select id, subject_type, subject_id, expires_at, revoked_at, last_seen_at from sessions where token_hash = ?", [hash]);
  if (!s || s.revoked_at) return null;
  if (new Date(s.expires_at).getTime() <= Date.now()) return null;
  const table = s.subject_type === "staff" ? "staff" : "customers";
  const row = await first(env, `select * from ${table} where id = ?`, [s.subject_id]);
  if (!row) return null;
  if (s.subject_type === "staff" && !row.active) return null;
  if (!s.last_seen_at || Date.now() - new Date(s.last_seen_at).getTime() > 3e5) {
    await run(env, "update sessions set last_seen_at = ? where id = ?", [now(), s.id]);
    await run(env, `update ${table} set last_seen_at = ? where id = ?`, [now(), row.id]);
  }
  return { type: s.subject_type, id: row.id, row, sessionId: s.id };
}

export async function revokeToken(env, token) {
  if (!token || !String(token).startsWith(SESSION_PREFIX)) return;
  await run(env, "update sessions set revoked_at = ? where token_hash = ?", [now(), await sha256hex(token)]);
}

export async function revokeAllForSubject(env, type, id, keepToken) {
  const keep = keepToken && String(keepToken).startsWith(SESSION_PREFIX) ? await sha256hex(keepToken) : null;
  await run(env,
    "update sessions set revoked_at = ? where subject_type = ? and subject_id = ? and revoked_at is null" + (keep ? " and token_hash != ?" : ""),
    keep ? [now(), type, id, keep] : [now(), type, id]
  );
}

// The bearer, from either the JSON body (`code`) or the query string — the
// same shape the frontend's api()/post() helpers send.
export function bearer(request, body) {
  if (body && typeof body.code === "string") return body.code;
  try { return new URL(request.url).searchParams.get("code") || ""; } catch (e) { return ""; }
}

// Caller resolution. `requireStaff(env, cred, "admin")` additionally demands at
// least admin rank; an owner satisfies every rank.
const RANK = { handler: 1, admin: 2, owner: 3 };
export async function requireStaff(env, cred, minRole) {
  const s = await subjectByToken(env, cred);
  if (!s || s.type !== "staff") return null;
  if (minRole && (RANK[s.row.role] || 0) < (RANK[minRole] || 0)) return null;
  return s.row;
}
export async function requireCustomer(env, cred) {
  const s = await subjectByToken(env, cred);
  return s && s.type === "customer" ? s.row : null;
}

export const isAdmin = (staff) => !!staff && (staff.role === "admin" || staff.role === "owner");

// The tents a staff member may act on: every active tent for an admin, their
// own for a handler. Returns an array of ids; an empty array means "no tent
// assigned", which the endpoints treat as "nothing visible" rather than "all".
export async function tentScope(env, staff) {
  if (isAdmin(staff)) {
    const rows = await all(env, "select id from tents order by code");
    return rows.map(r => r.id);
  }
  return staff.tent_id ? [staff.tent_id] : [];
}

// ---------------------------------------------------------------------------
// Staff PINs
//
// PBKDF2-SHA256, 150k iterations, 16-byte random salt per person. A PIN is
// short by design (it is typed on a phone, at a counter, dozens of times a
// night) so the work factor is what stands between a leaked database and a
// working sign-in; `recordPinFailure` adds lockout so the PIN can't be guessed
// online either.
// ---------------------------------------------------------------------------
// The work factor has to fit inside the platform's CPU budget, which on the
// Workers FREE plan is 10 ms per request — and that budget is shared with the
// database round trip and the JSON. Measured on comparable hardware:
//
//     5,000 iterations   1.0 ms
//    10,000 iterations   1.8 ms
//    25,000 iterations   3.9 ms
//    50,000 iterations   6.6 ms
//   150,000 iterations  19.3 ms   ← over budget; the request is killed with
//                                   Cloudflare error 1102 and never reaches
//                                   our code to report anything
//
// 25,000 leaves room for the rest of the request. Raising it is safe only on
// the Workers Paid plan, so it is settable per deployment via PIN_ITERATIONS
// and, crucially, STORED PER ROW — a later increase then applies to new and
// reset PINs without invalidating the ones already set.
//
// Be clear about what the work factor does and doesn't buy: against an offline
// attack on a stolen database, a short numeric PIN is weak at ANY iteration
// count (a 6-digit PIN is a million candidates, which a GPU chews through).
// What actually protects a PIN here is the length floor below plus the lockout
// in `recordPinFailure` — the work factor just raises the cost of the offline
// case from trivial to inconvenient.
export const DEFAULT_PIN_ITERS = 25000;

// Rows written before iterations were stored used this value.
const LEGACY_PIN_ITERS = 150000;

export function pinIters(env) {
  const n = Number(env && env.PIN_ITERATIONS);
  return Number.isInteger(n) && n >= 1000 && n <= 600000 ? n : DEFAULT_PIN_ITERS;
}

export async function hashPin(pin, saltHex, iterations = DEFAULT_PIN_ITERS) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pin)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Verify against whatever work factor that row was written with, so changing
// the default never locks anybody out.
export function rowPinIters(staff) {
  const n = Number(staff && staff.pin_iters);
  return Number.isInteger(n) && n > 0 ? n : LEGACY_PIN_ITERS;
}

export function newSalt() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Six digits minimum, not four. This is the change that actually matters for a
// numeric secret: four digits is ten thousand candidates, which no work factor
// can protect, while six is a hundred times harder for no extra typing.
export const MIN_PIN_LEN = 6;
export function isValidPin(pin) {
  return typeof pin === "string" && new RegExp(`^[0-9]{${MIN_PIN_LEN},10}$`).test(pin);
}

export const MAX_PIN_FAILS = 5;
export const LOCK_MINUTES = 10;

export function lockedFor(staff) {
  if (!staff || !staff.locked_until) return 0;
  const ms = new Date(staff.locked_until).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

export async function recordPinFailure(env, staff) {
  const n = (staff.fail_count || 0) + 1;
  const until = n >= MAX_PIN_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
  await run(env, "update staff set fail_count = ?, locked_until = ? where id = ?", [n >= MAX_PIN_FAILS ? 0 : n, until, staff.id]);
  return until ? LOCK_MINUTES : 0;
}

export async function clearPinFailures(env, staff) {
  if (staff.fail_count || staff.locked_until) await run(env, "update staff set fail_count = 0, locked_until = null where id = ?", [staff.id]);
}

// ---------------------------------------------------------------------------
// Settings — the DB wins, always
//
// These constants are FALLBACKS for a database that hasn't been seeded, not the
// live values. The owner tunes them in Admin → Oversight and they persist in
// `settings`; "correcting" a live value by editing this object does nothing.
// ---------------------------------------------------------------------------
export const DEFAULT_SETTINGS = {
  event_name: "XWB",
  ready_message: "Your charger is fully charged and ready to collect.",
  reminder_hours: "2",
  collect_requires_code: "1",
  auto_charging_on_intake: "1",
};

export async function getSettings(env) {
  const rows = await all(env, "select key, value from settings");
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export const settingOn = (settings, key) => String(settings[key]) === "1";

// ---------------------------------------------------------------------------
// Ticket references — "A-041", the public, speakable id
//
// Per-tent running number. Two handlers taking a charger at the same instant
// can compute the same next number, so the insert is retried against the unique
// constraint on `ref` rather than guarded by a lock D1 doesn't have.
// ---------------------------------------------------------------------------
export async function nextRef(env, tent) {
  const row = await first(env,
    "select ref from tickets where tent_id = ? order by length(ref) desc, ref desc limit 1", [tent.id]);
  let n = 0;
  if (row && row.ref) {
    const m = String(row.ref).match(/-(\d+)$/);
    if (m) n = parseInt(m[1], 10);
  }
  return `${tent.code}-${String(n + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Audit — append-only history
// ---------------------------------------------------------------------------
export async function audit(env, entry) {
  await run(env,
    "insert into audit_log (id, at, actor_type, actor_id, actor_name, action, ticket_id, ticket_ref, detail, flagged) values (?,?,?,?,?,?,?,?,?,?)",
    [uuid(), now(), entry.actorType || "system", entry.actorId || null, clean(entry.actorName, 80) || null,
     entry.action, entry.ticketId || null, entry.ticketRef || null, clean(entry.detail, 400) || null, entry.flagged ? 1 : 0]
  );
}

// ---------------------------------------------------------------------------
// Telegram pairing tokens
//
// The deep link `https://t.me/<bot>?start=<token>` is pasted into a public chat
// app, so the payload must not be a bare customer id — anyone who saw one could
// point their own Telegram at someone else's charger. It is the id plus an
// HMAC, and the webhook only trusts a signature it can reproduce.
// ---------------------------------------------------------------------------
function b64url(bytes) {
  let bin = ""; for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(env, msg) {
  const secret = env.PAIR_SECRET || env.ADMIN_INIT_KEY || "";
  if (!secret) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

export async function pairToken(env, customerId) {
  const sig = await hmac(env, customerId);
  return sig ? `${customerId}.${sig.slice(0, 27)}` : null;
}

export async function verifyPairToken(env, token) {
  const s = String(token || "");
  const dot = s.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = s.slice(0, dot), sig = s.slice(dot + 1);
  if (!isSafeId(id)) return null;
  const want = await hmac(env, id);
  return want && timingSafeEqual(want.slice(0, 27), sig) ? id : null;
}

// ---------------------------------------------------------------------------
// Collection codes — what the APP shows at the counter
//
// The claim code from the paper slip is stored only as a hash, so the app can
// never re-display it. That is deliberate, and it is why this exists: a signed-in
// owner instead gets a SHORT-LIVED code derived from the ticket id, which the
// counter verifies by recomputing it. Nothing extra is stored, a screenshot
// someone shared an hour ago is already dead, and the paper slip keeps working
// for anyone who never installed the app.
//
// Six digits over a 5-minute window, with the previous window still accepted so
// a code doesn't expire in the customer's hand while they queue.
// ---------------------------------------------------------------------------
export const COLLECT_WINDOW_MS = 5 * 60 * 1000;

async function collectDigits(env, ticketId, windowIndex) {
  const sig = await hmac(env, `collect|${ticketId}|${windowIndex}`);
  if (!sig) return null;
  // Fold the signature into a 6-digit number. The HMAC is the security
  // boundary; the truncation just makes it speakable.
  let n = 0;
  for (let i = 0; i < 8; i++) n = (n * 31 + sig.charCodeAt(i)) % 1000000;
  return String(n).padStart(6, "0");
}

export async function collectCode(env, ticketId) {
  const w = Math.floor(Date.now() / COLLECT_WINDOW_MS);
  const codeNow = await collectDigits(env, ticketId, w);
  if (!codeNow) return null;
  return { code: codeNow, expires_in: COLLECT_WINDOW_MS - (Date.now() % COLLECT_WINDOW_MS) };
}

// Accept the current window and the one before it (5–10 minutes of validity).
export async function verifyCollectCode(env, ticketId, supplied) {
  const want = String(supplied || "").replace(/\D/g, "");
  if (want.length !== 6) return false;
  const w = Math.floor(Date.now() / COLLECT_WINDOW_MS);
  for (const off of [0, -1]) {
    const c = await collectDigits(env, ticketId, w + off);
    if (c && timingSafeEqual(c, want)) return true;
  }
  return false;
}

// The QR payload the customer's phone displays and the counter scans. Versioned
// so a future format change can be told apart from a corrupt scan.
export const qrPayload = (ref, code) => `CW1:${ref}:${code}`;

export function parseQrPayload(s) {
  // Case-insensitive: a scanner hands back exactly what was encoded, but a
  // handler reading a payload off a screen and typing it should not be caught
  // out by the prefix's case.
  const m = String(s || "").trim().match(/^CW1:([A-Za-z0-9-]{1,32}):(\d{6})$/i);
  return m ? { ref: m[1].toUpperCase(), code: m[2] } : null;
}

// ---------------------------------------------------------------------------
// Status vocabulary — one definition, used by every surface
// ---------------------------------------------------------------------------
export const STATUSES = ["received", "charging", "ready", "collected", "held"];
export const STATUS_LABEL = {
  received: "Received",
  charging: "Charging",
  ready: "Ready to collect",
  collected: "Collected",
  held: "On hold",
};
export const isOpen = (status) => status !== "collected";
