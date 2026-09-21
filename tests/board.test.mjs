// The tent board — moving a charger along, and the boundaries around it.

import assert from "node:assert/strict";
import { suite, stubEnv, postRequest, getRequest } from "./_stub.mjs";
import { onRequestPost as board, onRequestGet as boardGet } from "../functions/api/board.js";

const { test, done } = suite("board");

const TOKEN = "CWs_staff-token";
const STAFF = { id: "staff-1", name: "Sam", role: "handler", tent_id: "tent-1", active: 1 };
const TICKET = {
  id: "ticket-1", ref: "A-041", tent_id: "tent-1", customer_id: null,
  label: "47", slot: "B3", status: "charging", owner_name: "Jo",
  tent_name: "Tent A", tent_location: "By the bar",
  received_at: "2026-09-21T18:00:00.000Z", charging_at: "2026-09-21T18:01:00.000Z",
};

function rules(overrides = {}) {
  const ticket = { ...TICKET, ...(overrides.ticket || {}) };
  return [
    { match: /from sessions where token_hash/, rows: [{
      id: "sess-1", subject_type: "staff", subject_id: "staff-1",
      expires_at: new Date(Date.now() + 864e5).toISOString(), revoked_at: null,
      last_seen_at: new Date().toISOString(),
    }] },
    { match: /select \* from staff where id/, rows: [{ ...STAFF, ...(overrides.staff || {}) }] },
    { match: /select id from tents/, rows: [{ id: "tent-1" }, { id: "tent-2" }] },
    { match: /from settings/, rows: overrides.settings || [] },
    { match: /from tickets t\s+join tents n on n\.id = t\.tent_id where t\.id = \?/, rows: overrides.outOfScope ? [] : [ticket] },
    { match: /select \* from customers where id/, rows: overrides.customer || [] },
    { match: /group by status/, rows: [{ status: "charging", n: 3 }, { status: "ready", n: 2 }, { status: "collected", n: 5 }] },
    { match: /from tents where id in/, rows: [{ id: "tent-1", name: "Tent A", code: "A" }] },
    { match: /from tickets t join tents n/, rows: overrides.list || [ticket] },
  ];
}

const call = (env, body) => board({ env, request: postRequest(body) }).then(r => r.json().then(j => ({ status: r.status, ...j })));

// --- Status ------------------------------------------------------------------
await test("marking ready stamps the time and who did it", async () => {
  const env = stubEnv(rules());
  const r = await call(env, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: "ready" });
  assert.equal(r.ok, true);
  assert.equal(r.status, "ready");
  const w = env.__db.writeMatching(/update tickets set/);
  assert.match(w.sql, /ready_at = \?/);
  assert.match(w.sql, /ready_by = \?/);
  assert.ok(w.params.includes("staff-1"), "the handler who marked it must be recorded");
  assert.ok(env.__db.writeMatching(/insert into audit_log/), "the move must be audited");
});

await test("marking ready re-arms the reminder clock", async () => {
  // Otherwise a charger marked ready, taken back to charging and readied again
  // would inherit the old reminder stamp and never nudge its owner.
  const env = stubEnv(rules({ ticket: { status: "charging", reminded_at: "2026-09-21T10:00:00.000Z" } }));
  await call(env, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: "ready" });
  const w = env.__db.writeMatching(/update tickets set/);
  assert.match(w.sql, /reminded_at = \?/);
  assert.ok(w.params.includes(null), "reminded_at must be cleared");
});

await test("a ready charger with no linked phone reports that nobody was told", async () => {
  const env = stubEnv(rules());
  const r = await call(env, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: "ready" });
  assert.equal(r.notified, 0);
  assert.equal(r.linked, false, "the console needs to know to call the name out");
});

await test("a linked customer is looked up so a notification can go out", async () => {
  const env = stubEnv(rules({
    ticket: { customer_id: "cust-1" },
    customer: [{ id: "cust-1", notify_telegram: 1, telegram_chat_id: "123", notify_push: 0 }],
  }));
  const r = await call(env, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: "ready" });
  assert.equal(r.ok, true);
  assert.equal(r.linked, true);
  // Telegram is not configured in the test environment, so nothing actually
  // sends — the point is that the state change succeeded regardless.
  assert.equal(r.notified, 0);
});

await test("starting a charge stamps charging_at only the first time", async () => {
  const fresh = stubEnv(rules({ ticket: { status: "received", charging_at: null } }));
  await call(fresh, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: "charging" });
  assert.match(fresh.__db.writeMatching(/update tickets set/).sql, /charging_at = \?/);

  const again = stubEnv(rules({ ticket: { status: "ready", charging_at: "2026-09-21T18:01:00.000Z" } }));
  await call(again, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: "charging" });
  assert.ok(!/charging_at = \?/.test(again.__db.writeMatching(/update tickets set/).sql),
    "going back to charging must not rewrite when it first went on charge");
});

await test("the board cannot mark a charger collected", async () => {
  // Collection has to go through /api/collect, where the customer's proof is
  // checked. A status button that could do it would route around that entirely.
  const env = stubEnv(rules());
  const r = await call(env, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: "collected" });
  assert.equal(r.ok, false);
  assert.match(r.error, /use collect/i);
  assert.equal(env.__db.writeMatching(/update tickets/), undefined);
});

