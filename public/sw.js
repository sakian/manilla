/*
 * Manilla's service worker: it shows the notifications the server sends
 * (src/push/push.ts), and nothing else. No caching, no offline copy - a ledger
 * read from a stale cache is a wrong ledger.
 *
 * The browser wakes this when a push arrives, whether or not Manilla is open.
 */

self.addEventListener('push', (event) => {
  let message;
  try {
    message = event.data.json();
  } catch {
    message = { title: 'Manilla', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(message.title || 'Manilla', {
      body: message.body || '',
      icon: '/icon-192.png',
      // A newer one of the same kind replaces the last, and still sounds.
      tag: message.tag,
      renotify: Boolean(message.tag),
      data: { url: message.url || '/' },
    }),
  );
});

// A tap opens the page it is about: in a Manilla window already open if there
// is one, rather than a second copy of the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin);
  // Only ever Manilla's own pages, whatever the message said.
  const target = url.origin === self.location.origin ? url.href : self.location.origin + '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        try {
          // Refused for a window opened before this worker was, hence the fallback.
          await open.navigate(target);
          return open.focus();
        } catch {
          // Falls through to a new window.
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
