// Collection — the endpoint that decides whether the person at the counter gets
// the charger.
//
// The property under test throughout: **the client never decides that a
// customer is verified.** `lookup` only reports; `release` re-derives the
// verdict from the proof it is handed, for the ticket it is handed. A response
// that said "verified" is not an input to anything.

import assert from "node:assert/strict";
import { suite, stubEnv, postRequest } from "./_stub.mjs";
import { onRequestPost as collect } from "../functions/api/collect.js";
import { collectCode, sha256hex, normCode, newClaimCode } from "../functions/api/_util.js";

const { test, done } = suite("collect");

const TOKEN = "CWs_test-session-token";
const STAFF = { id: "staff-1", name: "Sam", role: "handler", tent_id: "tent-1", active: 1 };
const TICKET = {
  id: "ticket-1", ref: "A-041", tent_id: "tent-1", customer_id: null,
  owner_name: "Jo", label: "47", device_desc: "black Anker", slot: "B3",
  status: "ready", claim_hash: null, claim_hint: "345",
  tent_name: "Tent A", tent_location: "By the bar",
  received_at: "2026-09-21T18:00:00.000Z", ready_at: "2026-09-21T19:00:00.000Z", collected_at: null,
};

// Rules are matched in order, so the specific ticket lookups come before the
// catch-all search.
function rules(overrides = {}) {
  const ticket = { ...TICKET, ...(overrides.ticket || {}) };
  const settings = overrides.settings || [];
  return [
    { match: /from sessions where token_hash/, rows: [{
      id: "sess-1", subject_type: "staff", subject_id: "staff-1",
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      revoked_at: null, last_seen_at: new Date().toISOString(),
    }] },
    { match: /select \* from staff where id/, rows: [{ ...STAFF, ...(overrides.staff || {}) }] },
    { match: /select id from tents/, rows: [{ id: "tent-1" }, { id: "tent-2" }] },
    { match: /from settings/, rows: settings },
    { match: /where upper\(t\.ref\) = \?/, rows: (p) => (String(p[0]).toUpperCase() === ticket.ref ? [ticket] : []) },
    { match: /where t\.claim_hash = \?/, rows: (p) => (ticket.claim_hash && p[0] === ticket.claim_hash ? [ticket] : []) },
    { match: /where t\.id = \?/, rows: (p) => (p[0] === ticket.id ? [ticket] : []) },
    { match: /like \?/, rows: overrides.matches || [] },
    { match: /from customers where id/, rows: [] },
  ];
}

const call = (env, body) => collect({ env, request: postRequest(body) }).then(r => r.json().then(j => ({ status: r.status, ...j })));

// --- lookup ------------------------------------------------------------------
await test("a current app code verifies the right charger", async () => {
  const env = stubEnv(rules());
  const { code } = await collectCode(env, TICKET.id);
  const r = await call(env, { code: TOKEN, action: "lookup", q: `CW1:A-041:${code}` });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.ticket.ref, "A-041");
  assert.equal(r.ticket.label, "47");
});

await test("the ticket ref and six digits typed by hand verify too", async () => {
  const env = stubEnv(rules());
  const { code } = await collectCode(env, TICKET.id);
  for (const q of [`A-041 ${code}`, `a-041 ${code}`, `A-041:${code}`, `A-041-${code}`]) {
    const r = await call(env, { code: TOKEN, action: "lookup", q });
    assert.equal(r.verified, true, `"${q}" should verify`);
  }
});

await test("a wrong six-digit code finds the ticket but does NOT verify it", async () => {
  const env = stubEnv(rules());
  const r = await call(env, { code: TOKEN, action: "lookup", q: "CW1:A-041:000000" });
  assert.equal(r.ok, true);
  assert.equal(r.verified, false, "a bad code must never read as verified");
  assert.ok(r.ticket, "the handler still needs to see which charger was scanned");
  assert.match(r.message || "", /expired|doesn’t match|doesn't match/i, "the screen must say why");
});

await test("a valid code for one charger does not verify another", async () => {
  const env = stubEnv(rules());
  const other = await collectCode(env, "some-other-ticket");
  const r = await call(env, { code: TOKEN, action: "lookup", q: `CW1:A-041:${other.code}` });
  assert.equal(r.verified, false);
});

await test("the eight-character slip code verifies by hash", async () => {
  const claim = newClaimCode();
  const env = stubEnv(rules({ ticket: { claim_hash: await sha256hex(normCode(claim)) } }));
  const r = await call(env, { code: TOKEN, action: "lookup", q: claim });
  assert.equal(r.verified, true);
  assert.equal(r.ticket.ref, "A-041");
});

await test("free text is a search, never a proof", async () => {
  const env = stubEnv(rules({ matches: [{ ...TICKET, id: "ticket-9", ref: "A-009" }] }));
  const r = await call(env, { code: TOKEN, action: "lookup", q: "Jo" });
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].ref, "A-009");
  assert.equal(r.ticket, undefined, "a search must not present a single ticket as a hit");
});

