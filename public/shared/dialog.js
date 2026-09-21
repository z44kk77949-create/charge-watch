// Shared themed dialogs — replaces native alert()/confirm() across all three
// surfaces (soldier, console, admin). Native dialogs freeze the thread, show the
// bare domain, and ignore the app theme; these are non-blocking, theme-token
// styled, and reduced-motion aware.
//
//   cwToast(msg, opts?)   -> shows a transient message. Returns undefined so
//                             `return cwToast(...)` mirrors `return alert(...)`.
//        opts: { type:'info'|'ok'|'err' (default 'info'), dur:ms (0 = sticky),
//                title?:string }
//   cwConfirm(msg, opts?) -> Promise<boolean> (true = confirmed).
//        opts: { title?, ok?:'OK', cancel?:'Cancel', danger?:bool }
//
// Loaded right after core.js on every surface (esc() lives there); guards so a
// double-include is harmless.
(function () {
  if (window.cwToast && window.cwConfirm) return;
  var esc = window.esc || function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  var STYLE_ID = "cw-dialog-css";
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = [
      "#cw-toasts{position:fixed;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 76px);z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 14px;pointer-events:none}",
      ".cw-toast{pointer-events:auto;max-width:440px;width:100%;background:var(--surface,#fff);color:var(--text,#1a1a18);border:1px solid var(--border,#e2e0d8);border-left:4px solid var(--muted,#888);border-radius:12px;box-shadow:var(--shadow,0 4px 14px rgba(0,0,0,.18));padding:11px 13px;font:500 14px/1.35 -apple-system,'Segoe UI',Roboto,sans-serif;display:flex;gap:10px;align-items:flex-start;opacity:0;transform:translateY(10px);transition:opacity .22s ease,transform .22s ease}",
      ".cw-toast.in{opacity:1;transform:none}",
      ".cw-toast.ok{border-left-color:var(--ok,#3b6d11)}",
      ".cw-toast.err{border-left-color:var(--err,#a32d2d)}",
      ".cw-toast .cw-tmark{flex:none;width:18px;height:18px;margin-top:1px;font-size:13px;line-height:18px;text-align:center;font-weight:700}",
      ".cw-toast.ok .cw-tmark{color:var(--ok,#3b6d11)}",
      ".cw-toast.err .cw-tmark{color:var(--err,#a32d2d)}",
      ".cw-toast.info .cw-tmark{color:var(--accent,#185fa5)}",
      ".cw-toast .cw-tbody{flex:1;min-width:0;word-wrap:break-word;overflow-wrap:anywhere}",
      ".cw-toast .cw-ttitle{font-weight:700;margin-bottom:2px}",
      "#cw-modal{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.5);opacity:0;transition:opacity .2s ease}",
      "#cw-modal.in{opacity:1}",
      "#cw-modal .cw-card{width:100%;max-width:400px;background:var(--surface,#fff);color:var(--text,#1a1a18);border:1px solid var(--border,#e2e0d8);border-radius:16px;box-shadow:var(--shadow,0 12px 40px rgba(0,0,0,.35));padding:18px 18px 16px;transform:translateY(12px) scale(.98);transition:transform .2s ease}",
      "#cw-modal.in .cw-card{transform:none}",
      "#cw-modal .cw-mtitle{font:700 16px/1.3 -apple-system,'Segoe UI',Roboto,sans-serif;margin-bottom:6px}",
      "#cw-modal .cw-mmsg{font:400 14px/1.45 -apple-system,'Segoe UI',Roboto,sans-serif;color:var(--text,#1a1a18);white-space:pre-wrap;word-wrap:break-word}",
      "#cw-modal .cw-mbtns{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}",
      "#cw-modal button{font:600 14px/1 -apple-system,'Segoe UI',Roboto,sans-serif;padding:11px 16px;border-radius:10px;border:1px solid var(--border-strong,#d5d3c9);cursor:pointer;min-width:84px}",
      "#cw-modal .cw-cancel{background:var(--surface-2,#f2f1ec);color:var(--text,#1a1a18)}",
      "#cw-modal .cw-ok{background:var(--primary-bg,#1a1a18);color:var(--primary-fg,#fff);border-color:transparent}",
      "#cw-modal .cw-ok.danger{background:var(--err,#a32d2d);color:#fff}",
      "#cw-modal button:focus-visible,.cw-toast:focus-visible{outline:2px solid var(--accent,#185fa5);outline-offset:2px}",
      "@media (prefers-reduced-motion: reduce){.cw-toast,#cw-modal,#cw-modal .cw-card{transition:none!important;transform:none!important}}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(s);
  }

  var MARK = { ok: "✓", err: "!", info: "ℹ" };

  function toastHost() {
    ensureStyle();
    var host = document.getElementById("cw-toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "cw-toasts";
      host.setAttribute("aria-live", "polite");
      host.setAttribute("role", "status");
      document.body.appendChild(host);
    }
    return host;
  }

  window.cwToast = function (msg, opts) {
    opts = opts || {};
    var host = toastHost();
    var type = opts.type === "ok" || opts.type === "err" ? opts.type : "info";
    var el = document.createElement("div");
    el.className = "cw-toast " + type;
    el.setAttribute("role", type === "err" ? "alert" : "status");
    el.innerHTML =
      '<span class="cw-tmark" aria-hidden="true">' + MARK[type] + "</span>" +
      '<div class="cw-tbody">' +
      (opts.title ? '<div class="cw-ttitle">' + esc(opts.title) + "</div>" : "") +
      '<div class="cw-tmsg">' + esc(msg) + "</div></div>";
    host.appendChild(el);
    // force reflow so the transition runs
    void el.offsetWidth;
    el.classList.add("in");
    var dur = opts.dur == null ? (type === "err" ? 4200 : 3200) : opts.dur;
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      el.classList.remove("in");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
    }
    el.addEventListener("click", close);
    if (dur > 0) setTimeout(close, dur);
    return undefined;
  };

  window.cwConfirm = function (msg, opts) {
    opts = opts || {};
    ensureStyle();
    return new Promise(function (resolve) {
      var prev = document.activeElement;
      var wrap = document.createElement("div");
      wrap.id = "cw-modal";
      wrap.innerHTML =
        '<div class="cw-card" role="alertdialog" aria-modal="true"' +
        (opts.title ? ' aria-label="' + esc(opts.title) + '"' : "") + ">" +
        (opts.title ? '<div class="cw-mtitle">' + esc(opts.title) + "</div>" : "") +
        '<div class="cw-mmsg">' + esc(msg) + "</div>" +
        '<div class="cw-mbtns">' +
        '<button type="button" class="cw-cancel">' + esc(opts.cancel || "Cancel") + "</button>" +
        '<button type="button" class="cw-ok' + (opts.danger ? " danger" : "") + '">' + esc(opts.ok || "OK") + "</button>" +
        "</div></div>";
      document.body.appendChild(wrap);
      var okBtn = wrap.querySelector(".cw-ok");
      var cancelBtn = wrap.querySelector(".cw-cancel");
      var done = false;
      function finish(val) {
        if (done) return;
        done = true;
        wrap.classList.remove("in");
        document.removeEventListener("keydown", onKey, true);
        setTimeout(function () {
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          try { if (prev && prev.focus) prev.focus(); } catch (e) {}
        }, 200);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
        else if (e.key === "Enter") { e.preventDefault(); finish(true); }
      }
      okBtn.addEventListener("click", function () { finish(true); });
      cancelBtn.addEventListener("click", function () { finish(false); });
      wrap.addEventListener("click", function (e) { if (e.target === wrap) finish(false); });
      document.addEventListener("keydown", onKey, true);
      void wrap.offsetWidth;
      wrap.classList.add("in");
      // Focus the safe choice for destructive prompts, else the primary action.
      try { (opts.danger ? cancelBtn : okBtn).focus(); } catch (e) {}
    });
  };

  // Offline awareness: a persistent bar while the device is offline (the app keeps
  // showing cached data, but writes won't reach the server), and a brief "back
  // online" toast on reconnect. Reuses the toast host/styling; kept as its own
  // element so it persists until connectivity returns.
  var OFFLINE_ID = "cw-offline-bar";
  function showOffline() {
    if (document.getElementById(OFFLINE_ID)) return;
    var el = document.createElement("div");
    el.id = OFFLINE_ID;
    el.className = "cw-toast err in";
    el.setAttribute("role", "status");
    el.innerHTML = '<span class="cw-tmark" aria-hidden="true">!</span><div class="cw-tbody"><div class="cw-ttitle">You’re offline</div><div class="cw-tmsg">Showing saved data — changes won’t send until you reconnect.</div></div>';
    toastHost().appendChild(el);
  }
  function hideOffline() {
    var el = document.getElementById(OFFLINE_ID);
    if (!el) return;
    el.classList.remove("in");
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
    window.cwToast("Back online.", { type: "ok", dur: 2200 });
  }
  window.addEventListener("offline", showOffline);
  window.addEventListener("online", hideOffline);
  try { if (navigator && navigator.onLine === false) showOffline(); } catch (e) {}
})();
