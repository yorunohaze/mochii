import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace('void boot();', '');

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.handlers = {};
    this.classList = { add() {}, remove() {} };
  }
  setAttribute(key, value) { this.attrs[key] = value; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  addEventListener(event, handler) { this.handlers[event] = handler; }
  remove() { this.removed = true; }
  focus() {}
  click() { if (!this.disabled) return this.handlers.click?.(); }
  querySelectorAll() { return this.children.flatMap(c => c instanceof Element ? [c, ...c.querySelectorAll()] : []); }
}

function harness({ choice = null, permission = 'prompt', secure = true, supported = true } = {}) {
  const storage = new Map(choice == null ? [] : [['eden.geo', choice]]);
  const requests = [], watches = [], cleared = [], calls = [];
  const document = {
    body: new Element(), activeElement: null,
    getElementById: () => new Element(), createElement: tag => new Element(tag), createTextNode: text => text,
    addEventListener() {}, removeEventListener() {},
  };
  const navigator = {
    userAgent: '', permissions: { query: async () => ({ state: permission }) },
    ...(supported ? { geolocation: {
      getCurrentPosition: (success, failure, options) => requests.push({ success, failure, options }),
      watchPosition: (success, failure) => { watches.push({ success, failure }); return watches.length; },
      clearWatch: id => cleared.push(id),
    } } : {}),
  };
  const context = vm.createContext({
    document, navigator, Node: Element, window: { isSecureContext: secure },
    sessionStorage: { getItem: () => null },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    matchMedia: () => ({ matches: false }), addEventListener() {}, setInterval() {}, setTimeout() {},
    fetch: async (url, init) => { calls.push({ url, body: init.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => null }; },
  });
  const run = code => vm.runInContext(code, context);
  run(source);
  // Avoid unrelated map rendering; dialog, location, settings and API code remain unmodified.
  run('render = () => {}; syncNudges = () => {}; renderAuth = () => {}; state = { me: { id: "Alice", name: "Alice" }, map: { showArea: false }, plans: [] };');
  const elements = () => document.body.querySelectorAll().filter(el => !el.removed);
  const sheet = () => document.body.children.findLast(el => !el.removed && el.attrs.role === 'dialog');
  const button = text => sheet()?.querySelectorAll().find(el => el.tag === 'button' && (el.textContent === text || el.children.includes(text)));
  const status = () => sheet()?.querySelectorAll().find(el => el.attrs.role === 'status');
  return { run, storage, requests, watches, cleared, calls, elements, sheet, button, status, navigator };
}

const position = { coords: { latitude: 60.19, longitude: 24.83, accuracy: 12 } };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('first sign-in shows a location invitation; a tap requests access and success enables updates', async () => {
  const h = harness();
  h.run('state.card = { id: "location-card", action: "location" };');
  await h.run('reportCapabilities()');
  assert.equal(h.sheet().attrs['aria-labelledby'], 'location-title');
  assert.equal(h.requests.length, 0);
  const done = h.button('Allow location').click();
  assert.equal(h.requests.length, 1); // native request starts during the click, before any await
  assert.notEqual(h.storage.get('eden.geo'), 'on');
  assert.equal(h.button('Finding your location…').disabled, true);
  h.requests[0].success(position);
  await done;
  await flush();
  assert.equal(h.storage.get('eden.geo'), 'on');
  assert.equal(h.watches.length, 1);
  assert.equal(h.sheet(), undefined);
  assert.deepEqual(h.calls.find(c => c.url === '/api/location').body, { lat: 60.19, lon: 24.83, acc: 12 });
  assert.ok(h.calls.some(c => c.url === '/api/answer' && c.body.cardId === 'location-card' && c.body.yes));
  assert.equal(h.calls.some(c => c.url === '/api/map'), false); // GPS consent is separate from sharing
});

test('Turn location on in settings requests immediately and a denial stays visible with retry', async () => {
  const h = harness({ choice: 'off', permission: 'denied' });
  h.run('openMenu()');
  h.button('Turn location on').click();
  assert.equal(h.requests.length, 1);
  h.requests[0].failure({ code: 1 });
  await flush();
  assert.equal(h.storage.get('eden.geo'), 'off');
  assert.match(h.status().textContent, /browser permissions and allow Location/);
  assert.equal(h.button('Try location again').disabled, false);
  const retry = h.button('Try location again').click();
  assert.equal(h.requests.length, 2);
  h.requests[1].success(position);
  await retry;
  assert.equal(h.storage.get('eden.geo'), 'on');
});

test('Not now does not request GPS and is respected even if the browser has granted permission', async () => {
  const h = harness({ permission: 'granted' });
  await h.run('reportCapabilities()');
  h.button('Not now').click();
  await h.run('reportCapabilities()');
  assert.equal(h.storage.get('eden.geo'), 'off');
  assert.equal(h.requests.length, 0);
  assert.equal(h.watches.length, 0);
  assert.equal(h.sheet(), undefined);
});

test('a timeout or unavailable position leaves location off and offers a useful retry', async () => {
  for (const [code, message] of [[2, /unavailable/], [3, /too long/]]) {
    const h = harness();
    h.run('openLocationPrompt(true)');
    h.requests[0].failure({ code });
    await flush();
    assert.equal(h.storage.get('eden.geo'), 'off');
    assert.match(h.status().textContent, message);
    assert.equal(h.button('Try location again').disabled, false);
    assert.equal(h.watches.length, 0);
    assert.equal(h.calls.some(c => c.url === '/api/location'), false);
  }
});

test('insecure and unsupported browsers explain the problem without silently enabling location', async () => {
  for (const [options, message] of [[{ secure: false }, /HTTPS/], [{ supported: false }, /location support/]]) {
    const h = harness(options);
    h.run('openLocationPrompt(true)');
    await flush();
    assert.match(h.status().textContent, message);
    assert.notEqual(h.storage.get('eden.geo'), 'on');
    assert.equal(h.requests.length, 0);
  }
});

test('dismissing a pending prompt prevents a late location callback from uploading coordinates', async () => {
  const h = harness();
  h.run('openLocationPrompt(true)');
  h.button('Not now').click();
  h.requests[0].success(position);
  await flush();
  assert.equal(h.storage.get('eden.geo'), 'off');
  assert.equal(h.watches.length, 0);
  assert.equal(h.calls.some(c => c.url === '/api/location'), false);
});

test('a revoked permission clears a saved on state and enables the settings action again', async () => {
  const h = harness({ choice: 'on', permission: 'denied' });
  await h.run('reportCapabilities()');
  h.run('openMenu()');
  assert.equal(h.storage.get('eden.geo'), 'off');
  assert.ok(h.button('Turn location on'));
  assert.equal(h.watches.length, 0);
});

test('resuming enabled location creates one watcher and ignores callbacks after sign-out', async () => {
  const h = harness({ choice: 'on', permission: 'granted' });
  await h.run('reportCapabilities()');
  await h.run('reportCapabilities()');
  assert.equal(h.watches.length, 1);
  assert.equal(h.sheet(), undefined);
  h.run('signedOut()');
  h.watches[0].success(position);
  assert.deepEqual(h.cleared, [1]);
  assert.equal(h.calls.some(c => c.url === '/api/location'), false);
});

test('the location onboarding card opens the same immediate permission flow', () => {
  const h = harness();
  h.run('onAnswer({ id: "location-card", action: "location" }, true)');
  assert.equal(h.requests.length, 1);
  assert.equal(h.calls.some(c => c.url === '/api/answer'), false); // no success recorded before GPS returns
});

test('a late visibility update cannot resume location after sign-out', async () => {
  const h = harness({ choice: 'on' });
  h.run('signedOut(); startLocation();');
  const result = await h.run('askLocation()');
  assert.equal(result.cancelled, true);
  assert.equal(h.requests.length, 0);
  assert.equal(h.watches.length, 0);
});

test('sharing a rough area from settings also requests location if it is off', async () => {
  const h = harness({ choice: 'off' });
  h.run('openMenu()');
  await h.button('Show friends my rough area').click();
  assert.equal(h.requests.length, 1);
  assert.ok(h.calls.some(c => c.url === '/api/map' && c.body.showArea === true));
});
