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

test('mood API authenticates, streams to visible friends, and persists across restart', { timeout: 30000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mochii-mood-api-'));
  const port = await freePort();
  let httpsPort = await freePort();
  while (httpsPort === port) httpsPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  let streamAbort;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  async function start() {
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true,
      env: { ...process.env, EDEN_DATA_DIR: dataDir, EDEN_PLACES: 'off', EDEN_DEMO: '0', PORT: String(port), HTTPS_PORT: String(httpsPort), ANTHROPIC_API_KEY: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Test server exited: ${errors}`);
      try { if ((await fetch(`${base}/api/info`)).ok) return; } catch {}
      await delay(50);
    }
    throw new Error(`Test server did not start: ${errors}`);
  }
  function client() {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(url, body) {
        const res = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
        if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
        return { status: res.status, data: await res.json() };
      },
    };
  }
  try {
    await start();
    const anonymous = client(), alice = client(), bob = client();
    assert.equal((await anonymous.request('/api/mood', { mood: 'sunny' })).status, 401);
    for (const [c, name] of [[alice, 'Alice'], [bob, 'Bob']]) {
      assert.equal((await c.request('/api/signup', { name, username: name.toLowerCase(), password: 'test-password' })).status, 200);
      await c.request('/api/location', { lat: 60.1901234, lon: 24.8312345, acc: 15 });
    }
    assert.equal((await bob.request('/api/mood', { mood: '../../invalid' })).status, 400);
    assert.equal((await bob.request('/api/mood', {})).status, 400);
    await bob.request('/api/mood', { mood: 'rainy' });
    assert.equal((await alice.request('/api/state')).data.map.friends.length, 0);
    await bob.request('/api/map', { showArea: true });

    streamAbort = new AbortController();
    const res = await fetch(base + '/api/stream', { headers: { cookie: alice.cookie }, signal: streamAbort.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function nextState() {
      for (;;) {
        const split = buffer.indexOf('\n\n');
        if (split >= 0) {
          const packet = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const line = packet.split('\n').find((l) => l.startsWith('data: '));
          if (line) return JSON.parse(line.slice(6));
        } else {
          const { value, done } = await reader.read();
          assert.equal(done, false);
          buffer += decoder.decode(value, { stream: true });
        }
      }
    }
    assert.equal((await nextState()).map.friends[0].mood, 'rainy');
    await bob.request('/api/mood', { mood: 'sunny' });
    let streamed;
    do { streamed = await nextState(); } while (streamed.map.friends[0]?.mood !== 'sunny');
    assert.equal(streamed.map.friends[0].lat, 60.195);
    streamAbort.abort();

    // Wait for the actual debounced store write, then restart the process using the same isolated data.
    await delay(400);
    await stop();
    await start();
    assert.equal((await bob.request('/api/state')).data.me.mood, 'sunny');
    await bob.request('/api/mood', { mood: null });
    assert.equal((await alice.request('/api/state')).data.map.friends[0].mood, null);
    await bob.request('/api/map', { showArea: false });
    assert.deepEqual((await alice.request('/api/state')).data.map.friends, []);
  } finally {
    streamAbort?.abort();
    await stop();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('mochii-mood-api-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
