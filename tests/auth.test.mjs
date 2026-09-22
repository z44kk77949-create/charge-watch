// Sign-in: the claim-code path customers use, the PIN path staff use, and the
// one-time owner bootstrap.

import assert from "node:assert/strict";
import { suite, stubEnv, postRequest } from "./_stub.mjs";
import { onRequestPost as auth } from "../functions/api/auth.js";
import { hashPin, newSalt, sha256hex, normCode, newClaimCode, MAX_PIN_FAILS, DEFAULT_PIN_ITERS } from "../functions/api/_util.js";

const { test, done } = suite("auth");
const call = (env, body) => auth({ env, request: postRequest(body) }).then(r => r.json().then(j => ({ status: r.status, ...j })));

// --- Staff PIN ---------------------------------------------------------------
async function staffRules(overrides = {}) {
  const salt = newSalt();
  const staff = {
    id: "staff-1", name: "Sam", username: "sam", role: "handler", tent_id: "tent-1",
    active: 1, fail_count: 0, locked_until: null,
    // A row as the app writes them now: the work factor is recorded, and
    // sign-in must verify against THAT value rather than the current default.
    pin_salt: salt, pin_iters: DEFAULT_PIN_ITERS,
    pin_hash: await hashPin("482913", salt, DEFAULT_PIN_ITERS),
    ...overrides,
  };
  return { staff, rules: [{ match: /from staff where lower\(username\)/, rows: overrides.missing ? [] : [staff] }] };
}

await test("the right username and PIN mints a session", async () => {
  const { rules } = await staffRules();
  const env = stubEnv(rules);
  const r = await call(env, { action: "staff", username: "sam", pin: "482913" });
  assert.equal(r.ok, true);
  assert.equal(r.kind, "staff");
  assert.equal(r.role, "handler");
  assert.ok(r.token && r.token.startsWith("CWs_"), "a session token should come back");
  assert.ok(env.__db.writeMatching(/insert into sessions/), "the session must be recorded");
});

await test("the username is not case-sensitive", async () => {
  const { rules } = await staffRules();
  const r = await call(stubEnv(rules), { action: "staff", username: "  SAM  ", pin: "482913" });
  assert.equal(r.ok, true);
});

