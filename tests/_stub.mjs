// A tiny stand-in for a D1 binding, so the API functions can be driven in a
// plain Node process — no wrangler, no network, no database.
//
// It is NOT a SQL engine and does not pretend to be. Each rule matches the
// statement text with a regular expression and returns canned rows; writes are
// recorded so a test can assert what the endpoint tried to change. That is
// enough to test the things worth testing here — authorisation, verification
// and the shape of what gets written — without a test suite that needs
// infrastructure to run.

export function stubDb(rules = []) {
  const writes = [];
  const reads = [];

  function resolve(sql, params) {
    for (const rule of rules) {
      if (rule.match.test(sql)) {
        if (rule.fail) throw new Error(rule.fail === true ? "stub failure" : rule.fail);
        const rows = typeof rule.rows === "function" ? rule.rows(params, sql) : (rule.rows || []);
        return Array.isArray(rows) ? rows : [rows];
      }
    }
    return [];
  }

  const isWrite = (sql) => /^\s*(insert|update|delete)/i.test(sql);

  function statement(sql, params) {
    return {
      async first() { reads.push({ sql, params }); return resolve(sql, params)[0] ?? null; },
      async all() { reads.push({ sql, params }); return { results: resolve(sql, params) }; },
      async run() {
        if (isWrite(sql)) writes.push({ sql, params });
        else reads.push({ sql, params });
        resolve(sql, params);       // lets a rule with `fail` reject a write
        return { success: true };
      },
    };
  }

  return {
    DB: {
      prepare(sql) {
        return { bind: (...params) => statement(sql, params), ...statement(sql, []) };
      },
    },
    writes, reads,
    // Convenience for assertions: the first recorded write whose SQL matches.
    writeMatching(re) { return writes.find(w => re.test(w.sql)); },
  };
}

// An environment with the secrets the app signs with, but no Telegram or push
// configured — so notification fan-out is dormant and the tests never reach the
// network.
export function stubEnv(rules, extra = {}) {
  const db = stubDb(rules);
  return Object.assign({ DB: db.DB, PAIR_SECRET: "test-pair-secret", ADMIN_INIT_KEY: "test-admin-key" }, extra, { __db: db });
}

// Build a Request the Pages Functions handlers can read.
export function postRequest(body, url = "https://charge.test/api/x") {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": "test-agent" },
    body: JSON.stringify(body),
  });
}

export function getRequest(query = "", url = "https://charge.test/api/x") {
  return new Request(url + (query ? "?" + query : ""));
}

// Minimal test harness — same shape across every suite in this repo.
export function suite(title) {
  console.log(`=== ${title} ===`);
  const state = { failures: 0 };
  return {
    state,
    async test(name, fn) {
      try { await fn(); console.log(`  ok   ${name}`); }
      catch (e) { state.failures++; console.error(`  FAIL ${name}\n       ${e && e.message}`); }
    },
    done() {
      console.log(state.failures ? `\n${state.failures} test(s) FAILED` : "\nall tests passed");
      process.exit(state.failures ? 1 : 0);
    },
  };
}
