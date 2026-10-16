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
          // Focus first. A window may only come forward while the tap is still
          // fresh, and loading the page first used it up on Android: the page
          // changed behind the other apps and the tap seemed to do nothing.
          const focused = await open.focus();
          // Refused for a window opened before this worker was, hence the fallback.
          await focused.navigate(target);
          return;
        } catch {
          // Falls through to a new window.
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// Nothing is cached, so a new version can take over at once rather than
// waiting for every Manilla window to close - which on a phone, where the app
// is rarely closed, could mean an old tap handler for weeks.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