await test("a search result never leaks the claim code or the customer id", async () => {
  const env = stubEnv(rules({ matches: [{ ...TICKET, claim_hash: "deadbeef", customer_id: "cust-1" }] }));
  const r = await call(env, { code: TOKEN, action: "lookup", q: "Jo" });
  const body = JSON.stringify(r);
  assert.ok(!body.includes("deadbeef"), "the claim hash must not reach the client");
  assert.ok(!body.includes("cust-1"), "the customer id must not reach the client");
  assert.equal(r.matches[0].linked, true, "the client is told THAT it's linked, not who to");
});

// --- release -----------------------------------------------------------------
await test("a release re-verifies the proof and records a clean hand-back", async () => {
  const env = stubEnv(rules());
  const { code } = await collectCode(env, TICKET.id);
  const r = await call(env, { code: TOKEN, action: "release", ticket_id: TICKET.id, proof: `CW1:A-041:${code}` });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);

  const w = env.__db.writeMatching(/update tickets set status = 'collected'/);
  assert.ok(w, "the ticket should have been marked collected");
  assert.equal(w.params[2], 0, "a verified release is not a manual one");
  assert.equal(w.params[3], null, "a verified release carries no override note");

  const a = env.__db.writeMatching(/insert into audit_log/);
  assert.ok(a, "every release is audited");
  assert.equal(a.params[9], 0, "a verified release is not flagged");
});

await test("a release will NOT accept a proof that belongs to another charger", async () => {
  // The attack: scan a friend's valid QR, then ask the server to release a
  // different ticket. `lookup` would have said "verified" for THEIR ticket.
  const env = stubEnv(rules());
  const other = await collectCode(env, "ticket-somebody-else");
  const r = await call(env, {
    code: TOKEN, action: "release", ticket_id: TICKET.id,
    proof: `CW1:A-041:${other.code}`,
  });
  assert.equal(r.ok, false);
  assert.equal(r.needs_note, true, "without a matching proof it must fall through to a manual release");
  assert.equal(env.__db.writeMatching(/update tickets set status = 'collected'/), undefined, "nothing may be released");
});

await test("a release with no proof and no reason is refused", async () => {
  const env = stubEnv(rules());
  const r = await call(env, { code: TOKEN, action: "release", ticket_id: TICKET.id, proof: "", note: "" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.needs_note, true);
  assert.match(r.error, /write who you handed it to/i);
});

await test("a manual release needs a real reason and is flagged for the organiser", async () => {
  const env = stubEnv(rules());
  const short = await call(env, { code: TOKEN, action: "release", ticket_id: TICKET.id, note: "ok" });
  assert.equal(short.ok, false, "a two-character reason is not a reason");

  const r = await call(env, {
    code: TOKEN, action: "release", ticket_id: TICKET.id,
    note: "Jo Tan — described the charger and the sticker on the back",
  });
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);

  const w = env.__db.writeMatching(/update tickets set status = 'collected'/);
  assert.equal(w.params[2], 1, "released_manually must be set");
  assert.match(String(w.params[3]), /^Jo Tan/, "the reason is stored");

  const a = env.__db.writeMatching(/insert into audit_log/);
  assert.equal(a.params[9], 1, "a manual release must be flagged");
  assert.match(String(a.params[8]), /WITHOUT a code/, "the audit line must say what happened");
});

await test("when a code is not required, a reason is still recorded", async () => {
  const env = stubEnv(rules({ settings: [{ key: "collect_requires_code", value: "0" }] }));
  const r = await call(env, { code: TOKEN, action: "release", ticket_id: TICKET.id, note: "" });
  assert.equal(r.ok, true, "the organiser turned the requirement off, so this is allowed");
  const w = env.__db.writeMatching(/update tickets set status = 'collected'/);
  assert.equal(w.params[2], 1, "it is still a manual release");
  const a = env.__db.writeMatching(/insert into audit_log/);
  assert.equal(a.params[9], 1, "and still flagged, so it shows in Oversight");
});

