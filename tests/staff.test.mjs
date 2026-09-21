// Staff accounts — the two rails that stop the permission model unravelling:
// no escalation (an admin cannot mint an owner) and no owner lockout (the last
// owner cannot be removed, leaving nobody who can grant rights).

import assert from "node:assert/strict";
import { suite, stubEnv, postRequest, getRequest } from "./_stub.mjs";
import { onRequestPost as staffPost, onRequestGet as staffGet } from "../functions/api/staff.js";

const { test, done } = suite("staff");

const TOKEN = "CWs_admin-token";
const ADMIN = { id: "admin-1", name: "Alex", username: "alex", role: "admin", tent_id: null, active: 1 };
const OWNER = { id: "owner-1", name: "Scott", username: "scott", role: "owner", tent_id: null, active: 1 };
const HANDLER = { id: "staff-2", name: "Sam", username: "sam", role: "handler", tent_id: "tent-1", active: 1 };

function rules({ me = ADMIN, target = HANDLER, owners = 1, usernameTaken = false } = {}) {
  return [
    { match: /from sessions where token_hash/, rows: [{
      id: "sess-1", subject_type: "staff", subject_id: me.id,
      expires_at: new Date(Date.now() + 864e5).toISOString(), revoked_at: null,
      last_seen_at: new Date().toISOString(),
    }] },
    { match: /select \* from staff where id = \?/, rows: (p) => (p[0] === me.id ? [me] : (target ? [target] : [])) },
    { match: /count\(\*\) as n from staff where role = 'owner'/, rows: [{ n: owners }] },
    { match: /select id from staff where lower\(username\)/, rows: usernameTaken ? [{ id: "someone" }] : [] },
    { match: /select id from tents where id/, rows: [{ id: "tent-1" }] },
    { match: /from staff s left join tents/, rows: [OWNER, ADMIN, HANDLER] },
  ];
}

const call = (env, body) => staffPost({ env, request: postRequest(body) }).then(r => r.json().then(j => ({ status: r.status, ...j })));

// --- No escalation -----------------------------------------------------------
await test("an admin cannot create an owner", async () => {
  const env = stubEnv(rules({ me: ADMIN }));
  const r = await call(env, { code: TOKEN, action: "create", name: "Mallory", username: "mallory", pin: "1234", role: "owner" });
  assert.equal(r.status, 403);
  assert.match(r.error, /only an owner/i);
  assert.equal(env.__db.writeMatching(/insert into staff/), undefined);
});

await test("an owner can create an owner", async () => {
  const env = stubEnv(rules({ me: OWNER }));
  const r = await call(env, { code: TOKEN, action: "create", name: "Robin", username: "robin", pin: "1234", role: "owner" });
  assert.equal(r.ok, true);
  assert.equal(env.__db.writeMatching(/insert into staff/).params[6], "owner");
});

await test("an admin cannot promote anyone to owner", async () => {
  const env = stubEnv(rules({ me: ADMIN, target: HANDLER }));
  const r = await call(env, { code: TOKEN, action: "update", id: HANDLER.id, role: "owner" });
  assert.equal(r.status, 403);
  assert.equal(env.__db.writeMatching(/update staff/), undefined);
});

await test("an admin cannot edit an owner's account at all", async () => {
  // Without this, "no escalation" is one unguarded field away from being moot.
  const env = stubEnv(rules({ me: ADMIN, target: OWNER }));
  for (const body of [{ action: "update", name: "Not Scott" }, { action: "set_pin", pin: "9999" }, { action: "unlock" }]) {
    const r = await call(env, { code: TOKEN, id: OWNER.id, ...body });
    assert.equal(r.status, 403, `${body.action} on an owner should be refused`);
  }
  assert.equal(env.__db.writes.length, 0);
});

await test("a handler cannot reach this endpoint at all", async () => {
  const env = stubEnv(rules({ me: HANDLER }));
  assert.equal((await call(env, { code: TOKEN, action: "create", name: "X", username: "xx", pin: "1234" })).status, 403);
  assert.equal((await staffGet({ env, request: getRequest("code=" + TOKEN) })).status, 403);
});

// --- No owner lockout --------------------------------------------------------
await test("the last owner cannot be demoted", async () => {
  const env = stubEnv(rules({ me: OWNER, target: OWNER, owners: 0 }));  // 0 others
  const r = await call(env, { code: TOKEN, action: "update", id: OWNER.id, role: "admin" });
  assert.equal(r.status, 409);
  assert.match(r.error, /last owner/i);
  assert.equal(env.__db.writeMatching(/update staff/), undefined);
});

await test("the last owner cannot be deactivated", async () => {
  const env = stubEnv(rules({ me: OWNER, target: OWNER, owners: 0 }));
  const r = await call(env, { code: TOKEN, action: "update", id: OWNER.id, active: false });
  assert.equal(r.status, 409);
  assert.match(r.error, /last owner|nobody who can grant/i);
});

