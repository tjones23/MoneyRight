/*
 * MoneyRight's service worker. It does one thing: show sign-in requests
 * (and Settings' test message) pushed to this device, and open the link
 * when one is tapped. No caching, no offline pages — balances never sit in
 * a cache (see lib/security-headers.ts).
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" ? data.title : "MoneyRight";
  // Only links back into MoneyRight itself are ever opened.
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: true,
      requireInteraction: data.tag === "sign-in",
      icon: "/icon/small",
      badge: "/icon/small",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(self.clients.openWindow(url));
});
