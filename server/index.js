// Mochii server: one shared server for everyone. People sign up, start friend groups and invite each other with codes.
//   node server/index.js          real rhythm (a couple of suggestions a day, 9:00–20:00)
//   node server/index.js --demo   fast rhythm for testing and pitching
//
// On a public server, put it behind a reverse proxy that terminates HTTPS (Caddy, nginx, a PaaS) and set:
//   PUBLIC_URL=https://mochii.example   TRUST_PROXY=1   HTTPS_PORT=0   EDEN_ADMIN_TOKEN=<long random secret>
// Without a proxy (local Wi-Fi testing) it also serves a self-signed HTTPS port so phones can use GPS.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import QRCode from 'qrcode';

import * as circles from './circles.js';
import * as clinician from './clinician.js';
import * as engine from './engine.js';
import { vapidPublicKey } from './push.js';
import { checkPassword, hashPassword, loadOrCreateCert, newToken } from './security.js';
import { db, log, resetDb, save } from './store.js';

engine.config.demo = process.argv.includes('--demo') || process.env.EDEN_DEMO === '1';
const PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 3443); // 0 = off (behind a proxy that does HTTPS)
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ADMIN_TOKEN = process.env.EDEN_ADMIN_TOKEN || '';
const SESSION_DAYS = 60;
const PUBLIC = path.resolve(import.meta.dirname, '..', 'public');
// The map library is served straight from node_modules (pinned in package.json), so phones never need a CDN.
const MAPLIBRE = path.resolve(import.meta.dirname, '..', 'node_modules', 'maplibre-gl', 'dist');

const lanIps = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

/* ------------------------------------------------------------------ helpers */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra });
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

/** HTTPS as the browser sees it: directly, or through a trusted reverse proxy. */
const isSecure = (req) => req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

