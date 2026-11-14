// Mochii service worker: only for nudges. No offline caching, so updates show up immediately.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const ICON = '/icons/icon-192.png';
const badge = (n) => self.navigator.setAppBadge?.(n)?.catch(() => {});

/** A plan question as a notification, with the card's own yes/no, so it can be answered right here. */
function showNudge(n) {
  return self.registration.showNotification(n.title, {
    body: n.body,
    icon: ICON,
    badge: ICON,
    tag: n.tag,
    data: { cardId: n.cardId },
    actions: [{ action: 'yes', title: n.yes }, { action: 'no', title: n.no }],
    requireInteraction: !!n.sticky,
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (data.cardId) {
    event.waitUntil(Promise.all([showNudge(data), badge(data.count)]));
    return;
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Mochii', {
      body: data.body || 'Mochii has something for you.',
      icon: ICON,
      badge: ICON,
      tag: data.tag || 'eden',
    }),
  );
});

// The open page asks for a nudge itself while it's in the background, so this works without push too.
self.addEventListener('message', (event) => {
  if (event.data?.nudge) event.waitUntil(showNudge(event.data.nudge));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { cardId } = event.notification.data || {};
  const tapped = event.action === 'yes' || event.action === 'no';
  event.waitUntil(cardId && tapped ? answerHere(cardId, event.action === 'yes') : openMochii());
});

/** Yes or No tapped on the notification: answer without opening Mochii, and pass on what Mochii says back. */
async function answerHere(cardId, yes) {
  try {
    const res = await fetch('/api/answer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cardId, yes }),
    });
    if (!res.ok) return openMochii(); // already answered, gone or signed out: show what's current instead
    const { reply, waiting } = await res.json();
    await badge(waiting?.length ?? 0);
    if (reply) await self.registration.showNotification('Mochii', { body: reply, icon: ICON, badge: ICON, tag: 'eden', silent: true });
  } catch {
    return openMochii();
  }
}

async function openMochii() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of windows) if ('focus' in w) return w.focus();
  return self.clients.openWindow('/');
}
