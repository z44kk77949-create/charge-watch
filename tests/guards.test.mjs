// Class-level guards.
//
// These don't test a feature; they test a RULE, statically, across the whole
// repo — so the next change that breaks one fails here rather than in a tent at
// midnight. Each one exists because of a specific way this kind of app goes
// wrong.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { suite } from "./_stub.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { test, done } = suite("guards");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const ALL = walk(ROOT);
const rel = (p) => relative(ROOT, p);
const read = (p) => readFileSync(p, "utf8");
const byExt = (ext) => ALL.filter(p => p.endsWith(ext));

// Strip comments before scanning for code patterns — otherwise a guard trips on
// the comment that explains the rule it enforces, which is its own small joke
// but a real maintenance tax.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}
const apiFiles = byExt(".js").filter(p => rel(p).startsWith("functions/api/"));
const surfaces = ALL.filter(p => p.endsWith("index.html"));

// --- Platform configuration --------------------------------------------------
await test("no Cloudflare config file is checked in", () => {
  // A repo-level wrangler config silently becomes the Pages project's source of
  // truth and destroys the dashboard-managed environment variables and
  // bindings — which is how a sibling app was taken down at its login gate for
  // an hour. Bindings and secrets are configured in the dashboard, only.
  const banned = ALL.filter(p => /(^|\/)wrangler\.(toml|json|jsonc)$/.test(rel(p)));
  assert.deepEqual(banned.map(rel), [], "remove these and configure bindings in the Cloudflare dashboard");
});

await test("no credential-shaped literal is committed", () => {
  const patterns = [
    [/\bsk-[A-Za-z0-9]{16,}/, "an API key"],
    [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/, "a Telegram bot token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  ];
  for (const p of [...byExt(".js"), ...byExt(".html"), ...byExt(".mjs"), ...byExt(".sql"), ...byExt(".md"), ...byExt(".yml")]) {
    const src = read(p);
    for (const [re, what] of patterns) {
      assert.ok(!re.test(src), `${rel(p)} looks like it contains ${what}`);
    }
  }
});

// --- Server-side authorisation ----------------------------------------------
await test("every write endpoint resolves its caller server-side", () => {
  // The rule: a POST handler must establish WHO is calling from the bearer
  // before it writes. A client-supplied id is never trusted.
  const exempt = new Set([
    "functions/api/auth.js",               // sign-in IS the thing that establishes identity
    "functions/api/telegram/webhook.js",   // authenticated by Telegram's secret header
    "functions/api/cron/reminders.js",     // authenticated by CRON_KEY
  ]);
  for (const p of apiFiles) {
    const name = rel(p);
    if (exempt.has(name) || name.includes("/_")) continue;
    const src = read(p);
    if (!/onRequestPost/.test(src)) continue;
    assert.ok(
      /requireStaff|requireCustomer|subjectByToken/.test(src),
      `${name} has a POST handler but never resolves the caller`
    );
  }
});

await test("the endpoints authenticated by a key compare it in constant time", () => {
  for (const name of ["functions/api/telegram/webhook.js", "functions/api/telegram/init.js", "functions/api/cron/reminders.js"]) {
    const src = read(join(ROOT, name));
    assert.ok(/timingSafeEqual/.test(src), `${name} must not compare its key with ===`);
  }
});

await test("no endpoint interpolates a value into its SQL", () => {
  // Every parameter goes through bind(). The only interpolation allowed is a
  // generated `?` placeholder list or a column name from a fixed allowlist.
  for (const p of apiFiles) {
    const src = read(p);
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!/(select|insert|update|delete)\s/i.test(line)) return;
      if (!/\$\{/.test(line)) return;
      const interpolations = line.match(/\$\{[^}]*\}/g) || [];
      for (const expr of interpolations) {
        const ok = /marks|sets\.join|blockSizes|table|SELECT|fields|sep|base|pageSize|page \*/.test(expr);
        assert.ok(ok, `${rel(p)}:${i + 1} interpolates ${expr} into SQL — bind it instead`);
      }
    });
  }
});

await test("a table name is only ever chosen from a fixed pair", () => {
  // `subjectByToken` picks its table from the session's subject_type, which
  // comes from our own database — but the guard keeps it explicit, so nobody
  // later widens it to something a request can influence.
  const src = read(join(ROOT, "functions/api/_util.js"));
  assert.match(src, /const table = s\.subject_type === "staff" \? "staff" : "customers";/,
    "the table choice must stay a literal ternary over two names");
});

// --- Secrets and credentials never leave the server --------------------------
await test("no endpoint selects a PIN hash or claim hash into a response", () => {
  // `select *` is used in places where the row stays server-side; what matters
  // is that the shaped responses don't carry these columns.
  for (const p of apiFiles) {
    const src = read(p);
    const returned = src.match(/return json\(\{[\s\S]{0,600}?\}\s*(?:,\s*\d+)?\)/g) || [];
    for (const block of returned) {
      for (const secret of ["pin_hash", "pin_salt", "claim_hash", "token_hash"]) {
        assert.ok(!block.includes(secret), `${rel(p)} returns ${secret} to the client`);
      }
    }
  }
});

