// Eden server: run it on your laptop; phones on the same Wi-Fi open the printed https:// address.
//   node server/index.js          real rhythm (a couple of suggestions a day, 9:00–20:00)
//   node server/index.js --demo   fast rhythm for testing and pitching
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import QRCode from 'qrcode';

import * as clinician from './clinician.js';
import * as engine from './engine.js';
import { vapidPublicKey } from './push.js';
import { checkPassword, hashPassword, loadOrCreateCert, newToken } from './security.js';
import { db, log, resetDb, save } from './store.js';

engine.config.demo = process.argv.includes('--demo') || process.env.EDEN_DEMO === '1';
const PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const PUBLIC = path.resolve(import.meta.dirname, '..', 'public');

const lanIps = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

/* ------------------------------------------------------------------ helpers */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
const json = (res, status, data, extra) => send(res, status, JSON.stringify(data), 'application/json', extra);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

function sessionCookie(req, token, maxAge = 365 * 864e2) {
  const secure = req.socket.encrypted ? '; Secure' : '';
  return `eden=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function currentUser(req) {
  const token = cookies(req).eden;
  const s = token && db.sessions[token];
  return s ? db.users[s.userId] : null;
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

/* ------------------------------------------------------------ live stream */

const streams = new Map(); // userId -> Set<res>

engine.onChange((userId) => {
  const set = streams.get(userId);
  if (!set?.size) return;
  const state = engine.stateFor(userId);
  const data = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of set) res.write(data);
});

function openStream(req, res, user) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(engine.stateFor(user.id))}\n\n`);
  if (!streams.has(user.id)) streams.set(user.id, new Set());
  streams.get(user.id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
  req.on('close', () => {
    clearInterval(ping);
    streams.get(user.id)?.delete(res);
  });
}

/* --------------------------------------------------------------------- API */

const USERNAME = /^[a-z0-9_.-]{3,24}$/;

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'POST /api/signup') {
    const { name = '', username = '', password = '' } = await readJson(req);
    const n = String(name).trim().slice(0, 30);
    const un = String(username).trim().toLowerCase();
    if (!n) return json(res, 400, { error: 'What should Eden call you?' });
    if (!USERNAME.test(un)) return json(res, 400, { error: 'Username: 3–24 letters or numbers.' });
    if (String(password).length < 6) return json(res, 400, { error: 'Password: at least 6 characters.' });
    if (Object.values(db.users).some((u) => u.username === un)) return json(res, 409, { error: 'That username is taken.' });
    const user = engine.createUser({ name: n, username: un, pass: hashPassword(String(password)) });
    const token = newToken();
    db.sessions[token] = { userId: user.id, at: Date.now() };
    save();
    return json(res, 200, engine.stateFor(user.id), { 'set-cookie': sessionCookie(req, token) });
  }

  if (route === 'POST /api/login') {
    const { username = '', password = '' } = await readJson(req);
    const user = Object.values(db.users).find((u) => u.username === String(username).trim().toLowerCase());
    if (!user || !checkPassword(String(password), user.pass)) return json(res, 401, { error: "That didn't match. Try again?" });
    const token = newToken();
    db.sessions[token] = { userId: user.id, at: Date.now() };
    save();
    return json(res, 200, engine.stateFor(user.id), { 'set-cookie': sessionCookie(req, token) });
  }

  if (route === 'GET /api/info') {
    return json(res, 200, { people: Object.keys(db.users).length, demo: engine.config.demo, vapidPublicKey });
  }

  /* ---- host dashboard and care-team view (only from the host computer) ---- */
  if (url.pathname.startsWith('/api/admin/')) {
    if (!isLocal(req)) return json(res, 403, { error: 'Host only' });
    return adminApi(req, res, url);
  }
  if (url.pathname.startsWith('/api/clinician/')) {
    if (!isLocal(req)) return json(res, 403, { error: 'Host only' });
    if (route === 'GET /api/clinician/state') return json(res, 200, clinician.overview());
    if (route === 'POST /api/clinician/summary') {
      const { userId } = await readJson(req);
      const r = await clinician.aiSummary(String(userId));
      return json(res, r.error ? 400 : 200, r);
    }
    return json(res, 404, { error: 'Not found' });
  }

  /* ---- everything below needs an account ---- */
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'Not signed in' });

  switch (route) {
    case 'GET /api/state':
      return json(res, 200, engine.stateFor(user.id));
    case 'GET /api/stream':
      return openStream(req, res, user);
    case 'POST /api/answer': {
      const { cardId, yes, value } = await readJson(req);
      const done = engine.answer(user.id, String(cardId), !!yes, typeof value === 'number' ? value : undefined);
      return json(res, done ? 200 : 409, { ...engine.stateFor(user.id), reply: done?.reply ?? null });
    }
    case 'POST /api/location': {
      const { lat, lon, acc } = await readJson(req);
      engine.updateLocation(user.id, { lat: Number(lat), lon: Number(lon), acc: Number(acc) });
      return json(res, 200, { ok: true });
    }
    case 'POST /api/caps': {
      const body = await readJson(req);
      const caps = {};
      if ('push' in body) caps.push = !!body.push;
      if ('standalone' in body) caps.standalone = !!body.standalone;
      if ('geo' in body) caps.geo = String(body.geo).slice(0, 20);
      engine.setCaps(user.id, caps);
      return json(res, 200, { ok: true });
    }
    case 'POST /api/push': {
      const { subscription } = await readJson(req);
      user.push = subscription && subscription.endpoint ? subscription : null;
      save();
      return json(res, 200, engine.stateFor(user.id));
    }
    case 'POST /api/checkins': {
      const { on, share, start } = await readJson(req);
      engine.setSurveys(user.id, { on: typeof on === 'boolean' ? on : null, share: typeof share === 'boolean' ? share : null, start: start === true });
      return json(res, 200, engine.stateFor(user.id));
    }
    case 'POST /api/pause': {
      const { days } = await readJson(req);
      engine.setPause(user.id, Math.max(0, Math.min(30, Number(days) || 0)));
      return json(res, 200, engine.stateFor(user.id));
    }
    case 'POST /api/logout': {
      delete db.sessions[cookies(req).eden];
      save();
      return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
    }
    case 'POST /api/delete-account': {
      engine.removeUser(user.id);
      return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
    }
    default:
      return json(res, 404, { error: 'Not found' });
  }
}

