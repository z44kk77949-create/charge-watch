// Shared frontend core — the request + escaping primitives every surface needs.
// Classic script, loaded FIRST on all three pages (soldier PWA, command console,
// admin console) so its top-level `const`/`function` are globals the inline page
// scripts and the other shared modules (profile-card / console-lib / app-refresh)
// call at runtime. These were byte-for-byte identical inline in all three; one
// copy here keeps them from drifting.
//
// Deliberately NOT here (they legitimately diverge per surface — diff before
// sharing): `jsq`/`jsAttr` (admin's jsq omits backslash-escaping), `ME`/`applyMe`
// (admin toggles the feedback inbox), the `routes` table, and `route()`.

// The session token (minted at sign-in), sent as the bearer on every request.
const code = () => localStorage.getItem("cw_code");

// If the server rejects our session (revoked from another device via "sign out
// everywhere", expired server-side, or the session row is gone), a token still
// sitting in localStorage is dead — a 401 means we're not actually signed in.
// Stop pretending: clear the token and reload so the page's boot path shows the
// sign-in screen instead of an empty signed-in shell. Guarded to fire once per
// load, and only for a real token session (never on the sign-in screen).
let __sessionDead = false;
function __sessionRejected() {
  if (__sessionDead) return;
  const c = localStorage.getItem("cw_code");
  if (!c || !c.startsWith("CWs_")) return;
  __sessionDead = true;
  try { localStorage.removeItem("cw_code"); localStorage.removeItem("cw_session_at"); } catch {}
  location.reload();
}

// GET → json. Appends the code to the query string. NEVER rejects: a network
// drop or non-JSON body resolves to a tagged error object so every caller's
// `if (!d.ok)` path handles it (no unhandled rejections, no blank/hung tabs).
// The `__neterr` flag lets callers tell a transient network failure apart from a
// real "not ok" (e.g. auth) — so a blip doesn't get treated like a sign-out.
const NET_ERR = () => ({ ok: false, error: "Network error — check your connection.", __neterr: true });
function __rawGet(p) {
  return fetch(p + (p.includes("?") ? "&" : "?") + "code=" + encodeURIComponent(code()))
    .then(r => { if (r.status === 401) __sessionRejected(); return r.json(); })
    .catch(() => NET_ERR());
}

// Prefetch: warm a tab's GET response on idle so switching to it opens with the data
// already in hand (no visible network wait). Entries are ONE-SHOT — the next api() for
// that path consumes the warmed promise — with a 60s freshness cap so a warmed-then-
// -much-later visit re-fetches instead of showing stale data. POSTs never touch this.
const __prefetch = new Map();   // path -> { t, pr }
function prefetch(p) { if (!p || __prefetch.has(p) || !code()) return; try { __prefetch.set(p, { t: Date.now(), pr: __rawGet(p) }); } catch (e) {} }
function warmTabs(paths) {
  const go = () => { (paths || []).forEach(prefetch); };
  if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 800 }); else setTimeout(go, 350);
}
const api = (p) => {
  const e = __prefetch.get(p);
  // Serve the warmed response unless stale — and never a warmed FAILURE: a
  // boot-time blip used to surface as "Network error" seconds after the radio
  // recovered (failure-cache class, 28 Jul); refetch live instead.
  if (e) { __prefetch.delete(p); if (Date.now() - e.t < 60000) return e.pr.then((r) => (r && r.__neterr) ? __rawGet(p) : r); }
  return __rawGet(p);
};

// Coalesce accidental double-submits: while an identical POST is in flight, a
// repeat click (the classic "laggy button tapped twice") reuses the same
// promise instead of firing a second request. Cleared when the request settles.
const __inflight = new Map();
let __clickPost = null;   // the promise the current click's submit produced (if any)
const post = (p, b) => {
  const body = JSON.stringify({ code: code(), ...b });
  const key = p + "\n" + body;
  let pr = __inflight.get(key);
  if (!pr) {
    pr = fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body }).then(r => { if (r.status === 401) __sessionRejected(); return r.json(); }).catch(() => NET_ERR()).finally(() => __inflight.delete(key));
    __inflight.set(key, pr);
  }
  __clickPost = pr;
  return pr;
};
// UX guard: when a click actually fires a submit (a post()), disable that one
// button until the request settles — so a laggy submit can't be double-tapped.
// Capture phase + microtask so it still works inside modals that stopPropagation,
// and so buttons whose click does NOT post (quiz nav, steppers, tabs) are left
// alone. post() sets __clickPost synchronously during the click; the microtask
// reads it immediately after the button's own onclick has run.
document.addEventListener("click", (e) => {
  const btn = e.target && e.target.closest && e.target.closest("button");
  if (!btn || btn.disabled) return;
  __clickPost = null;
  Promise.resolve().then(() => {
    const pr = __clickPost; __clickPost = null;
    if (!pr || btn.disabled) return;
    btn.disabled = true;
    const prevOp = btn.style.opacity; btn.style.opacity = "0.55";
    const restore = () => { btn.disabled = false; btn.style.opacity = prevOp; };
    pr.then(restore, restore);
  });
}, true);

