import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A real server process on temporary ports and data. */
async function serve(env = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mochii-access-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true,
    env: { ...process.env, EDEN_DATA_DIR: dataDir, EDEN_PLACES: 'off', EDEN_DEMO: '0', PORT: String(port), HTTPS_PORT: '0', ANTHROPIC_API_KEY: '', EDEN_ADMIN_TOKEN: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (c) => { errors += c; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${errors}`);
    try { if ((await fetch(`${base}/api/info`)).ok) break; } catch {}
    await delay(50);
  }
  return {
    base,
    async stop() {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      await delay(100);
      assert.ok(path.basename(dataDir).startsWith('mochii-access-'));
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

function client(base) {
  let cookie = '';
  return async (url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('operator API: this computer only, and never through a tunnel or proxy', { timeout: 30000 }, async () => {
  const s = await serve();
  try {
    const req = client(s.base);
    assert.equal((await req('/api/admin/state')).status, 200);
    // cloudflared / ngrok / nginx connect from 127.0.0.1 too, but add forwarding headers.
    assert.equal((await req('/api/admin/state', undefined, { 'x-forwarded-for': '203.0.113.9' })).status, 403);
    assert.equal((await req('/api/admin/state', undefined, { 'cf-connecting-ip': '203.0.113.9' })).status, 403);
    assert.equal((await req('/api/admin/reset', {})).status, 400); // no one-click wipe outside demo rhythm
  } finally {
    await s.stop();
  }
});

test('with EDEN_ADMIN_TOKEN, the operator API needs the token from anywhere', { timeout: 30000 }, async () => {
  const s = await serve({ EDEN_ADMIN_TOKEN: 'correct-horse-battery-staple' });
  try {
    const req = client(s.base);
    assert.equal((await req('/api/admin/state')).status, 403);
    assert.equal((await req('/api/admin/state', undefined, { 'x-admin-token': 'wrong' })).status, 403);
    assert.equal((await req('/api/admin/state', undefined, { 'x-admin-token': 'correct-horse-battery-staple' })).status, 200);
    assert.equal((await req('/api/admin/login', { token: 'wrong' })).status, 401);
    assert.equal((await req('/api/admin/login', { token: 'correct-horse-battery-staple' })).status, 200);
    assert.equal((await req('/api/admin/state')).status, 200); // the login cookie works
  } finally {
    await s.stop();
  }
});

test('invite codes: preview, sign up straight into the group, and wrong codes are refused', { timeout: 30000 }, async () => {
  const s = await serve();
  try {
    const ana = client(s.base);
    const ben = client(s.base);
    await ana('/api/signup', { name: 'Ana', username: 'ana', password: 'password-ana' });
    const made = await ana('/api/groups', { name: 'Sunday walkers' });
    const code = made.data.groups[0].code;
    assert.deepEqual((await ben(`/api/invite/${code}`)).data, { name: 'Sunday walkers', kind: 'friends', size: 1, by: 'Ana' });
    assert.equal((await ben('/api/invite/AAAA-AAAA')).status, 404);
    const joined = await ben('/api/signup', { name: 'Ben', username: 'ben', password: 'password-ben', code });
    assert.equal(joined.status, 200);
    assert.equal(joined.data.joinError, null);
    assert.equal(joined.data.groups[0].name, 'Sunday walkers');
    assert.equal(joined.data.people, 2); // Ben + Ana; not the whole server
    assert.equal((await ben('/api/groups/join', { code: 'AAAA-AAAA' })).status, 400);
    assert.equal((await ben('/api/clinician/state')).status, 403); // not a clinician account
  } finally {
    await s.stop();
  }
});

test('passwords are at least 8 characters and logins are rate-limited per username', { timeout: 30000 }, async () => {
  const s = await serve();
  try {
    const req = client(s.base);
    assert.equal((await req('/api/signup', { name: 'Cy', username: 'cyril', password: 'short' })).status, 400);
    assert.equal((await req('/api/signup', { name: 'Cy', username: 'cyril', password: 'long-enough' })).status, 200);
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await req('/api/login', { username: 'cyril', password: 'nope' })).status);
    assert.ok(statuses.slice(0, 10).every((x) => x === 401));
    assert.equal(statuses.at(-1), 429);
    assert.equal((await req('/api/login', { username: 'cyril', password: 'long-enough' })).status, 429); // even the right one, for now
  } finally {
    await s.stop();
  }
});