async function adminApi(req, res, url) {
  const action = url.pathname.slice('/api/admin/'.length);
  if (req.method === 'GET' && action === 'state') return json(res, 200, { ...engine.adminState(), urls: phoneUrls() });
  if (req.method === 'GET' && action === 'qr') {
    const svg = await QRCode.toString(url.searchParams.get('u') || phoneUrls()[0] || '', { type: 'svg', margin: 1 });
    return send(res, 200, svg, 'image/svg+xml');
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const body = await readJson(req);
  switch (action) {
    case 'propose':
      await engine.admin.propose(body.userId);
      break;
    case 'remind':
      engine.admin.remind(body.planId);
      break;
    case 'meet':
      engine.admin.meet(body.planId);
      break;
    case 'end':
      engine.admin.end(body.planId);
      break;
    case 'cancel':
      engine.admin.cancel(body.planId);
      break;
    case 'quiet':
      engine.admin.quiet(body.userId, body.on);
      break;
    case 'place':
      engine.admin.place();
      break;
    case 'survey':
      engine.admin.survey(body.userId);
      break;
    case 'sample':
      engine.admin.sample(body.userId, body.trend);
      break;
    case 'remove':
      engine.admin.remove(body.userId);
      break;
    case 'demo':
      engine.setDemo(body.on);
      log(`Demo rhythm ${body.on ? 'on' : 'off'}`);
      break;
    case 'reset':
      resetDb();
      log('Everything was reset');
      break;
    default:
      return json(res, 404, { error: 'Unknown action' });
  }
  return json(res, 200, { ...engine.adminState(), urls: phoneUrls() });
}

/* ------------------------------------------------------------------ static */

function serveStatic(req, res, pathname) {
  if (pathname === '/admin' || pathname === '/clinician') {
    if (!isLocal(req)) return send(res, 403, 'This page only opens on the host computer.');
    pathname = `${pathname}.html`;
  }
  if ((pathname === '/admin.html' || pathname === '/clinician.html') && !isLocal(req)) return send(res, 403, 'This page only opens on the host computer.');
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      // Single-page app: unknown paths get the app.
      if (!path.extname(file)) return serveStatic(req, res, '/index.html');
      return send(res, 404, 'Not found');
    }
    const extra = pathname === '/sw.js' ? { 'service-worker-allowed': '/' } : {};
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream', extra);
  });
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://eden.local');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong' });
  }
}

/* ------------------------------------------------------------------- start */

function phoneUrls() {
  return lanIps().map((ip) => `https://${ip}:${HTTPS_PORT}`);
}

const cert = await loadOrCreateCert(lanIps());
http.createServer(handle).listen(PORT, '0.0.0.0');
https.createServer({ key: cert.key, cert: cert.cert }, handle).listen(HTTPS_PORT, '0.0.0.0');
engine.start();

const urls = phoneUrls();
console.log(`\n  🌿 Eden is running${engine.config.demo ? ' (demo rhythm: fast suggestions)' : ''}\n`);
if (urls[0]) {
  console.log(await QRCode.toString(urls[0], { type: 'terminal', small: true }));
  console.log('  Phones on the same Wi-Fi, open:');
  for (const u of urls) console.log(`    ${u}`);
  console.log('  (First time: tap "Show Details" → "visit this website". It\'s your own laptop.)\n');
}
console.log(`  Host dashboard (this computer only): http://localhost:${PORT}/admin`);
console.log(`  Care-team view (this computer only): http://localhost:${PORT}/clinician${clinician.aiReady() ? '' : '  (AI summaries: set ANTHROPIC_API_KEY)'}`);
console.log(`  On this computer:                    http://localhost:${PORT}\n`);