// Loading skeleton — shimmer placeholder cards to show WHILE a view loads, instead
// of a blank "Loading…" (best-practice: mask the wait, don't announce the lag). Used
// by the tab/sub-tab renderers. Theme-aware (CSS vars), reduced-motion safe.
function __cwSkelCss() {
  if (document.getElementById("cw-sk-css")) return;
  const s = document.createElement("style"); s.id = "cw-sk-css";
  s.textContent =
    ".cw-sk{padding:4px 2px;}" +
    ".cw-sk-card{background:var(--surface,#fff);border:1px solid var(--border,#e6e6e6);border-radius:12px;padding:14px;margin:10px 0;}" +
    ".cw-sk-line{height:11px;border-radius:6px;margin:9px 0;background:linear-gradient(90deg,var(--divider,#ececec) 25%,var(--surface-2,#f6f6f4) 40%,var(--divider,#ececec) 60%);background-size:300% 100%;animation:cw-sk-sh 1.2s ease-in-out infinite;}" +
    "@keyframes cw-sk-sh{0%{background-position:135% 0}100%{background-position:-135% 0}}" +
    "@media (prefers-reduced-motion:reduce){.cw-sk-line{animation:none;opacity:.7;}}";
  document.head.appendChild(s);
}
// cwSkeleton({cards, lines, bare}) → shimmer placeholder HTML. `bare:true` returns
// just the shimmer lines (no card wrapper) to sit INSIDE an existing card/box and
// reserve its height, so async sub-boxes swap content in place instead of jumping.
function cwSkeleton(opts) {
  __cwSkelCss();
  opts = opts || {};
  const cards = opts.cards || 3, lines = opts.lines || 3, widths = [58, 92, 74, 66, 84];
  const rows = (n) => { let ln = '<div class="cw-sk-line" style="width:45%;height:13px;"></div>'; for (let i = 1; i < n; i++) ln += '<div class="cw-sk-line" style="width:' + widths[i % widths.length] + '%;"></div>'; return ln; };
  if (opts.bare) return '<div class="cw-sk" role="status" aria-label="Loading">' + rows(lines) + "</div>";
  let out = "";
  for (let c = 0; c < cards; c++) out += '<div class="cw-sk-card">' + rows(lines) + "</div>";
  return '<div class="cw-sk" role="status" aria-label="Loading">' + out + "</div>";
}

// HTML-escape for text content AND double/single-quoted attribute values —
// textContent→innerHTML covers &<>, but quotes must go too or user data breaks
// out of value="…" attributes. (Never inline user data into onclick JS strings:
// attributes entity-decode before the JS runs, so only safe ids/keys go there.)
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

// Short local timestamp (en-SG): "5 Jul, 09:14".
function fmt(ts) { return ts ? new Date(ts).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""; }

// Expose the shared primitives on `window` explicitly. `esc`/`fmt` are function
// declarations (already global), but `code`/`api`/`post` are top-level `const` —
// which in a CLASSIC script bind to the module's lexical scope and are NOT set on
// `window`. The shared modules (notifications.js, tour.js) call `window.api`/
// `window.post`, so without this their server calls silently threw — breaking
// changelog-watermark AND tour-progress persistence. Pin them so `window.*` works.
window.code = code; window.api = api; window.post = post; window.esc = esc; window.fmt = fmt;
window.prefetch = prefetch; window.warmTabs = warmTabs;

// Network-failure state — a themed "Couldn't load — Retry" card to drop into a
// view container when a GET degrades (d.__neterr). Pass the retry callback (the
// renderer to re-run); the Retry button re-invokes it. Keeps a tab recoverable
// in place instead of blanking or dead-ending on "reopen the app".
let __retrySeq = 0; const __retries = {};
function cwLoadError(retry, msg) {
  const id = ++__retrySeq; if (typeof retry === "function") __retries[id] = retry;
  return '<div class="cw-neterr" style="text-align:center;padding:30px 18px;color:var(--muted);">'
    + '<div style="font-size:22px;margin-bottom:8px;opacity:.7;">⚠</div>'
    + '<div style="font-size:13.5px;line-height:1.4;margin-bottom:12px;">' + esc(msg || "Couldn’t load — check your connection.") + '</div>'
    + '<button type="button" onclick="cwDoRetry(' + id + ',this)" style="background:var(--primary-bg);color:var(--primary-fg);border:none;border-radius:9px;padding:9px 20px;font-size:13px;font-weight:600;cursor:pointer;">Retry</button></div>';
}
function cwDoRetry(id, btn) {
  const fn = __retries[id]; if (!fn) return;
  delete __retries[id];
  if (btn) { btn.disabled = true; btn.textContent = "Retrying…"; }
  try { fn(); } catch (e) {}
}
window.cwLoadError = cwLoadError; window.cwDoRetry = cwDoRetry;

// ---- Focus refresh (house system) ----
// Re-run the CURRENT tab's renderer when the app regains focus/visibility, so
// a tab left open overnight (or backgrounded on a phone) shows fresh data
// without a manual reload. Guard rails: throttled (default 90s), signed-in
// only, and NEVER while the user is mid-typing (an active input/textarea/
// select skips the refresh — re-rendering would clobber the form). Pages call
// cwTabRefresh(fn) once with a fn that re-renders only SAFE tabs (skip
// form-heavy routes).
function cwTabRefresh(fn, opts) {
  const minMs = (opts && opts.minMs) || 90000;
  let last = Date.now();
  const go = () => {
    if (!code()) return;
    if (Date.now() - last < minMs) return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    last = Date.now();
    try { fn(); } catch (e) {}
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) go(); });
  window.addEventListener("focus", go);
}
window.cwTabRefresh = cwTabRefresh;
