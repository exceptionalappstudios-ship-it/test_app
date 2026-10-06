// Service worker: shows Web Push notifications while the app is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'Meet Gurudev', body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Meet Gurudev', {
    body: data.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: data.url || '/#/appointments' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/#/appointments', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => new URL(w.url).pathname === '/');
    if (existing) {
      await existing.focus();
      return existing.navigate(url);
    }
    return self.clients.openWindow(url);
  })());
});
