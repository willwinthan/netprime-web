/* Web Push handlers for Netprime LMS.
 * The PWA service worker (sw.js) should load this with: importScripts("/push-handler.js");
 * It can also be registered on its own when no other service worker exists (see src/components/communication/pushClient.ts).
 * Payload (JSON, encrypted by the server): { title, body, url?, tag? }
 */
self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: "Netprime LMS", body: event.data ? event.data.text() : "" }; }
  var title = data.title || "Netprime LMS";
  var url = typeof data.url === "string" && data.url.charAt(0) === "/" ? data.url : "/dashboard";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    data: { url: url },
    lang: "th"
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
    for (var i = 0; i < clients.length; i++) {
      var client = clients[i];
      if (new URL(client.url).origin === self.location.origin && "focus" in client) {
        client.navigate(url);
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});

