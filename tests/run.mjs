// Test runner. Syntax-checks every JavaScript file, then spawns each
// tests/*.test.mjs in its own process (so a stub in one suite can't leak into
// another) and fails if any suite does.
//
// Dependency-free by design — no browser, no npm install — so CI is fast
// enough to gate every push and a contributor can run it offline.
//
//   node tests/run.mjs

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".js") || p.endsWith(".mjs")) out.push(p);
  }
  return out;
}

let failed = 0;

console.log("=== syntax ===");
const sources = walk(ROOT).sort();
for (const file of sources) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`  FAIL ${relative(ROOT, file)}\n${r.stderr}`);
  }
}
console.log(`  ${sources.length} file(s) parsed${failed ? `, ${failed} failed` : ""}`);

const suites = readdirSync(DIR).filter(f => f.endsWith(".test.mjs")).sort();
for (const f of suites) {
  console.log("");
  const r = spawnSync(process.execPath, [join(DIR, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

console.log("\n" + "=".repeat(46));
console.log(failed ? `${failed} check(s)/suite(s) FAILED` : `all ${suites.length} suite(s) passed`);
process.exit(failed ? 1 : 0);
