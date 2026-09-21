// Theme switching, shared by all three surfaces.
//
// The OPTIONS are fixed and identical across the app family — Automatic, Light,
// Dark, and the app's brand theme. What is per-surface is the CHOICE: each page
// passes its own storage key, because an installed PWA gets its own storage and
// a handler's console remembering the customer app's theme would be surprising.
//
// The page itself must ALSO carry a tiny inline copy of `apply` in <head>,
// before any paint — a theme applied from here, after this file loads, arrives
// one frame late and shows as a white flash on a dark phone.

(function () {
  const THEMES = [
    { key: "charge", label: "Charge" },
    { key: "auto",   label: "Automatic" },
    { key: "light",  label: "Light" },
    { key: "dark",   label: "Dark" },
  ];
  const VALID = new Set(THEMES.map(t => t.key));
  let STORE = "cw_theme";

  function resolve(name) {
    if (name === "auto") return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    return VALID.has(name) ? name : "charge";
  }

  function apply(name) {
    document.documentElement.setAttribute("data-theme", resolve(name));
    // Keep the OS status bar in step with the appbar, which is dark in every
    // theme — a light status bar over a dark appbar looks broken on iOS.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--appbar-bg").trim() || "#0a0f13");
  }

  function get() {
    try { const v = localStorage.getItem(STORE); return VALID.has(v) ? v : "charge"; } catch (e) { return "charge"; }
  }

  function set(name) {
    if (!VALID.has(name)) return;
    try { localStorage.setItem(STORE, name); } catch (e) {}
    apply(name);
  }

  // Re-resolve when the OS flips light/dark, but only while "Automatic".
  try {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (get() === "auto") apply("auto"); });
  } catch (e) {}

  window.cwTheme = {
    init(storeKey) { if (storeKey) STORE = storeKey; apply(get()); },
    get, set, apply, themes: THEMES,
    // The chip row for a Settings card. The page re-renders after a change so
    // the selection moves with it.
    pickerHTML() {
      const cur = get();
      return '<div class="chips">' + THEMES.map(t =>
        `<button type="button" class="chip${t.key === cur ? " on" : ""}" onclick="cwTheme.set('${t.key}');cwThemeChanged&&cwThemeChanged();">${t.label}</button>`
      ).join("") + "</div>";
    },
  };
})();
