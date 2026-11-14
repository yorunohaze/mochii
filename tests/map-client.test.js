import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

// Exercise map lifecycle failures without a browser, GPU, tile network or live user data.
// Only boot is skipped; the functions under test are the app's unmodified implementation.
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace('void boot();', '');

class Element {
  constructor() {
    this.children = [];
    this.attrs = {};
    this.handlers = {};
    this.offsetHeight = 300;
    this.clientHeight = 844;
    this.clientWidth = 390;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
      toggle: (n, on) => on ? classes.add(n) : classes.delete(n),
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  contains(el) { return this.children.includes(el); }
  focus() { this.focused = true; }
}

function harness({ failGPU = false } = {}) {
  const timers = new Map();
  let timerId = 0;
  const instances = [];
  class MapStub {
    constructor() {
      if (failGPU) throw new Error('No WebGL');
      this.events = {};
      this.sources = {};
      instances.push(this);
    }
    on(name, fn) { this.events[name] = fn; }
    addControl() {}
    getStyle() { return this.style; }
    remove() { this.removed = true; }
    addSource(name) { this.sources[name] = { setData() {} }; }
    addLayer() {}
    getSource(name) { return this.sources[name]; }
    easeTo(options) { this.camera = options; }
  }
  const shell = Object.fromEntries(['map', 'top', 'head', 'body', 'sheet', 'mapNotice'].map((key) => [key, new Element()]));
  shell.head.offsetHeight = 66;
  const document = {
    body: new Element(), documentElement: new Element(), activeElement: null,
    getElementById: () => new Element(), createElement: () => new Element(),
    createTextNode: (s) => s, addEventListener() {},
  };
  const context = vm.createContext({
    document, Node: Element, navigator: { userAgent: '' }, window: {},
    sessionStorage: { getItem: () => null }, matchMedia: () => ({ matches: false }),
    addEventListener() {}, setInterval() {},
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id), requestAnimationFrame: (fn) => fn(),
    getComputedStyle: () => ({ getPropertyValue: () => '#3e6b55' }),
    library: { Map: MapStub, AttributionControl: class {} }, testShell: shell,
    testState: { card: { id: 'question' }, me: {}, map: { friends: [] }, plans: [] },
  });
  const run = (code) => vm.runInContext(code, context);
  run(source);
  run('ml = library; shell = testShell; state = testState;');
  return { run, shell, document, timers, instances };
}

test('a WebGL failure leaves questions accessible and offers map retry', () => {
  const h = harness({ failGPU: true });
  h.run('ensureMap()');
  assert.equal(h.run('map'), null);
  assert.equal(h.document.body.classList.contains('has-map'), false);
  assert.equal(h.shell.body.inert, false);
  assert.equal(h.shell.mapNotice.hidden, false);
  assert.equal(h.shell.mapNotice.children[1].children[0], 'Try map again');
});

test('a style download error removes the blank map and prevents repeated retries', () => {
  const h = harness();
  h.run('ensureMap(); setSheetOpen(false);');
  assert.equal(h.shell.body.inert, true);
  h.instances[0].events.error();
  assert.equal(h.instances[0].removed, true);
  assert.equal(h.shell.body.inert, false);
  assert.equal(h.timers.size, 0);
  h.run('ensureMap()');
  assert.equal(h.instances.length, 1);
});

test('a stalled map load times out, while a successful load cancels the timeout', () => {
  const stalled = harness();
  stalled.run('ensureMap()');
  [...stalled.timers.values()][0]();
  assert.equal(stalled.run('mapUnavailable'), true);
  const loaded = harness();
  loaded.run('ensureMap()');
  loaded.instances[0].style = {};
  loaded.instances[0].events.load();
  assert.equal(loaded.timers.size, 0);
  loaded.instances[0].events.error(); // a single later tile error need not discard a working map
  assert.equal(loaded.run('mapUnavailable'), false);
});

test('a late load callback from a removed map cannot affect a replacement', () => {
  const h = harness();
  h.run('ensureMap()');
  const old = h.instances[0];
  h.run('mapFallback(); mapUnavailable = false; ensureMap();');
  old.events.load();
  assert.equal(h.run('areasReady'), false);
  assert.equal(h.timers.size, 1);
});

test('collapsed sheets leave hidden controls unfocusable and expose expansion state', () => {
  const h = harness();
  h.run('ensureMap()');
  const button = new Element();
  h.shell.body.children.push(button);
  h.document.activeElement = button;
  h.run('setSheetOpen(false)');
  assert.equal(h.shell.body.inert, true);
  assert.equal(h.shell.head.focused, true);
  assert.equal(h.shell.head.attrs['aria-expanded'], 'false');
  h.run('setSheetOpen(true)');
  assert.equal(h.shell.body.inert, false);
  assert.equal(h.shell.head.attrs['aria-expanded'], 'true');
});

test('camera padding stays valid on a short viewport', () => {
  const h = harness();
  h.shell.map.clientHeight = 180;
  h.shell.map.clientWidth = 320;
  h.run('ensureMap(); markers.set("me", { marker: { getLngLat: () => [24.83, 60.19] } }); frameMap(false);');
  const { padding } = h.instances[0].camera;
  assert.ok(padding.bottom >= 0 && padding.top + padding.bottom < 180);
  assert.ok(padding.left + padding.right < 320);
});