await test("a charger already collected cannot be released twice", async () => {
  const env = stubEnv(rules({ ticket: { status: "collected", collected_at: "2026-09-21T20:00:00.000Z" } }));
  const r = await call(env, { code: TOKEN, action: "release", ticket_id: TICKET.id, note: "handed over again" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /already collected/i);
});

// --- authorisation -----------------------------------------------------------
await test("an unsigned caller gets nothing", async () => {
  const env = stubEnv([{ match: /from sessions where token_hash/, rows: [] }]);
  for (const body of [{ action: "lookup", q: "A-041 123456" }, { action: "release", ticket_id: "ticket-1" }]) {
    const r = await call(env, { code: "CWs_nope", ...body });
    assert.equal(r.status, 401, `${body.action} must refuse an unknown session`);
  }
});

await test("an expired session is not a session", async () => {
  const env = stubEnv([
    { match: /from sessions where token_hash/, rows: [{
      id: "s", subject_type: "staff", subject_id: "staff-1",
      expires_at: new Date(Date.now() - 1000).toISOString(), revoked_at: null,
    }] },
    { match: /select \* from staff where id/, rows: [STAFF] },
  ]);
  const r = await call(env, { code: TOKEN, action: "lookup", q: "A-041 123456" });
  assert.equal(r.status, 401);
});

await test("a revoked session is not a session", async () => {
  const env = stubEnv([
    { match: /from sessions where token_hash/, rows: [{
      id: "s", subject_type: "staff", subject_id: "staff-1",
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      revoked_at: new Date().toISOString(),
    }] },
    { match: /select \* from staff where id/, rows: [STAFF] },
  ]);
  assert.equal((await call(env, { code: TOKEN, action: "lookup", q: "x" })).status, 401);
});

await test("a deactivated staff account cannot act on a live token", async () => {
  const env = stubEnv(rules({ staff: { active: 0 } }));
  assert.equal((await call(env, { code: TOKEN, action: "lookup", q: "x" })).status, 401);
});

await test("a customer's own token cannot drive the counter", async () => {
  // Both kinds of user share the session table, so the endpoint must check the
  // KIND, not merely that the bearer resolves to somebody.
  const env = stubEnv([
    { match: /from sessions where token_hash/, rows: [{
      id: "s", subject_type: "customer", subject_id: "cust-1",
      expires_at: new Date(Date.now() + 864e5).toISOString(), revoked_at: null,
      last_seen_at: new Date().toISOString(),
    }] },
    { match: /select \* from customers where id/, rows: [{ id: "cust-1", display_name: "Jo" }] },
  ]);
  const r = await call(env, { code: "CWs_customer-token", action: "release", ticket_id: "ticket-1", note: "give it to me" });
  assert.equal(r.status, 401);
});

await test("a handler cannot reach a charger in another tent", async () => {
  // tentScope for a handler is their own tent, and every query is filtered by
  // it — so a ticket id from elsewhere resolves to nothing.
  const env = stubEnv(rules({ ticket: { tent_id: "tent-2" } }).map(r =>
    r.match.source.includes("t\\.id = \\?") ? { ...r, rows: [] } : r));
  const r = await call(env, { code: TOKEN, action: "release", ticket_id: "ticket-1", note: "not my tent" });
  assert.equal(r.status, 403);
  assert.match(r.error, /isn't in your tent/i);
});

await test("a bad ticket id is refused before it reaches a query", async () => {
  const env = stubEnv(rules());
  const r = await call(env, { code: TOKEN, action: "release", ticket_id: "ticket-1&status=eq.ready", note: "injection attempt" });
  assert.equal(r.status, 400);
});

await test("an unknown action does nothing", async () => {
  const env = stubEnv(rules());
  const r = await call(env, { code: TOKEN, action: "delete_everything" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(env.__db.writes.length, 0);
});

await test("a missing database binding answers 503, not a crash", async () => {
  const r = await collect({ env: {}, request: postRequest({ action: "lookup", q: "x" }) });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.match(j.error, /database isn't connected/i);
});

done();
