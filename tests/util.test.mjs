// The primitives everything else trusts: claim codes, the rotating collection
// code, pairing tokens, PIN hashing and the input-boundary guards.

import assert from "node:assert/strict";
import { suite, stubEnv } from "./_stub.mjs";
import {
  newClaimCode, normCode, prettyCode, codeHint, isSafeId, clean, timingSafeEqual,
  collectCode, verifyCollectCode, qrPayload, parseQrPayload,
  pairToken, verifyPairToken, hashPin, newSalt, isValidPin,
  pinIters, rowPinIters, DEFAULT_PIN_ITERS, MIN_PIN_LEN,
  newSessionToken, SESSION_PREFIX, nextRef, getSettings, settingOn, DEFAULT_SETTINGS,
} from "../functions/api/_util.js";

const { test, done } = suite("util");
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// --- Claim codes -------------------------------------------------------------
await test("a claim code is 8 characters from the unambiguous alphabet", () => {
  for (let i = 0; i < 400; i++) {
    const c = newClaimCode();
    assert.equal(c.length, 8, `wrong length: ${c}`);
    for (const ch of c) assert.ok(ALPHABET.includes(ch), `character ${ch} is not in the alphabet`);
    assert.ok(!/[ILOU]/.test(c), `${c} contains a look-alike character`);
  }
});

await test("claim codes are drawn without modulo bias", () => {
  // Rejection sampling should leave every symbol roughly equally likely. With
  // 32 symbols over 40,000 draws the expected count is 1,250 each; a biased
  // generator (plain `% 32` over a byte) would push the first 8 symbols about
  // 12% high, far outside this band.
  const counts = new Map();
  for (let i = 0; i < 5000; i++) for (const ch of newClaimCode()) counts.set(ch, (counts.get(ch) || 0) + 1);
  assert.equal(counts.size, 32, "every symbol should appear");
  const expected = (5000 * 8) / 32;
  for (const [ch, n] of counts) {
    assert.ok(Math.abs(n - expected) < expected * 0.18, `symbol ${ch} appeared ${n} times, expected about ${expected}`);
  }
});

await test("claim codes do not repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(newClaimCode());
  assert.equal(seen.size, 2000, "a collision in 2,000 draws means the generator is not random");
});

await test("normCode folds the look-alikes people actually type", () => {
  assert.equal(normCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normCode("ABCD EFGH"), "ABCDEFGH");
  assert.equal(normCode("  abcd–efgh  "), "ABCDEFGH");
  // O reads as zero, I and L read as one — a slip squinted at in the dark.
  assert.equal(normCode("O0IL1"), "00111");
  assert.equal(normCode("2QRSTVWX"), "2QRSTVWX");
  assert.equal(normCode(null), "");
  assert.equal(normCode(undefined), "");
});

await test("a generated code survives being read aloud and typed back", () => {
  for (let i = 0; i < 200; i++) {
    const c = newClaimCode();
    assert.equal(normCode(prettyCode(c)), c, "pretty formatting must normalise back to the same code");
    assert.equal(normCode(c.toLowerCase()), c);
  }
});

await test("prettyCode and codeHint present without revealing", () => {
  assert.equal(prettyCode("ABCD2345"), "ABCD-2345");
  assert.equal(codeHint("ABCD2345"), "345");
  assert.equal(codeHint(""), "");
  assert.equal(prettyCode(""), "");
});

// --- Rotating collection code ------------------------------------------------
await test("a collection code is six digits and verifies for its own ticket", async () => {
  const env = stubEnv([]);
  const { code, expires_in } = await collectCode(env, "ticket-1");
  assert.match(code, /^\d{6}$/);
  assert.ok(expires_in > 0 && expires_in <= 5 * 60 * 1000);
  assert.equal(await verifyCollectCode(env, "ticket-1", code), true);
});

await test("a collection code does NOT verify for a different ticket", async () => {
  // This is the property that stops a valid code for one charger releasing
  // another: the code is bound to the ticket id, not just to the moment.
  const env = stubEnv([]);
  const a = await collectCode(env, "ticket-a");
  assert.equal(await verifyCollectCode(env, "ticket-b", a.code), false);
});

await test("a collection code does not verify under a different signing secret", async () => {
  const one = stubEnv([]);
  const two = stubEnv([], { PAIR_SECRET: "a-different-secret" });
  const { code } = await collectCode(one, "ticket-1");
  assert.equal(await verifyCollectCode(two, "ticket-1", code), false);
});