await test("a collected charger cannot be moved back onto the board", async () => {
  const env = stubEnv(rules({ ticket: { status: "collected" } }));
  const r = await call(env, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: "charging" });
  assert.equal(r.status, 409);
  assert.equal(env.__db.writeMatching(/update tickets/), undefined);
});

await test("an unknown status is refused", async () => {
  const env = stubEnv(rules());
  for (const s of ["done", "", "DROP", null]) {
    const r = await call(env, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: s });
    assert.equal(r.status, 400, `${s} should be refused`);
  }
  assert.equal(env.__db.writeMatching(/update tickets/), undefined);
});

await test("setting the status it already has is a no-op, not a write", async () => {
  const env = stubEnv(rules({ ticket: { status: "ready" } }));
  const r = await call(env, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: "ready" });
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
  assert.equal(env.__db.writeMatching(/update tickets/), undefined);
});

// --- Edit --------------------------------------------------------------------
await test("editing writes only the fields that changed", async () => {
  const env = stubEnv(rules());
  const r = await call(env, { code: TOKEN, action: "edit", ticket_id: "ticket-1", slot: "C1", label: "47" });
  assert.equal(r.ok, true);
  const w = env.__db.writeMatching(/update tickets set/);
  assert.match(w.sql, /slot = \?/);
  assert.ok(!/label = \?/.test(w.sql), "an unchanged label must not be rewritten");
});

await test("an edit that changes nothing does not touch the database", async () => {
  const env = stubEnv(rules());
  const r = await call(env, { code: TOKEN, action: "edit", ticket_id: "ticket-1", slot: "B3", label: "47" });
  assert.equal(r.unchanged, true);
  assert.equal(env.__db.writes.length, 0);
});

// --- Reissue -----------------------------------------------------------------
await test("a lost slip can be reissued, invalidating the old code", async () => {
  const env = stubEnv(rules());
  const r = await call(env, { code: TOKEN, action: "reissue", ticket_id: "ticket-1" });
  assert.equal(r.ok, true);
  assert.match(r.claim_code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const w = env.__db.writeMatching(/update tickets set claim_hash/);
  assert.ok(w, "the stored hash must be replaced so the old slip stops working");
  assert.ok(!w.params.includes(r.claim_code.replace("-", "")), "the new code itself is never stored");
  const a = env.__db.writeMatching(/insert into audit_log/);
  assert.equal(a.params[9], 1, "a reissue is flagged for the organiser");
});

await test("a charger linked to a phone cannot have its code reissued", async () => {
  // At that point the owner already has a working code in the app, and a
  // handler reissuing over the counter would be handing a fresh credential for
  // someone else's charger to whoever asked for it.
  const env = stubEnv(rules({ ticket: { customer_id: "cust-1" } }));
  const r = await call(env, { code: TOKEN, action: "reissue", ticket_id: "ticket-1" });
  assert.equal(r.status, 409);
  assert.match(r.error, /linked to its owner/i);
  assert.equal(env.__db.writeMatching(/update tickets/), undefined);
});

await test("a collected charger cannot have its code reissued", async () => {
  const env = stubEnv(rules({ ticket: { status: "collected" } }));
  assert.equal((await call(env, { code: TOKEN, action: "reissue", ticket_id: "ticket-1" })).status, 409);
});

// --- Scope -------------------------------------------------------------------
await test("a handler cannot move a charger in another tent", async () => {
  const env = stubEnv(rules({ outOfScope: true }));
  const r = await call(env, { code: TOKEN, action: "status", ticket_id: "ticket-1", status: "ready" });
  assert.equal(r.status, 403);
  assert.equal(env.__db.writeMatching(/update tickets/), undefined);
});

await test("a handler with no tent sees an empty board rather than everything", async () => {
  const env = stubEnv(rules({ staff: { tent_id: null } }));
  const r = await boardGet({ env, request: getRequest("code=" + TOKEN) }).then(x => x.json());
  assert.equal(r.ok, true);
  assert.deepEqual(r.tickets, [], "no tent must mean nothing visible, never all tents");
  assert.equal(r.counts.open, 0);
});

await test("the board filters to the tent asked for, but only within scope", async () => {
  const env = stubEnv(rules());
  await boardGet({ env, request: getRequest(`code=${TOKEN}&tent=tent-2`) }).then(x => x.json());
  const read = env.__db.reads.find(r => /from tickets t join tents n/.test(r.sql));
  assert.ok(read, "the board should have been queried");
  assert.ok(!read.params.includes("tent-2"), "a tent outside the handler's scope must be ignored");
  assert.ok(read.params.includes("tent-1"), "the query must stay scoped to their own tent");
});

await test("a search term is bound, never interpolated", async () => {
  const env = stubEnv(rules());
  await boardGet({ env, request: getRequest(`code=${TOKEN}&q=${encodeURIComponent("'; drop table tickets --")}`) }).then(x => x.json());
  const read = env.__db.reads.find(r => /from tickets t join tents n/.test(r.sql));
  assert.ok(!/drop table/i.test(read.sql), "the search text must not reach the statement");
  assert.ok(read.params.some(p => String(p).includes("DROP TABLE")), "it should arrive as a bound parameter");
});

await test("an unsigned caller gets nothing from the board", async () => {
  const env = stubEnv([{ match: /from sessions where token_hash/, rows: [] }]);
  assert.equal((await boardGet({ env, request: getRequest("code=CWs_nope") })).status, 401);
  assert.equal((await call(env, { code: "CWs_nope", action: "status", ticket_id: "t", status: "ready" })).status, 401);
});

done();