await test("an owner CAN be demoted once another owner exists", async () => {
  const env = stubEnv(rules({ me: OWNER, target: OWNER, owners: 1 }));
  const r = await call(env, { code: TOKEN, action: "update", id: OWNER.id, role: "admin" });
  assert.equal(r.ok, true);
});

// --- Account hygiene ---------------------------------------------------------
await test("creating an account stores a hash, never the PIN", async () => {
  const env = stubEnv(rules({ me: ADMIN }));
  const r = await call(env, { code: TOKEN, action: "create", name: "Sam", username: "sam2", pin: "482913", role: "handler", tent_id: "tent-1" });
  assert.equal(r.ok, true);
  const w = env.__db.writeMatching(/insert into staff/);
  assert.ok(!w.params.includes("482913"), "the PIN must never be written");
  assert.match(String(w.params[3]), /^[0-9a-f]{64}$/, "a PBKDF2 hash should be stored");
  assert.match(String(w.params[4]), /^[0-9a-f]{32}$/, "with its own salt");
});

await test("a handler must be given a tent", async () => {
  const env = stubEnv(rules({ me: ADMIN }));
  const r = await call(env, { code: TOKEN, action: "create", name: "Sam", username: "sam3", pin: "1234", role: "handler", tent_id: "" });
  assert.equal(r.status, 400);
  assert.match(r.error, /needs a tent/i);
});

await test("a duplicate username is refused with a useful message", async () => {
  const env = stubEnv(rules({ me: ADMIN, usernameTaken: true }));
  const r = await call(env, { code: TOKEN, action: "create", name: "Sam", username: "sam", pin: "1234", role: "handler", tent_id: "tent-1" });
  assert.equal(r.status, 409);
  assert.match(r.error, /taken/i);
});

await test("usernames and PINs are validated", async () => {
  const env = stubEnv(rules({ me: ADMIN }));
  const bad = [
    { username: "ab", pin: "1234" }, { username: "has space", pin: "1234" },
    { username: "sam9", pin: "12" }, { username: "sam9", pin: "letters" },
    { username: "sam9", pin: "1234", name: "" },
  ];
  for (const b of bad) {
    const r = await call(env, { code: TOKEN, action: "create", name: "Sam", tent_id: "tent-1", role: "handler", ...b });
    assert.equal(r.status, 400, `${JSON.stringify(b)} should be rejected`);
  }
});

await test("resetting a PIN signs that person out everywhere", async () => {
  // A forgotten PIN and a lost phone look identical from here, so the safe
  // reading is the second one.
  const env = stubEnv(rules({ me: ADMIN, target: HANDLER }));
  const r = await call(env, { code: TOKEN, action: "set_pin", id: HANDLER.id, pin: "5566" });
  assert.equal(r.ok, true);
  assert.ok(env.__db.writeMatching(/update staff set pin_hash/), "the new hash is stored");
  assert.ok(env.__db.writeMatching(/update sessions set revoked_at/), "their sessions must be revoked");
});

await test("deactivating an account also ends its sessions", async () => {
  const env = stubEnv(rules({ me: ADMIN, target: HANDLER }));
  const r = await call(env, { code: TOKEN, action: "update", id: HANDLER.id, active: false });
  assert.equal(r.ok, true);
  assert.ok(env.__db.writeMatching(/update sessions set revoked_at/),
    "otherwise the account keeps working on whatever phone it's already signed in on");
});

await test("unlocking clears the failure count", async () => {
  const env = stubEnv(rules({ me: ADMIN, target: HANDLER }));
  const r = await call(env, { code: TOKEN, action: "unlock", id: HANDLER.id });
  assert.equal(r.ok, true);
  assert.match(env.__db.writeMatching(/update staff set fail_count = 0/).sql, /locked_until = null/);
});

await test("the staff list never carries a PIN hash to the client", async () => {
  const env = stubEnv(rules({ me: ADMIN }));
  const r = await staffGet({ env, request: getRequest("code=" + TOKEN) }).then(x => x.json());
  assert.equal(r.ok, true);
  const body = JSON.stringify(r);
  assert.ok(!/pin_hash|pin_salt/.test(body), "the list must not expose credentials");
  assert.ok(r.staff.every(s => "has_pin" in s), "it says WHETHER a PIN is set, not what it is");
});

await test("a malformed id is refused before any lookup", async () => {
  const env = stubEnv(rules({ me: ADMIN }));
  const r = await call(env, { code: TOKEN, action: "update", id: "staff-1 or 1=1", name: "X" });
  assert.equal(r.status, 400);
});

await test("an unknown action changes nothing", async () => {
  const env = stubEnv(rules({ me: ADMIN }));
  const r = await call(env, { code: TOKEN, action: "grant_everything", id: HANDLER.id });
  assert.equal(r.status, 400);
  assert.equal(env.__db.writes.length, 0);
});

done();