function sessionCookie(req, token, maxAge = SESSION_DAYS * 864e2) {
  return `eden=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
}

/** The real client address. Forwarding headers are only believed when TRUST_PROXY=1 (they're trivial to fake otherwise). */
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

const FORWARDED = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-forwarded-host'];

/**
 * A request typed on this very computer: loopback AND not relayed by a tunnel or proxy. Tunnels (cloudflared, ngrok)
 * connect from 127.0.0.1 too, so loopback alone would let the whole internet in.
 */
const isTrulyLocal = (req) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !FORWARDED.some((h) => req.headers[h]);

function startSession(req, userId) {
  const token = newToken();
  db.sessions[token] = { userId, at: Date.now(), seen: Date.now() };
  save();
  return sessionCookie(req, token);
}

function currentUser(req) {
  const token = cookies(req).eden;
  const s = token && db.sessions[token];
  if (!s) return null;
  const now = Date.now();
  if (now - (s.seen ?? s.at) > SESSION_DAYS * 864e5) {
    delete db.sessions[token];
    save();
    return null;
  }
  if (now - (s.seen ?? 0) > 3600e3) {
    s.seen = now; // sliding expiry, written at most hourly
    save();
  }
  return db.users[s.userId] ?? null;
}

/* ------------------------------------------------------------- rate limits */

const buckets = new Map(); // key -> { n, reset }
function limited(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  b.n += 1;
  return b.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 10 * 60e3).unref();
const tooMany = (res) => json(res, 429, { error: 'Too many tries. Take a breath and try again in a little while.' });

/* ---------------------------------------------------------- operator access */

function tokenMatches(given) {
  if (!ADMIN_TOKEN || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function adminOk(req) {
  if (!ADMIN_TOKEN) return isTrulyLocal(req); // no token set: only from the server's own keyboard
  return tokenMatches(req.headers['x-admin-token'] || cookies(req).eden_admin);
}

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
  // Recompute time-sensitive visibility even when nobody taps or moves: stale positions disappear.
  const ping = setInterval(() => {
    const state = engine.stateFor(user.id);
    if (state) res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  }, 25e3);
  req.on('close', () => {
    clearInterval(ping);
    streams.get(user.id)?.delete(res);
  });
}

/* --------------------------------------------------------------------- API */

const USERNAME = /^[a-z0-9_.-]{3,24}$/;

/** After signing up or logging in with an invite code: join that group straight away. */
function joinAfterAuth(user, code) {
  if (!code) return null;
  const r = circles.joinByCode(user.id, code);
  if (r.group) afterJoin(user.id, r.group);
  return r.error ?? null;
}

function afterJoin(userId, group) {
  save();
  if (group.kind === 'care') engine.joinedCareTeam(userId);
  engine.groupChanged(Object.keys(group.members));
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = clientIp(req);

  if (route === 'POST /api/signup') {
    if (limited(`signup:${ip}`, 20, 3600e3)) return tooMany(res);
    const { name = '', username = '', password = '', code = '' } = await readJson(req);
    const n = String(name).trim().slice(0, 30);
    const un = String(username).trim().toLowerCase();
    if (!n) return json(res, 400, { error: 'What should Mochii call you?' });
    if (!USERNAME.test(un)) return json(res, 400, { error: 'Username: 3–24 letters or numbers.' });
    if (String(password).length < 8) return json(res, 400, { error: 'Password: at least 8 characters.' });
    if (Object.values(db.users).some((u) => u.username === un)) return json(res, 409, { error: 'That username is taken.' });
    const user = engine.createUser({ name: n, username: un, pass: hashPassword(String(password)) });
    const cookie = startSession(req, user.id);
    const joinError = joinAfterAuth(user, code);
    return json(res, 200, { ...engine.stateFor(user.id), joinError }, { 'set-cookie': cookie });
  }

  if (route === 'POST /api/login') {
    const { username = '', password = '', code = '' } = await readJson(req);
    const un = String(username).trim().toLowerCase();
    if (limited(`login:${ip}`, 30, 15 * 60e3) || limited(`login-user:${un}`, 10, 15 * 60e3)) return tooMany(res);
    const user = Object.values(db.users).find((u) => u.username === un);
    if (!user || !checkPassword(String(password), user.pass)) return json(res, 401, { error: "That didn't match. Try again?" });
    const cookie = startSession(req, user.id);
    const joinError = joinAfterAuth(user, code);
    return json(res, 200, { ...engine.stateFor(user.id), joinError }, { 'set-cookie': cookie });
  }

  if (route === 'GET /api/info') {
    // inviteBase: the address friends should open (the public URL, or this machine's Wi-Fi address when testing locally).
    return json(res, 200, { demo: engine.config.demo, vapidPublicKey, publicUrl: PUBLIC_URL || null, inviteBase: phoneUrls()[0] || null });
  }

  // "You're invited to …" before signing up. Rate-limited so codes can't be guessed.
  const invite = url.pathname.match(/^\/api\/invite\/([A-Za-z0-9-]{4,20})$/);
  if (req.method === 'GET' && invite) {
    if (limited(`invite:${ip}`, 30, 3600e3)) return tooMany(res);
    const preview = circles.invitePreview(invite[1]);
    return preview ? json(res, 200, preview) : json(res, 404, { error: "That code didn't match a group." });
  }

  /* ---- operator dashboard: EDEN_ADMIN_TOKEN, or this computer's own keyboard ---- */
  if (url.pathname.startsWith('/api/admin/')) {
    if (url.pathname === '/api/admin/login' && req.method === 'POST') {
      if (limited(`admin:${ip}`, 10, 15 * 60e3)) return tooMany(res);
      const { token = '' } = await readJson(req);
      if (!tokenMatches(token)) return json(res, 401, { error: ADMIN_TOKEN ? 'Wrong operator token.' : 'No operator token is set on this server.' });
      return json(res, 200, { ok: true }, { 'set-cookie': `eden_admin=${encodeURIComponent(String(token))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${isSecure(req) ? '; Secure' : ''}` });
    }
    if (!adminOk(req)) return json(res, 403, { error: ADMIN_TOKEN ? 'Operator token needed.' : 'Operator only. Set EDEN_ADMIN_TOKEN to manage this server remotely.', needsToken: !!ADMIN_TOKEN });
    return adminApi(req, res, url);
  }

  /* ---- everything below needs an account ---- */
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'Not signed in' });

  /* ---- care-team view: clinician accounts, only their own patients ---- */
  if (url.pathname.startsWith('/api/clinician/')) {
    if (!user.clinician) return json(res, 403, { error: 'This is for clinician accounts. Ask the server operator to set one up.' });
    if (route === 'GET /api/clinician/state') return json(res, 200, clinician.overview(user.id));
    if (route === 'POST /api/clinician/team') {
      const { name } = await readJson(req);
      const r = circles.createGroup(user.id, name, 'care');
      if (r.error) return json(res, 400, r);
      save();
      return json(res, 200, clinician.overview(user.id));
    }
    if (route === 'POST /api/clinician/summary') {
      const { userId } = await readJson(req);
      const r = await clinician.aiSummary(String(userId), user.id);
      return json(res, r.error ? 400 : 200, r);
    }
    return json(res, 404, { error: 'Not found' });
  }

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
      if (limited(`loc:${user.id}`, 120, 60e3)) return tooMany(res);
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
    case 'POST /api/map': {
      const { showArea } = await readJson(req);
      if (typeof showArea === 'boolean') engine.setShowArea(user.id, showArea);
      return json(res, 200, engine.stateFor(user.id));
    }
    case 'POST /api/mood': {
      const { mood } = await readJson(req);
      if (!engine.setMood(user.id, mood)) return json(res, 400, { error: 'Choose a weather mood, or clear it.' });
      return json(res, 200, engine.stateFor(user.id));
    }
    case 'POST /api/availability': {
      const body = await readJson(req);
      if (!engine.setAvailability(user.id, body)) return json(res, 400, { error: 'Choose a valid time zone and a week of 30-minute time blocks.' });
      return json(res, 200, engine.stateFor(user.id));
    }
    case 'POST /api/pause': {
      const { days } = await readJson(req);
      engine.setPause(user.id, Math.max(0, Math.min(30, Number(days) || 0)));
      return json(res, 200, engine.stateFor(user.id));
    }

    /* ---- friend groups ---- */
    case 'POST /api/groups': {
      if (limited(`group-new:${user.id}`, 10, 3600e3)) return tooMany(res);
      const { name } = await readJson(req);
      const r = circles.createGroup(user.id, name, 'friends');
      if (r.error) return json(res, 400, r);
      afterJoin(user.id, r.group);
      return json(res, 200, { ...engine.stateFor(user.id), groupId: r.group.id });
    }
    case 'POST /api/groups/join': {
      if (limited(`join:${user.id}`, 20, 3600e3) || limited(`join-ip:${ip}`, 60, 3600e3)) return tooMany(res);
      const { code } = await readJson(req);
      const r = circles.joinByCode(user.id, code);
      if (r.error) return json(res, 400, r);
      afterJoin(user.id, r.group);
      return json(res, 200, { ...engine.stateFor(user.id), groupId: r.group.id, already: !!r.already, kind: r.group.kind });
    }
    case 'POST /api/groups/leave': {
      const { groupId } = await readJson(req);
      const g = db.groups?.[groupId];
      const members = g ? Object.keys(g.members) : [];
      const r = circles.leaveGroup(user.id, String(groupId));
      if (r.error) return json(res, 400, r);
      save();
      engine.groupChanged([user.id, ...members]);
      return json(res, 200, engine.stateFor(user.id));
    }
    case 'POST /api/groups/remove': {
      const { groupId, userId } = await readJson(req);
      const g = db.groups?.[groupId];
      const members = g ? Object.keys(g.members) : [];
      const r = circles.removeMember(user.id, String(groupId), String(userId));
      if (r.error) return json(res, 400, r);
      save();
      engine.groupChanged(members);
      return json(res, 200, engine.stateFor(user.id));
    }
    case 'POST /api/groups/code': {
      const { groupId } = await readJson(req);
      const r = circles.newGroupCode(user.id, String(groupId));
      if (r.error) return json(res, 400, r);
      save();
      return json(res, 200, engine.stateFor(user.id));
    }

    /* ---- stranger mode and safety ---- */
    case 'POST /api/stranger': {
      const { on, adult } = await readJson(req);
      const r = engine.setStranger(user.id, { on: on === true, adult: adult === true });
      if (r.error) return json(res, 400, r);
      return json(res, 200, engine.stateFor(user.id));
    }
    case 'POST /api/block': {
      const { userId, report } = await readJson(req);
      const other = String(userId);
      // You can only block someone Mochii actually put in front of you.
      const met = Object.values(db.plans).some((p) => p.userIds.includes(user.id) && p.userIds.includes(other));
      if (!met && !circles.connected(user.id, other)) return json(res, 400, { error: "You can only block someone you've been matched with." });
      engine.blockUser(user.id, other, !!report);
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
  const state = () => ({ ...engine.adminState(), urls: phoneUrls(), publicUrl: PUBLIC_URL || null, protectedByToken: !!ADMIN_TOKEN });
  if (req.method === 'GET' && action === 'state') return json(res, 200, state());
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
    case 'clinician':
      engine.admin.clinician(body.userId, body.on);
      break;
    case 'stranger':
      engine.admin.stranger(body.userId, body.on);
      break;
    case 'resolve':
      engine.admin.resolveReport(body.reportId);
      break;
    case 'demo':
      engine.setDemo(body.on);
      log(`Demo rhythm ${body.on ? 'on' : 'off'}`);
      break;
    case 'reset':
      if (!engine.config.demo) return json(res, 400, { error: 'Reset is only available in demo rhythm, so a live server is never wiped by one click.' });
      resetDb();
      log('Everything was reset');
      break;
    case 'logout':
      return json(res, 200, { ok: true }, { 'set-cookie': `eden_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    default:
      return json(res, 404, { error: 'Unknown action' });
  }
  return json(res, 200, state());
}

