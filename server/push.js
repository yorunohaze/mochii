// Optional Web Push, so Eden can reach people when the app is closed.
// Works when the page is served over *trusted* HTTPS (e.g. a tunnel) and, on iPhone,
// when Eden is added to the Home Screen (iOS 16.4+).
import fs from 'node:fs';
import path from 'node:path';

import webpush from 'web-push';

import { DATA_DIR, save } from './store.js';

const file = path.join(DATA_DIR, 'vapid.json');
let keys;
try {
  keys = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys));
}

webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:eden-host@example.com', keys.publicKey, keys.privateKey);

export const vapidPublicKey = keys.publicKey;

export async function notify(user, payload, { ttl = 3 * 3600, urgency = 'normal' } = {}) {
  if (!user?.push) return;
  try {
    await webpush.sendNotification(user.push, JSON.stringify(payload), { TTL: Math.max(60, Math.round(ttl)), urgency });
  } catch (e) {
    if (e?.statusCode === 404 || e?.statusCode === 410) {
      user.push = null; // subscription gone
      save();
    }
  }
}