await test("malformed collection codes are rejected outright", async () => {
  const env = stubEnv([]);
  for (const bad of ["", null, undefined, "12345", "1234567", "abcdef", {}, []]) {
    assert.equal(await verifyCollectCode(env, "ticket-1", bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

await test("the QR payload round-trips and rejects anything else", () => {
  assert.equal(qrPayload("A-041", "274913"), "CW1:A-041:274913");
  assert.deepEqual(parseQrPayload("CW1:A-041:274913"), { ref: "A-041", code: "274913" });
  assert.deepEqual(parseQrPayload("cw1:a-041:274913"), { ref: "A-041", code: "274913" });
  for (const bad of ["CW1:A-041:27491", "CW2:A-041:274913", "A-041:274913", "CW1::274913", "", null,
                     "CW1:A-041:274913; drop table tickets", "CW1:A 041:274913"]) {
    assert.equal(parseQrPayload(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

// --- Telegram pairing --------------------------------------------------------
await test("a pairing token verifies back to its own customer id", async () => {
  const env = stubEnv([]);
  const tok = await pairToken(env, "customer-123");
  assert.ok(tok && tok.includes("."));
  assert.equal(await verifyPairToken(env, tok), "customer-123");
});

await test("a pairing token cannot be forged or re-pointed", async () => {
  const env = stubEnv([]);
  const tok = await pairToken(env, "customer-123");
  const sig = tok.split(".")[1];
  // Swapping the id while keeping a valid-looking signature is the attack this
  // exists to stop: a deep link pasted in a group chat must not let a reader
  // point the bot at somebody else's charger.
  assert.equal(await verifyPairToken(env, `customer-999.${sig}`), null);
  assert.equal(await verifyPairToken(env, "customer-123.notasignature"), null);
  assert.equal(await verifyPairToken(env, "customer-123"), null);
  assert.equal(await verifyPairToken(env, ""), null);
  assert.equal(await verifyPairToken(env, "../../etc/passwd.sig"), null);
});

await test("a pairing token from another deployment is rejected", async () => {
  const a = stubEnv([]);
  const b = stubEnv([], { PAIR_SECRET: "other-deployment" });
  assert.equal(await verifyPairToken(b, await pairToken(a, "customer-123")), null);
});

// --- PINs --------------------------------------------------------------------
await test("PIN hashing is deterministic per salt and differs across salts", async () => {
  const s1 = newSalt(), s2 = newSalt();
  assert.match(s1, /^[0-9a-f]{32}$/);
  assert.notEqual(s1, s2);
  const a = await hashPin("123456", s1);
  assert.equal(a, await hashPin("123456", s1), "same PIN and salt must hash the same");
  assert.notEqual(a, await hashPin("123456", s2), "the same PIN under two salts must not collide");
  assert.notEqual(a, await hashPin("123457", s1));
  assert.match(a, /^[0-9a-f]{64}$/);
});

await test("the work factor changes the hash, so it must be stored to verify", async () => {
  const salt = newSalt();
  const a = await hashPin("123456", salt, 5000);
  const b = await hashPin("123456", salt, 6000);
  assert.notEqual(a, b, "a different iteration count must give a different hash");
  assert.equal(a, await hashPin("123456", salt, 5000));
});

await test("the work factor stays inside the free plan's CPU budget", () => {
  // Workers Free allows 10 ms of CPU per request, shared with the database
  // round trip and the JSON. Measured: ~3.9 ms at 25,000 iterations, ~6.6 ms at
  // 50,000, ~19 ms at 150,000. Going over does not merely slow things down —
  // the platform kills the request (error 1102) before our code can answer,
  // and the app reports a server fault to a handler who can do nothing about
  // it. Raise this only alongside the Workers Paid plan.
  assert.ok(DEFAULT_PIN_ITERS <= 30000,
    `DEFAULT_PIN_ITERS is ${DEFAULT_PIN_ITERS}; above ~30,000 the free plan kills the request`);
  assert.ok(DEFAULT_PIN_ITERS >= 10000, "and below 10,000 the work factor stops being worth having");
});

await test("the work factor is settable per deployment, within sane bounds", () => {
  assert.equal(pinIters({}), DEFAULT_PIN_ITERS);
  assert.equal(pinIters({ PIN_ITERATIONS: "50000" }), 50000, "a paid deployment can raise it");
  for (const bad of ["0", "999", "700000", "abc", "", "-5000", "25000.5"]) {
    assert.equal(pinIters({ PIN_ITERATIONS: bad }), DEFAULT_PIN_ITERS, `accepted ${JSON.stringify(bad)}`);
  }
});

await test("a row's own work factor wins, and pre-column rows fall back", () => {
  assert.equal(rowPinIters({ pin_iters: 25000 }), 25000);
  // Rows written before the column existed were hashed at 150,000; reading them
  // as "the current default" would lock those accounts out permanently.
  assert.equal(rowPinIters({}), 150000);
  assert.equal(rowPinIters({ pin_iters: null }), 150000);
  assert.equal(rowPinIters({ pin_iters: 0 }), 150000);
  assert.equal(rowPinIters(null), 150000);
});

await test("PIN format is enforced at the boundary", () => {
  assert.equal(MIN_PIN_LEN, 6, "six digits is the floor that makes an offline attack non-trivial");
  for (const good of ["123456", "000000", "1234567890"]) assert.equal(isValidPin(good), true, `rejected ${good}`);
  // Four digits is only ten thousand candidates — no work factor rescues that,
  // so the length floor is the control that matters.
  for (const bad of ["1234", "12345", "12345678901", "12a456", "", " 123456", "123456 ", null, 123456, undefined]) {
    assert.equal(isValidPin(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

// --- Guards ------------------------------------------------------------------
await test("isSafeId admits real ids and refuses filter metacharacters", () => {
  assert.equal(isSafeId(crypto.randomUUID()), true);
  assert.equal(isSafeId("abc_123-XYZ"), true);
  for (const bad of ["", "a b", "a.b", "a,b", "a&b", "a=b", "a/b", "a%b", "a(b)", "a'b", null, 42, "x".repeat(65)]) {
    assert.equal(isSafeId(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

await test("clean strips control characters and bounds the length", () => {
  assert.equal(clean("  hello  "), "hello");
  assert.equal(clean("a\u0000b\nc"), "a b c");
  assert.equal(clean("x".repeat(500), 40).length, 40);
  assert.equal(clean(null), "");
  assert.equal(clean(undefined), "");
  // Markup is not stripped here — escaping is the renderer's job (esc in
  // core.js), and stripping it at the boundary would quietly mangle a name.
  assert.equal(clean("<b>Jo</b>"), "<b>Jo</b>");
});

await test("timingSafeEqual compares correctly", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
  assert.equal(timingSafeEqual(null, ""), true);
  assert.equal(timingSafeEqual("abc", null), false);
});

await test("session tokens are prefixed and unguessable", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const t = newSessionToken();
    assert.ok(t.startsWith(SESSION_PREFIX));
    assert.ok(t.length > 40, "token is too short to be 32 random bytes");
    seen.add(t);
  }
  assert.equal(seen.size, 500);
});

// --- Ticket references -------------------------------------------------------
await test("ticket refs continue a tent's numbering and start at 001", async () => {
  const empty = stubEnv([{ match: /from tickets/, rows: [] }]);
  assert.equal(await nextRef(empty, { id: "t1", code: "A" }), "A-001");

  const running = stubEnv([{ match: /from tickets/, rows: [{ ref: "A-041" }] }]);
  assert.equal(await nextRef(running, { id: "t1", code: "A" }), "A-042");

  // Past 999 the padding stops mattering but the sequence must not restart.
  const high = stubEnv([{ match: /from tickets/, rows: [{ ref: "A-999" }] }]);
  assert.equal(await nextRef(high, { id: "t1", code: "A" }), "A-1000");

  // A tent whose code contains a digit must not have it read as the number.
  const digits = stubEnv([{ match: /from tickets/, rows: [{ ref: "T2-007" }] }]);
  assert.equal(await nextRef(digits, { id: "t1", code: "T2" }), "T2-008");
});

// --- Settings ----------------------------------------------------------------
await test("settings from the database override the code's fallbacks", async () => {
  const env = stubEnv([{ match: /from settings/, rows: [{ key: "event_name", value: "Glasto" }, { key: "reminder_hours", value: "6" }] }]);
  const s = await getSettings(env);
  assert.equal(s.event_name, "Glasto", "the DB value must win");
  assert.equal(s.reminder_hours, "6");
  // Anything the DB does not carry falls back, rather than coming back undefined.
  assert.equal(s.ready_message, DEFAULT_SETTINGS.ready_message);
  assert.equal(settingOn(s, "collect_requires_code"), true);
});

await test("an empty settings table yields the documented defaults", async () => {
  const s = await getSettings(stubEnv([]));
  assert.deepEqual(s, DEFAULT_SETTINGS);
});

done();