/* ------------------------------------------------------------------ static */

function serveStatic(req, res, pathname) {
  const vendor = pathname.match(/^\/vendor\/maplibre-gl\/(maplibre-gl(?:-worker)?\.mjs|maplibre-gl\.css)$/);
  if (vendor) {
    return fs.readFile(path.join(MAPLIBRE, vendor[1]), (err, data) => {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, data, TYPES[path.extname(vendor[1])], { 'cache-control': 'public, max-age=86400' });
    });
  }
  // The dashboards' pages hold no data: their APIs check the operator token / clinician account.
  if (pathname === '/admin' || pathname === '/clinician') pathname = `${pathname}.html`;
  if (pathname === '/') pathname = '/index.html';
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  const file = path.normalize(path.join(PUBLIC, decoded));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      // Single-page app: unknown paths (like /join/K7Q2-M9XT) get the app.
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
  if (PUBLIC_URL) return [PUBLIC_URL];
  return HTTPS_PORT ? lanIps().map((ip) => `https://${ip}:${HTTPS_PORT}`) : lanIps().map((ip) => `http://${ip}:${PORT}`);
}

http.createServer(handle).listen(PORT, '0.0.0.0');
if (HTTPS_PORT) {
  const cert = await loadOrCreateCert(lanIps());
  https.createServer({ key: cert.key, cert: cert.cert }, handle).listen(HTTPS_PORT, '0.0.0.0');
}
engine.start();