await test("the claim code is hashed everywhere it is stored", () => {
  const intake = read(join(ROOT, "functions/api/intake.js"));
  assert.match(intake, /claim_hash/, "intake must store the hash");
  assert.ok(!/values[^)]*claim_code/.test(intake), "the plain code must never be written to the row");
  // It IS returned once, in the intake response — that is the slip, and the
  // only moment it exists in the clear.
  assert.match(intake, /claim_code: prettyCode\(claim\)/);
});

// --- Frontend house rules ----------------------------------------------------
await test("no surface uses a native dialog", () => {
  // Native alert/confirm freeze the thread, show the bare domain, and ignore
  // the theme. Everything goes through cwToast / cwConfirm.
  for (const p of [...surfaces, ...byExt(".js").filter(x => rel(x).startsWith("public/shared/"))]) {
    // `deferredInstall.prompt()` is the PWA install API, not window.prompt —
    // the lookbehind keeps property calls out.
    const src = stripComments(read(p));
    const hits = (src.match(/(?<![.\w])(alert|confirm|prompt)\s*\(/g) || []);
    assert.deepEqual(hits, [], `${rel(p)} calls a native dialog: ${hits.join(", ")}`);
  }
});

await test("no surface hardcodes a colour outside the design tokens", () => {
  // Colours live in app.css as tokens. The exceptions are deliberate and few:
  //   • the <meta name="theme-color"> literal, which cannot be a CSS variable
  //   • the camera viewport and the QR plate, which must stay black and white
  //     in every theme or a scanner loses contrast
  //   • rgba() overlays for scrims
  const allowed = new Set(["#0e0e0a", "#000", "#fff", "#ffffff", "#000000"]);
  for (const p of surfaces) {
    for (const hex of read(p).match(/#[0-9a-fA-F]{3,8}\b/g) || []) {
      // &#8942; — the kebab glyph — is an HTML entity, not a colour.
      if (/^#\d{4}$/.test(hex)) continue;
      assert.ok(allowed.has(hex.toLowerCase()), `${rel(p)} hardcodes ${hex}; use a CSS token`);
    }
  }
});

await test("the app shell's tokens cover every theme", () => {
  const css = read(join(ROOT, "public/shared/app.css"));
  const required = ["--bg", "--surface", "--text", "--muted", "--accent", "--border", "--ok", "--err"];
  for (const theme of [":root", 'html\\[data-theme="light"\\]']) {
    const block = new RegExp(theme + "\\s*\\{[^}]*\\}", "s").exec(css);
    assert.ok(block, `no ${theme} block in app.css`);
  }
  for (const token of required) {
    assert.ok(css.includes(token + ":"), `app.css never defines ${token}`);
  }
  // Light is a full palette, not a partial override that inherits dark values
  // for anything it forgot.
  const light = /html\[data-theme="light"\]\s*\{([^}]*)\}/s.exec(css)[1];
  for (const token of required) {
    assert.ok(light.includes(token + ":"), `the light theme never redefines ${token}`);
  }
});

await test("decorative motion is stilled under reduced-motion", () => {
  const css = read(join(ROOT, "public/shared/app.css"));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  for (const p of byExt(".js").filter(x => rel(x).startsWith("public/shared/"))) {
    const src = read(p);
    if (/animation:/.test(src)) {
      assert.match(src, /prefers-reduced-motion/, `${rel(p)} animates without a reduced-motion escape`);
    }
  }
});

await test("the service worker caches nothing", () => {
  // An offline cache on top of the no-cache headers is how a tent ends up
  // running last week's build with no way to clear it mid-event.
  const sw = read(join(ROOT, "public/sw.js"));
  assert.ok(!/caches\.(open|match)/.test(sw), "the service worker must not use the Cache API");
  assert.match(sw, /addEventListener\("fetch", \(\) => \{\}\)/, "the fetch handler stays empty on purpose");
});

await test("every surface loads the shared house kit rather than its own copy", () => {
  for (const p of surfaces) {
    const src = read(p);
    for (const lib of ["/shared/core.js", "/shared/dialog.js", "/shared/theme.js", "/shared/app.css"]) {
      assert.ok(src.includes(lib), `${rel(p)} doesn't load ${lib}`);
    }
  }
});

await test("user data reaching the DOM goes through esc()", () => {
  // The real injection risk is a field somebody TYPED — a name, a tag number, a
  // note, a tent's location — reaching innerHTML raw. So the guard looks for
  // exactly those fields inside a line that builds markup, and insists on esc().
  // Numbers, ids and internal flags are not the hazard and are not flagged.
  const USER_FIELDS = [
    "label", "owner_name", "device_desc", "notes", "note", "display_name",
    "location", "username", "detail", "actor_name", "tent_name", "customer_name",
    "slot", "release_note", "event_name", "ready_message", "claim_code",
    "status_label", "error", "message",
  ];
  const fieldRe = new RegExp("\\.(" + USER_FIELDS.join("|") + ")\\b");
  const suspicious = [];
  for (const p of surfaces) {
    stripComments(read(p)).split("\n").forEach((line, i) => {
      if (!/<[a-zA-Z/]/.test(line)) return;          // only lines building markup
      for (const expr of line.match(/\$\{[^}]*\}/g) || []) {
        if (!fieldRe.test(expr)) continue;           // not user-typed data
        if (/esc\(/.test(expr)) continue;            // escaped, as required
        suspicious.push(`${rel(p)}:${i + 1}  ${expr}`);
      }
    });
  }
  assert.deepEqual(suspicious, [], "these put user-entered text into HTML without esc()");
});

await test("the esc() guard would actually catch an unescaped field", () => {
  // A guard nobody has seen fail is a guard nobody knows works. This is the
  // same matcher, run against a line that is deliberately wrong.
  const USER_FIELDS = ["label", "owner_name", "tent_name"];
  const fieldRe = new RegExp("\\.(" + USER_FIELDS.join("|") + ")\\b");
  const bad = '<div class="title">${t.label}</div>';
  const good = '<div class="title">${esc(t.label)}</div>';
  const check = (line) => (line.match(/\$\{[^}]*\}/g) || []).some(e => fieldRe.test(e) && !/esc\(/.test(e));
  assert.equal(check(bad), true, "the guard must flag an unescaped field");
  assert.equal(check(good), false, "and must not flag an escaped one");
});

await test("the frontend never reports a server fault as a network problem", () => {
  // A non-JSON response means the request reached Cloudflare and something
  // failed before our code answered — a crash, or the platform killing it for
  // exceeding its CPU budget. Calling that "check your connection" sent a real
  // handler hunting for a fault on their own wifi.
  const core = read(join(ROOT, "public/shared/core.js"));
  assert.match(core, /__readJson/, "core.js must route responses through the shared reader");
  assert.match(core, /__servererr/, "and tag a server fault distinctly from a network one");
  // No surface may roll its own fetch for sign-in; they all go through postRaw.
  for (const p of surfaces) {
    const src = stripComments(read(p));
    assert.ok(!/fetch\("\/api\//.test(src),
      `${rel(p)} calls fetch() on the API directly — use api/post/postRaw so errors report consistently`);
  }
});

// --- Migrations --------------------------------------------------------------
await test("every migration is idempotent", () => {
  // The deploy story re-applies migrations, so a statement that isn't safe to
  // run twice will fail a later deploy or, worse, revert an edit made in the app.
  for (const p of byExt(".sql").filter(x => /migration-\d+\.sql$/.test(rel(x)))) {
    const src = read(p).toLowerCase();
    for (const stmt of src.split(";")) {
      const s = stmt.trim();
      if (!s) continue;
      if (s.startsWith("create table")) assert.match(s, /if not exists/, `${rel(p)}: create table without "if not exists"`);
      if (s.startsWith("create index")) assert.match(s, /if not exists/, `${rel(p)}: create index without "if not exists"`);
      if (s.startsWith("insert into")) assert.match(s, /on conflict/, `${rel(p)}: insert without "on conflict"`);
      // An unconditional UPDATE re-runs on every deploy and silently reverts
      // whatever the owner has since changed in the app.
      assert.ok(!/^update\s/.test(s) || /where/.test(s), `${rel(p)}: unconditional update`);
    }
  }
});

await test("schema.sql covers every table the code reads or writes", () => {
  const schema = read(join(ROOT, "db/schema.sql"));
  const tables = new Set();
  for (const p of apiFiles) {
    // Only strings that are actually SQL are scanned. Matching the bare words
    // anywhere would read "Couldn't update that charger" as a table named
    // "that" — user-facing prose is full of these verbs.
    const src = stripComments(read(p));
    for (const lit of src.match(/`[^`]*`|"[^"\n]*"|'[^'\n]*'/g) || []) {
      const sql = lit.slice(1, -1);
      if (!/^\s*(select|insert|update|delete|with)\b/i.test(sql)) continue;
      for (const m of sql.matchAll(/\b(?:from|into|update|join)\s+([a-z_]{3,})\b/g)) tables.add(m[1]);
    }
  }
  // "set" comes from an upsert's `on conflict … do update set`; "excluded" is
  // SQLite's pseudo-table for the row that would have been inserted.
  const notTables = new Set(["set", "excluded", "rest", "tickets_view", "v1"]);
  for (const t of tables) {
    if (notTables.has(t)) continue;
    assert.ok(new RegExp(`create table if not exists ${t}\\b`).test(schema), `db/schema.sql has no table "${t}"`);
  }
});

done();
