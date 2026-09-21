// Shared app-refresh + update check, used by all three surfaces (soldier app,
// command console, admin console). Loaded as a classic script. It references the
// page's own globals route() and code() at runtime.
//
// Two ways a new deploy reaches an open tab:
//  • Pull-to-refresh (touch): a firm pull from the top refreshes the current tab's
//    data AND, if a newer build is live, reloads to swap in the new app.
//  • Desktop / no-touch: the tab re-checks the version when it regains focus or
//    visibility (and periodically), and offers a tap-to-update toast instead of a
//    silent reload (which would discard unsaved form input).
// The baseline version tag (the page asset's ETag, else Last-Modified) is captured
// once at load; a different tag on a later check means a new build is out.

let __appVer = null, __appVerReady = false;
async function appVerTag() {
  try { const r = await fetch(location.pathname + "?_v=" + Date.now(), { method: "HEAD", cache: "no-store" });
    return r.headers.get("etag") || r.headers.get("last-modified") || null; } catch { return null; }
}
appVerTag().then((t) => { __appVer = t; __appVerReady = true; });
async function pullRefresh() {
  const [fresh] = await Promise.all([
    (async () => { if (!__appVerReady || !__appVer) return false; const now = await appVerTag(); return !!(now && now !== __appVer); })(),
    Promise.resolve(route()),   // refresh the current tab's data in parallel
  ]);
  if (fresh) location.reload();   // a new build is live → swap in the new app
}
(function () {
  const THRESH = 95, DEADZONE = 22, MAXPULL = 150, DWELL = 200;   // must hold past THRESH for DWELL ms to arm
  let startY = 0, startX = 0, active = false, decided = false, pulling = false, ready = false, busy = false, holdTimer = null, ptr, disc;
  function make() { ptr = document.createElement("div"); ptr.id = "ptr"; disc = document.createElement("div"); disc.className = "disc"; disc.textContent = "↓"; ptr.appendChild(disc); document.body.appendChild(ptr); }
  // The scroll region is the app-shell .wrap (an in-flow flex column); fall back
  // to the document scroller for any surface not yet on the shell.
  function scroller() { return document.querySelector(".wrap") || document.scrollingElement || document.documentElement; }
  function atTop() { const s = scroller(); return ((s && s.scrollTop) || window.scrollY || 0) <= 0; }
  function place(px, op) { if (ptr) { ptr.style.top = px + "px"; ptr.style.opacity = op; } }
  function clearHold() { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } }
  function reset() { clearHold(); place(-46, 0); pulling = false; ready = false; }
  function endGesture() { clearHold(); active = false; decided = false; pulling = false; }
  window.addEventListener("touchstart", (e) => {
    endGesture();
    if (busy || e.touches.length !== 1 || !atTop() || !code()) return;
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; active = true;
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (!active || busy) return;
    const dy = e.touches[0].clientY - startY, dx = e.touches[0].clientX - startX;
    if (!decided) {
      if (Math.abs(dy) < DEADZONE && Math.abs(dx) < DEADZONE) return;   // wait for a clear movement
      decided = true;
      pulling = dy > 0 && dy > Math.abs(dx) * 1.5 && atTop();           // firm downward, mostly vertical, at the top
      if (!pulling) { active = false; return; }                        // scroll / side-swipe → hands off entirely
      if (!ptr) make();
    }
    if (!pulling) return;
    if (dy <= 0 || !atTop()) { endGesture(); reset(); return; }
    const pull = Math.min(dy, MAXPULL);
    place(Math.min(pull * 0.5, 72) - 46, Math.min(1, pull / THRESH));
    if (pull >= THRESH) {                                               // far enough — start (or keep) the hold timer
      if (!ready && !holdTimer) holdTimer = setTimeout(() => {          // only a sustained hold past the line arms it
        ready = true; holdTimer = null; if (disc) disc.textContent = "↻"; place(22, 1);
      }, DWELL);
      if (!ready && disc) disc.textContent = "↓";                       // still just a pull until the dwell completes
    } else {
      clearHold(); ready = false; if (disc) disc.textContent = "↓";     // fell back below the line — disarm
    }
  }, { passive: true });
  window.addEventListener("touchend", async () => {
    if (!pulling) { endGesture(); return; }
    const go = ready && !busy;
    endGesture();
    if (!go) { reset(); return; }
    busy = true; disc.textContent = ""; disc.classList.add("spin"); place(20, 1);
    const t0 = Date.now();
    try { const r = pullRefresh(); if (r && typeof r.then === "function") await r; } catch {}
    const wait = 450 - (Date.now() - t0); if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    disc.classList.remove("spin"); disc.textContent = "↓"; reset(); busy = false;
  });
})();

(function () {
  let checking = false, lastCheck = 0, shown = false;
  function showUpdateToast() {
    if (shown) return; shown = true;
    const t = document.createElement("div");
    t.id = "update-toast"; t.setAttribute("role", "status");
    t.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 80px);z-index:9999;background:var(--accent,#c9922f);color:#151515;font-weight:600;font-size:13.5px;padding:10px 16px;border-radius:22px;box-shadow:0 6px 20px rgba(0,0,0,.3);cursor:pointer;max-width:90vw;";
    t.textContent = "New version available — tap to update";
    t.onclick = () => location.reload();
    document.body.appendChild(t);
  }
  async function checkVersion() {
    if (shown || checking || !__appVerReady || !__appVer) return;
    if (Date.now() - lastCheck < 30000) return;
    lastCheck = Date.now(); checking = true;
    try { const now = await appVerTag(); if (now && now !== __appVer) showUpdateToast(); } catch {} finally { checking = false; }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
  window.addEventListener("focus", checkVersion);
  setInterval(checkVersion, 5 * 60 * 1000);
})();