const urls = phoneUrls();
console.log(`\n  🐾 Mochii is running${engine.config.demo ? ' (demo rhythm: fast suggestions)' : ''}\n`);
if (urls[0]) {
  console.log(await QRCode.toString(urls[0], { type: 'terminal', small: true }));
  console.log(PUBLIC_URL ? '  Open:' : '  Phones on the same Wi-Fi, open:');
  for (const u of urls) console.log(`    ${u}`);
  if (!PUBLIC_URL && HTTPS_PORT) console.log('  (First time: tap "Show Details" → "visit this website". It\'s a self-signed test certificate.)\n');
}
console.log(`  Operator dashboard: ${PUBLIC_URL || `http://localhost:${PORT}`}/admin${ADMIN_TOKEN ? '  (operator token required)' : '  (this computer only: set EDEN_ADMIN_TOKEN to use it remotely)'}`);
console.log(`  Care-team view:     ${PUBLIC_URL || `http://localhost:${PORT}`}/clinician  (clinician accounts)${clinician.aiReady() ? '' : '  (AI summaries: set ANTHROPIC_API_KEY)'}`);
if (PUBLIC_URL && !TRUST_PROXY) console.log('  ⚠ PUBLIC_URL is set but TRUST_PROXY is not: secure cookies and rate limits won’t see the real client.');
if (!ADMIN_TOKEN && (PUBLIC_URL || TRUST_PROXY)) console.log('  ⚠ No EDEN_ADMIN_TOKEN: the operator dashboard is unreachable remotely (that is the safe default).');
console.log('');