await test("a wrong PIN and an unknown username are indistinguishable", async () => {
  // A sign-in screen that tells them apart enumerates the staff list for anyone
  // who asks it.
  const { rules } = await staffRules();
  const wrongPin = await call(stubEnv(rules), { action: "staff", username: "sam", pin: "000000" });
  const noSuchUser = await call(stubEnv((await staffRules({ missing: true })).rules), { action: "staff", username: "nobody", pin: "000000" });
  assert.equal(wrongPin.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.equal(wrongPin.error, noSuchUser.error, "the two failures must read identically");
});

await test("an account with no PIN set cannot be signed into", async () => {
  const { rules } = await staffRules({ pin_hash: null, pin_salt: null });
  const r = await call(stubEnv(rules), { action: "staff", username: "sam", pin: "482913" });
  assert.equal(r.status, 401);
});

await test("a deactivated account cannot sign in", async () => {
  // The query itself filters on active = 1, so a deactivated account simply
  // isn't there — the same uniform refusal as an unknown username.
  const env = stubEnv([{ match: /from staff where lower\(username\)/, rows: (p, sql) => (/active = 1/.test(sql) ? [] : []) }]);
  const r = await call(env, { action: "staff", username: "sam", pin: "482913" });
  assert.equal(r.status, 401);
});

await test("wrong PINs are counted and eventually lock the account", async () => {
  const { rules } = await staffRules({ fail_count: MAX_PIN_FAILS - 1 });
  const env = stubEnv(rules);
  const r = await call(env, { action: "staff", username: "sam", pin: "000000" });
  assert.equal(r.status, 429);
  assert.match(r.error, /too many wrong pins/i);
  const w = env.__db.writeMatching(/update staff set fail_count/);
  assert.ok(w, "the lockout must be written");
  assert.ok(w.params[1], "locked_until should be set once the limit is reached");
});

await test("a locked account is refused even with the correct PIN", async () => {
  const { rules } = await staffRules({ locked_until: new Date(Date.now() + 5 * 60000).toISOString() });
  const env = stubEnv(rules);
  const r = await call(env, { action: "staff", username: "sam", pin: "482913" });
  assert.equal(r.status, 429);
  assert.equal(env.__db.writeMatching(/insert into sessions/), undefined, "no session may be minted while locked");
});

await test("an expired lock lets them back in and clears the count", async () => {
  const { rules } = await staffRules({ locked_until: new Date(Date.now() - 60000).toISOString(), fail_count: 3 });
  const env = stubEnv(rules);
  const r = await call(env, { action: "staff", username: "sam", pin: "482913" });
  assert.equal(r.ok, true);
  assert.ok(env.__db.writeMatching(/update staff set fail_count = 0/), "a good sign-in resets the counter");
});

await test("a missing username or PIN is rejected before any lookup", async () => {
  const { rules } = await staffRules();
  for (const body of [{ username: "", pin: "482913" }, { username: "sam", pin: "" }, {}]) {
    const r = await call(stubEnv(rules), { action: "staff", ...body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} should be a 400`);
  }
});

// --- Bootstrap ---------------------------------------------------------------
await test("the first owner can be created when nobody exists and the key matches", async () => {
  const env = stubEnv([{ match: /count\(\*\) as n from staff/, rows: [{ n: 0 }] }]);
  const r = await call(env, { action: "bootstrap", key: "test-admin-key", name: "Scott", username: "scott", pin: "137913" });
  assert.equal(r.ok, true);
  assert.equal(r.role, "owner");
  const w = env.__db.writeMatching(/insert into staff/);
  assert.ok(w, "the owner account must be written");
  assert.equal(w.params[7], "owner", "the role column shifted when pin_iters was added");
  assert.ok(!w.params.includes("137913"), "the PIN itself must never be stored");
});

await test("bootstrap is refused once any staff account exists", async () => {
  const env = stubEnv([{ match: /count\(\*\) as n from staff/, rows: [{ n: 1 }] }]);
  const r = await call(env, { action: "bootstrap", key: "test-admin-key", name: "Mallory", username: "mallory", pin: "111111" });
  assert.equal(r.status, 409);
  assert.equal(env.__db.writeMatching(/insert into staff/), undefined);
});

await test("bootstrap is refused without the setup key", async () => {
  const rules = [{ match: /count\(\*\) as n from staff/, rows: [{ n: 0 }] }];
  for (const key of ["", "wrong", undefined]) {
    const env = stubEnv(rules);
    const r = await call(env, { action: "bootstrap", key, name: "Mallory", username: "mallory", pin: "111111" });
    assert.equal(r.status, 403, `key ${JSON.stringify(key)} should be refused`);
    assert.equal(env.__db.writeMatching(/insert into staff/), undefined);
  }
});

await test("bootstrap is refused when no setup key is configured at all", async () => {
  // Otherwise an empty ADMIN_INIT_KEY would compare equal to an empty submitted
  // key and hand the app to the first visitor.
  const env = stubEnv([{ match: /count\(\*\) as n from staff/, rows: [{ n: 0 }] }], { ADMIN_INIT_KEY: "" });
  const r = await call(env, { action: "bootstrap", key: "", name: "Mallory", username: "mallory", pin: "111111" });
  assert.equal(r.status, 403);
});

await test("bootstrap validates the username and PIN", async () => {
  const rules = [{ match: /count\(\*\) as n from staff/, rows: [{ n: 0 }] }];
  const bad = [
    { username: "ab", pin: "123456" },               // username too short
    { username: "has space", pin: "123456" },
    { username: "sam", pin: "123" },                 // PIN too short
    { username: "sam", pin: "1234" },                // four digits is no longer enough
    { username: "sam", pin: "abcdef" },
    { name: "", username: "sam", pin: "123456" },
  ];
  for (const b of bad) {
    const r = await call(stubEnv(rules), { action: "bootstrap", key: "test-admin-key", name: "Scott", ...b });
    assert.equal(r.status, 400, `${JSON.stringify(b)} should be rejected`);
  }
});

// --- Customer claim ----------------------------------------------------------
const TICKET = { id: "ticket-1", ref: "A-041", customer_id: null, claim_hash: null };

async function claimRules(overrides = {}) {
  const claim = overrides.claim || newClaimCode();
  const ticket = { ...TICKET, claim_hash: await sha256hex(normCode(claim)), ...(overrides.ticket || {}) };
  return {
    claim,
    rules: [
      { match: /from tickets where claim_hash/, rows: (p) => (p[0] === ticket.claim_hash ? [ticket] : []) },
      { match: /from sessions where token_hash/, rows: overrides.session || [] },
      { match: /select \* from customers where id/, rows: overrides.customer || [] },
    ],
  };
}

await test("a fresh claim code creates an account and links the charger", async () => {
  const { claim, rules } = await claimRules();
  const env = stubEnv(rules);
  const r = await call(env, { action: "claim", claim_code: claim });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.ticket_ref, "A-041");
  assert.ok(r.token.startsWith("CWs_"));
  assert.ok(env.__db.writeMatching(/insert into customers/), "an account should be created");
  const link = env.__db.writeMatching(/update tickets set customer_id/);
  assert.ok(link, "the ticket should be linked");
  assert.match(link.sql, /customer_id is null/, "the link must be conditional, so two phones can't race it");
  assert.ok(env.__db.writeMatching(/insert into audit_log/), "linking is audited");
});

await test("the pretty and lowercase forms of a code both work", async () => {
  for (const shape of [(c) => c.slice(0, 4) + "-" + c.slice(4), (c) => c.toLowerCase(), (c) => " " + c + " "]) {
    const { claim, rules } = await claimRules();
    const r = await call(stubEnv(rules), { action: "claim", claim_code: shape(claim) });
    assert.equal(r.ok, true, `${shape(claim)} should be accepted`);
  }
});

await test("a code of the wrong length is refused before any lookup", async () => {
  const { rules } = await claimRules();
  for (const bad of ["", "ABC", "ABCDEFGHI", "1234567"]) {
    const env = stubEnv(rules);
    const r = await call(env, { action: "claim", claim_code: bad });
    assert.equal(r.status, 400, `${bad} should be a 400`);
    assert.equal(env.__db.reads.length, 0, "a malformed code must not reach the database");
  }
});

await test("an unknown code says so without hinting at what exists", async () => {
  const { rules } = await claimRules();
  const r = await call(stubEnv(rules), { action: "claim", claim_code: "ZZZZ9999" });
  assert.equal(r.status, 404);
  assert.match(r.error, /doesn’t match a charger/);
});

await test("re-presenting a claimed code signs in that SAME account, not a new one", async () => {
  // Two people sharing one slip both need the "ready" message; the code is the
  // account credential for that ticket.
  const { claim, rules } = await claimRules({ ticket: { customer_id: "cust-1" } });
  const env = stubEnv(rules);
  const r = await call(env, { action: "claim", claim_code: claim });
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(env.__db.writeMatching(/insert into customers/), undefined, "no second account may be created");
  const session = env.__db.writeMatching(/insert into sessions/);
  assert.equal(session.params[3], "cust-1", "the session must belong to the ticket's existing account");
});

await test("a second charger attaches to the phone already signed in", async () => {
  const { claim, rules } = await claimRules({
    session: [{ id: "s", subject_type: "customer", subject_id: "cust-7",
                expires_at: new Date(Date.now() + 864e5).toISOString(), revoked_at: null,
                last_seen_at: new Date().toISOString() }],
    customer: [{ id: "cust-7", display_name: "Jo" }],
  });
  const env = stubEnv(rules);
  const r = await call(env, { action: "claim", claim_code: claim, code: "CWs_existing" });
  assert.equal(r.ok, true);
  assert.equal(r.created, false, "an existing customer must not get a second account");
  assert.equal(env.__db.writeMatching(/insert into customers/), undefined);
  const link = env.__db.writeMatching(/update tickets set customer_id/);
  assert.equal(link.params[0], "cust-7", "the ticket joins the account already on this phone");
});

// --- Sessions ----------------------------------------------------------------
await test("signing out revokes the token", async () => {
  const env = stubEnv([]);
  const r = await call(env, { action: "logout", code: "CWs_something" });
  assert.equal(r.ok, true);
  assert.ok(env.__db.writeMatching(/update sessions set revoked_at/), "the session row must be revoked");
});

await test("an unknown action changes nothing", async () => {
  const env = stubEnv([]);
  const r = await call(env, { action: "elevate" });
  assert.equal(r.status, 400);
  assert.equal(env.__db.writes.length, 0);
});

await test("a missing database binding answers 503", async () => {
  const r = await auth({ env: {}, request: postRequest({ action: "staff", username: "sam", pin: "482913" }) });
  assert.equal(r.status, 503);
});

done();
