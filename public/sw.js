// Service worker: push notifications and install, nothing else.
//
// Deliberately NO fetch caching. The only cache layer in play is the HTTP one
// configured in public/_headers, which revalidates the app shell on every load
// — a service worker cache on top of that is how a tent ends up running last
// week's build with no way to clear it mid-event.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
self.addEventListener("fetch", () => {});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (err) { d = { title: "Charge Watch", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Charge Watch", {
    body: d.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: d.tag || undefined,
    // A charger being ready is worth a buzz — it is the whole reason someone
    // installed this.
    vibrate: [90, 60, 90],
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ("focus" in c) { try { c.navigate(url); } catch (err) {} return c.focus(); } }
    return clients.openWindow(url);
  }));
});
