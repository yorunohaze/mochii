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
    easeTo(options) { this.camera = options; this.cameraCalls = (this.cameraCalls || 0) + 1; }
    fitBounds(bounds, options) { this.easeTo(options); }
  }
  class MarkerStub {
    constructor(options) { Object.assign(this, options); }
    setLngLat(at) { this.at = at; return this; }
    getLngLat() { return this.at; }
    setOffset(offset) { this.offset = offset; return this; }
    setPopup(popup) { this.popup = popup; return this; }
    addTo() { return this; }
    remove() { this.removed = true; }
  }
  class PopupStub { on() {} }
  class BoundsStub { extend() {} }
  const shell = Object.fromEntries(['map', 'top', 'head', 'body', 'sheet', 'mapNotice', 'stage', 'label', 'plans', 'peek', 'nav', 'welcome', 'mood'].map((key) => [key, new Element()]));
  shell.head.offsetHeight = 66;
  shell.nav.offsetHeight = 64;
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
    library: { Map: MapStub, Marker: MarkerStub, Popup: PopupStub, LngLatBounds: BoundsStub, AttributionControl: class {} }, testShell: shell,
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

test('Our plans opens the sheet and hides the question without answering it', () => {
  const h = harness();
  h.run('ensureMap(); selectHomeView("plans");');
  assert.equal(h.shell.stage.hidden, true);
  assert.equal(h.shell.body.inert, false);
  assert.equal(h.run('state.card.id'), 'question');
  assert.equal(h.shell.plans.children.length, 1); // empty-plan guidance and a working return button
  const backButton = h.shell.plans.children[0].children.at(-1);
  backButton.handlers.click();
  assert.equal(h.run('homeView'), 'map');
  assert.equal(h.shell.stage.hidden, false);
  assert.equal(h.shell.body.inert, false);
});

test('Explore restores the map without losing upcoming plans', () => {
  const h = harness();
  h.run('state.plans = [{ id: "coffee", title: "Coffee with Mira", emoji: "☕", startAt: Date.now(), place: { name: "Cafe" } }]; ensureMap(); selectHomeView("plans"); selectHomeView("map");');
  assert.equal(h.shell.stage.hidden, false);
  assert.equal(h.shell.body.inert, true);
  assert.equal(h.shell.plans.children.length, 1);
  assert.equal(h.run('state.plans[0].id'), 'coffee');
});

test('desktop camera leaves room beside the plan panel', () => {
  const h = harness();
  h.shell.map.clientWidth = 1280;
  h.shell.sheet.offsetWidth = 420;
  h.run('ensureMap(); markers.set("me", { marker: { getLngLat: () => [24.83, 60.19] } }); frameMap(false);');
  assert.equal(h.instances[0].camera.padding.right, 480);
  assert.equal(h.instances[0].camera.padding.bottom, 50);
});

test('your weather updates your map avatar and MOOD button without moving the camera', () => {
  const h = harness();
  h.run('state.map.me = { lat: 60.19, lon: 24.83 }; state.me.mood = "sunny"; ensureMap(); updateMap(); renderMoodButton();');
  const original = h.run('markers.get("me").marker');
  assert.equal(original.element.children[0].attrs.src, '/icons/moods/sunny.png');
  const cameraCalls = h.instances[0].cameraCalls;
  h.run('state.me.mood = "rainy"; updateMap(); renderMoodButton();');
  assert.equal(h.run('markers.get("me").marker.element.children[0].attrs.src'), '/icons/moods/rainy.png');
  assert.ok(h.shell.mood.attrs['aria-label'].includes('Rainy, sad'));
  assert.equal(original.removed, true);
  assert.equal(h.instances[0].cameraCalls, cameraCalls);
  h.run('state.me.mood = null; updateMap();');
  assert.equal(h.run('markers.get("me").marker.element.children[0].attrs.src'), '/icons/cat.png');
});

test('a friend changing weather replaces their cat on an already open map', () => {
  const h = harness();
  h.run('state.map.friends = [{ id: "Bob", name: "Bob", kind: "area", lat: 60.195, lon: 24.83, mood: "foggy" }]; ensureMap(); updateMap();');
  const original = h.run('markers.get("f:Bob:area").marker');
  assert.equal(original.element.children[0].children[0].attrs.src, '/icons/moods/foggy.png');
  h.run('state.map.friends[0].mood = "rainbow"; updateMap();');
  assert.equal(h.run('markers.get("f:Bob:area").marker.element.children[0].children[0].attrs.src'), '/icons/moods/rainbow.png');
  assert.equal(original.removed, true);
  h.run('state.map.friends = []; updateMap();');
  assert.equal(h.run('markers.size'), 0);
});

test('cats in the same shared area remain distinct without changing their coordinates', () => {
  const h = harness();
  h.run('state.map.friends = ["Bob", "Cara"].map(id => ({ id, name: id, kind: "area", lat: 60.195, lon: 24.83 })); ensureMap(); updateMap();');
  const bob = h.run('markers.get("f:Bob:area").marker');
  const cara = h.run('markers.get("f:Cara:area").marker');
  assert.deepEqual([...bob.at], [24.83, 60.195]);
  assert.deepEqual([...cara.at], [24.83, 60.195]);
  assert.notDeepEqual([...bob.offset], [...cara.offset]);
  h.run('state.map.friends.pop(); updateMap();');
  assert.deepEqual([...bob.offset], [0, 0]);
});

test('unexpected weather values cannot be turned into image paths', () => {
  const h = harness();
  assert.equal(h.run('weatherCat("../../private").attrs.src'), '/icons/cat.png');
});
