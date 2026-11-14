// Mochii phone app. Mochii asks; you answer yes or no. That's the whole interface.
const $app = document.getElementById('app');
const $toasts = document.getElementById('toasts');

let state = null;
let stream = null;
let swReg = null;
let shell = null;
let stageKey = '';
let busy = false;
let authMode = 'signup';
let homeView = 'map';
let closeDialog = null;
let watchId = null;
let locationRequest = null;
let locationEpoch = 0;
let lastSent = null;
let knownWaiting = null; // plan questions already seen here, so each one nudges once
let pendingCode = null; // an invite code from a /join/CODE link, used right after signing in
const shownToasts = new Set(JSON.parse(sessionStorage.getItem('eden.toasts') || '[]'));
const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);

/* ------------------------------------------------------------------ helpers */

/** Builds DOM with textContent only, so names typed by other people can never inject HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, body) {
  const init = body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  try {
    const res = await fetch(path, init);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Can't reach Mochii. Is the host computer on and on the same Wi-Fi?" } };
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

const MOODS = [
  { id: 'sunny', name: 'Sunny', feeling: 'Happy', emoji: '☀️' },
  { id: 'rainy', name: 'Rainy', feeling: 'Sad', emoji: '🌧️' },
  { id: 'foggy', name: 'Foggy', feeling: 'Uncertain', emoji: '🌫️' },
  { id: 'cloudy', name: 'Cloudy', feeling: 'Low energy', emoji: '☁️' },
  { id: 'stormy', name: 'Stormy', feeling: 'Overwhelmed', emoji: '⛈️' },
  { id: 'rainbow', name: 'Rainbow', feeling: 'Hopeful', emoji: '🌈' },
];
const moodInfo = (id) => MOODS.find((m) => m.id === id);

// Pixel-art drawings for activities, keyed by the emoji the server sends with cards, plans and map pins.
const ACTIVITY_ART = {
  '☕': 'coffee', '🚶': 'walk', '🍝': 'cooking', '🏋': 'gym', '🛒': 'groceries',
  '🧖': 'sauna', '🏊': 'swimming', '🎬': 'movie', '📚': 'study', '🎲': 'games',
};

function pixelIcon(src, className = '') {
  return h('img', { src, class: `pixel-icon ${className}`.trim(), alt: '', draggable: 'false' });
}

/** The drawing for an activity emoji; any other emoji stays as text. */
function emojiArt(emoji) {
  const name = typeof emoji === 'string' ? ACTIVITY_ART[emoji.replace(/️/g, '')] : null;
  return name ? pixelIcon(`/icons/activities/${name}.png`, 'activity-art') : emoji;
}

function weatherCat(mood, className = '', name = '') {
  const weather = moodInfo(mood);
  return h('img', {
    src: weather ? `/icons/moods/${weather.id}.png` : '/icons/cat.png',
    class: `cat-art weather-cat ${className} weather-${weather?.id || 'neutral'}`,
    alt: name ? `${name}${weather ? ` · ${weather.name}, ${weather.feeling.toLowerCase()}` : ''}` : '',
    draggable: 'false',
  });
}

function catImage(className = '', alt = '') {
  return h('img', { src: '/icons/cat.png', class: `cat-art ${className}`, alt, draggable: 'false' });
}

function brand() {
  return h('div', { class: 'brand' },
    h('img', { src: '/icons/icon-192.png', alt: '', width: '42', height: '42' }),
    h('div', { class: 'brand-copy' }, h('strong', {}, 'Mochii'), h('span', {}, 'a little closer, together.')),
  );
}

function fmtWhen(ts) {
  const d = new Date(ts);
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(d) - day0(new Date())) / 864e5);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const mins = Math.round((ts - Date.now()) / 60000);
  const rel = mins > 0 && mins < 90 ? ` · in ${mins} min` : mins <= 0 && mins > -90 ? ' · now' : '';
  return `${day} ${time}${rel}`;
}

function mapsUrl({ lat, lon, name, search }) {
  if (lat == null || lon == null) return isApple ? `https://maps.apple.com/?q=${enc(search || name || '')}` : `https://www.google.com/maps/search/?api=1&query=${enc(search || name || '')}`;
  if (search) {
    return isApple
      ? `https://maps.apple.com/?q=${enc(search)}&sll=${lat},${lon}`
      : `https://www.google.com/maps/search/?api=1&query=${enc(search)}&center=${lat},${lon}`;
  }
  return isApple ? `https://maps.apple.com/?ll=${lat},${lon}&q=${enc(name || 'Meet here')}` : `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  pendingCode = readInviteCode();
  void loadMapLibrary();
  await registerServiceWorker();
  const r = await api('/api/state');
  if (r.ok && r.data) {
    signedIn(r.data);
    if (pendingCode) void joinWithCode(pendingCode);
  } else {
    renderAuth();
  }
}

/** /join/K7Q2-M9XT or ?code=…: remember the code (through sign-up) and tidy the address bar. */
function readInviteCode() {
  const m = location.pathname.match(/^\/join\/([A-Za-z0-9-]{4,20})\/?$/);
  const fromQuery = new URLSearchParams(location.search).get('code');
  const code = m?.[1] || fromQuery || sessionStorage.getItem('eden.invite');
  if (m || fromQuery) history.replaceState(null, '', '/');
  if (code) sessionStorage.setItem('eden.invite', code);
  return code || null;
}

function clearInvite() {
  pendingCode = null;
  try { sessionStorage.removeItem('eden.invite'); } catch {}
}

async function joinWithCode(code) {
  const r = await api('/api/groups/join', { code });
  clearInvite();
  if (!r.ok) {
    toast(r.data?.error || "That code didn't work. Check it with the person who sent it.");
    return false;
  }
  setState(r.data);
  const g = (r.data.groups || []).find((x) => x.id === r.data.groupId);
  if (r.data.already) toast(`You're already in ${g?.name ?? 'that group'}.`);
  else if (g?.kind === 'care') toast(`You joined ${g.name}. Nothing is shared with them unless you say yes.`);
  else toast(`You're in ${g?.name ?? 'the group'}! 🐾 Mochii will suggest little plans together.`);
  return true;
}

function signedIn(data) {
  setState(data);
  connect();
  void reportCapabilities();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js');
  } catch {
    swReg = null; // e.g. self-signed certificate: everything else still works
  }
}

async function reportCapabilities() {
  const userId = state?.me.id;
  const push = !!swReg && 'PushManager' in window && 'Notification' in window;
  let geo = 'geolocation' in navigator ? 'prompt' : 'unsupported';
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (p) geo = p.state;
  } catch {
    // Safari < 16
  }
  if (state?.me.id !== userId) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  await api('/api/caps', { push, geo, standalone });
  if (state?.me.id !== userId) return;
  const choice = localStorage.getItem('eden.geo');
  if (choice === 'on' && geo !== 'denied') startLocation();
  else if (choice === 'on') {
    localStorage.setItem('eden.geo', 'off');
    stopLocation();
  }
  // Make the first invitation visible above the map, without prompting again after "Not now".
  if (choice == null && !closeDialog) openLocationPrompt();
}

/* ------------------------------------------------------------ live updates */

function connect() {
  stream?.close();
  stream = new EventSource('/api/stream');
  stream.addEventListener('state', (e) => {
    const next = JSON.parse(e.data);
    if (next) setState(next);
    else signedOut();
  });
  stream.onerror = async () => {
    const r = await api('/api/state');
    if (r.status === 401) signedOut();
  };
}

function signedOut() {
  closeDialog?.();
  stream?.close();
  stream = null;
  stopLocation();
  lastSent = null;
  myPos = null;
  state = null;
  knownWaiting = null;
  void clearNudges(() => true);
  navigator.clearAppBadge?.()?.catch(() => {});
  renderAuth();
}

function setState(next) {
  if (!next) return;
  // A slow response can arrive after a newer live update: never step back to an older snapshot.
  if (state && Number.isFinite(next.rev) && Number.isFinite(state.rev) && next.rev < state.rev && next.me?.id === state.me?.id) return;
  const before = state ? (state.card?.id ?? null) : undefined;
  state = next;
  render();
  const tapped = navigator.userActivation?.hasBeenActive ?? true;
  if (before !== undefined && state.card && state.card.id !== before && tapped) navigator.vibrate?.(25);
  syncNudges();
}

addEventListener('focus', () => state && syncNudges());

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state) return;
  const r = await api('/api/state');
  if (r.ok) setState(r.data);
  else if (r.status === 401) signedOut();
  if (localStorage.getItem('eden.geo') === 'on') startLocation();
});

/* ---------------------------------------------------------------- location */

function postPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
  const now = Date.now();
  myPos = { lat, lon };
  updateMap();
  if (lastSent && now - lastSent.t < 15000) {
    const dLat = (lat - lastSent.lat) * 111e3;
    const dLon = (lon - lastSent.lon) * 111e3 * Math.cos((lat * Math.PI) / 180);
    if (Math.hypot(dLat, dLon) < 30) return;
  }
  lastSent = { lat, lon, t: now };
  void api('/api/location', { lat, lon, acc });
}

function locationErrorMessage(err) {
  if (window.isSecureContext === false) return 'Location needs a secure connection. Open Mochii using the HTTPS address from your host, or localhost on this computer, then try again.';
  if (!navigator.geolocation) return 'This browser cannot request your location. Open Mochii in a browser with location support.';
  if (err?.code === 1) return 'Location access is blocked. Open this site\'s browser permissions and allow Location, then try again. Also check that location services are on for your device and browser.';
  if (err?.code === 3) return 'Finding your location took too long. Check that device location services are on, then try again.';
  return 'Your location is unavailable right now. Check that device location services are on, then try again.';
}

function onGeoError(err, notify = true) {
  if (err?.code === 1) {
    localStorage.setItem('eden.geo', 'off');
    stopLocation();
    void api('/api/caps', { geo: 'denied' });
  }
  if (notify) toast(locationErrorMessage(err));
}

function askLocation() {
  if (!state) return Promise.resolve({ ok: false, cancelled: true });
  if (locationRequest) return locationRequest.promise;
  if (!navigator.geolocation || window.isSecureContext === false) {
    return Promise.resolve({ ok: false, message: locationErrorMessage() });
  }
  const userId = state?.me.id;
  const request = {};
  request.promise = new Promise((resolve) => { request.resolve = resolve; });
  locationRequest = request;
  const finish = (result) => {
    if (locationRequest !== request) return;
    locationRequest = null;
    request.resolve(result);
  };
  request.cancel = () => finish({ ok: false, cancelled: true });
  const fail = (err) => {
    if (locationRequest !== request || state?.me.id !== userId) return;
    localStorage.setItem('eden.geo', 'off');
    finish({ ok: false, message: locationErrorMessage(err) });
    onGeoError(err, false);
  };
  try {
    // Call synchronously from the click: no permission query or network request before this.
    navigator.geolocation.getCurrentPosition((pos) => {
      if (locationRequest !== request || state?.me.id !== userId) return;
      localStorage.setItem('eden.geo', 'on');
      finish({ ok: true });
      postPosition(pos);
      void api('/api/caps', { geo: 'granted' });
      startLocation();
    }, fail, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  } catch (err) {
    fail(err);
  }
  return request.promise;
}

function startLocation() {
  if (!state || !navigator.geolocation || window.isSecureContext === false || watchId != null || localStorage.getItem('eden.geo') !== 'on') return;
  const userId = state?.me.id, epoch = locationEpoch;
  const active = () => state?.me.id === userId && locationEpoch === epoch;
  watchId = navigator.geolocation.watchPosition(
    (pos) => { if (active()) postPosition(pos); },
    (err) => { if (active()) onGeoError(err); },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 },
  );
}

function stopLocation() {
  locationEpoch++;
  locationRequest?.cancel();
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function openLocationPrompt(requestNow = false) {
  const userId = state.me.id;
  let answered = false;
  let dismiss;
  const status = h('p', { class: 'location-status', role: 'status', 'aria-live': 'polite' }, 'Choose Allow location, then allow access in your browser.');
  const rememberChoice = async (yes) => {
    if (state?.me.id !== userId) return;
    const card = state.card;
    if (card?.action !== 'location') return;
    const r = await api('/api/answer', { cardId: card.id, yes });
    if (r.ok && state?.me.id === userId) setState(r.data);
  };
  const allow = h('button', { class: 'btn yes', type: 'button', onclick: async () => {
    if (allow.disabled) return;
    allow.disabled = true;
    allow.textContent = 'Finding your location…';
    status.textContent = 'Allow location in your browser if asked. Waiting for your device to find you…';
    const result = await askLocation();
    if (closeDialog !== dismiss || state?.me.id !== userId) return;
    if (result.ok) {
      answered = true;
      dismiss();
      toast('Location is on. Your cat can find its way around.');
      void rememberChoice(true);
    } else {
      status.textContent = result.message || 'Location request cancelled. You can try again.';
      allow.disabled = false;
      allow.textContent = 'Try location again';
    }
  } }, 'Allow location');
  mountDialog(h('section', { class: 'sheet location-sheet', role: 'dialog', 'aria-labelledby': 'location-title', 'aria-describedby': 'location-description' },
    catImage('profile-cat'),
    h('span', { class: 'eyebrow' }, 'A LITTLE CLOSER TO YOUR PEOPLE'),
    h('h2', { id: 'location-title' }, 'Let your cat find you?'),
    h('p', { id: 'location-description' }, 'Use your location to place your cat on the map and find nearby plans. You choose separately whether friends can see your rough area.'),
    status, allow,
    h('button', { class: 'btn quiet', type: 'button', onclick: () => dismiss() }, 'Not now'),
  ), h('div', { class: 'backdrop' }), () => {
    if (answered) return;
    stopLocation();
    localStorage.setItem('eden.geo', 'off');
    void rememberChoice(false);
  });
  dismiss = closeDialog;
  // Settings already supplies the user gesture, so it requests immediately without another tap.
  if (requestNow) allow.click();
}

/* ------------------------------------------------------------ notifications */

function base64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!swReg || !('Notification' in window)) return;
  try {
    const permission = await Notification.requestPermission(); // must start inside the tap
    if (permission !== 'granted') return;
    const info = (await api('/api/info')).data;
    const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(info.vapidPublicKey) });
    const r = await api('/api/push', { subscription: sub.toJSON() });
    if (r.ok) setState(r.data);
  } catch {
    // no push service here; nudges still work while Mochii is open in the background
  }
}

/**
 * Every plan question gets a notification with its own yes/no. Push sends it when Mochii is closed;
 * while Mochii is open in the background, the page asks for it itself (same tag, so never twice).
 * Looking at Mochii, or answering anywhere, clears them.
 */
function syncNudges() {
  const waiting = new Set(state.waiting || []);
  const away = document.hidden || !document.hasFocus();
  const c = state.card;
  if (knownWaiting && away && c?.nudge && !knownWaiting.has(c.id)) void nudge(c.nudge);
  knownWaiting = waiting;
  navigator.setAppBadge?.(waiting.size)?.catch(() => {});
  void clearNudges((cardId) => !away || !waiting.has(cardId));
}

async function nudge(n) {
  if (!swReg || window.Notification?.permission !== 'granted') return;
  (await navigator.serviceWorker.ready).active?.postMessage({ nudge: n });
}

async function clearNudges(shouldClose) {
  if (!swReg) return;
  for (const n of await swReg.getNotifications()) {
    if (n.tag.startsWith('card:') && shouldClose(n.tag.slice(5))) n.close();
  }
}

/* ------------------------------------------------------------------ render */

function render() {
  if (!state) return renderAuth();
  if (!shell) {
    // Home: a full-screen map, with Mochii's card in a sheet over it (swipe it down to see the map).
    shell = {
      map: h('div', { class: 'map-view', role: 'region', 'aria-label': 'Map of your plans and friends nearby' }),
      top: h('header', { class: 'top' }),
      peek: h('span', { class: 'peek' }),
      mapNotice: h('div', { class: 'map-notice', hidden: true, role: 'status' }),
      stage: h('section', { class: 'stage', 'aria-live': 'polite' }),
      label: h('p', { class: 'section-label' }),
      plans: h('div', { class: 'plans' }),
      welcome: h('aside', { class: 'map-welcome', 'aria-label': 'Your neighbourhood' }),
      nav: h('nav', { class: 'bottom-nav', 'aria-label': 'Main navigation' }),
      mood: h('button', { class: 'mood-fab', type: 'button', 'aria-haspopup': 'dialog', onclick: openMood }),
    };
    shell.head = h('button', { class: 'sheet-head', type: 'button', 'aria-controls': 'home-sheet-body', 'aria-label': 'Show or hide the card' }, h('span', { class: 'grab' }), shell.peek);
    shell.body = h('div', { class: 'sheet-body', id: 'home-sheet-body' }, shell.mapNotice, shell.stage, shell.label, shell.plans);
    shell.sheet = h('section', { class: 'home-sheet' }, shell.head, shell.body);
    $app.replaceChildren(shell.map, shell.top, shell.welcome, shell.sheet, shell.nav, shell.mood);
    document.body.classList.add('home');
    setupSheet();
    stageKey = '';
  }
  ensureMap();
  renderTop();
  renderStage();
  renderPlans();
  renderPeek();
  renderMapNotice();
  renderNavigation();
  renderWelcome();
  renderMoodButton();
  updateMap();
  showToasts();
  document.title = state.card ? '(1) Mochii' : 'Mochii';
}

function renderTop() {
  shell.top.replaceChildren(
    brand(),
    h('div', { class: 'top-actions' },
      h('button', { class: 'invite-btn', onclick: openGroups }, h('span', { 'aria-hidden': 'true' }, '+'), h('span', {}, 'Your people')),
      map ? h('button', { class: 'icon-btn', 'aria-label': 'Show everything on the map', onclick: () => frameMap(true) }, '◎') : null,
      h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: openMenu }, '☰'),
    ),
  );
}

function renderWelcome() {
  const total = Math.max(0, (state.people || 1) - 1);
  shell.welcome.replaceChildren(
    h('div', { class: 'welcome-note' },
      h('span', { class: 'eyebrow' }, 'YOUR LITTLE CORNER OF THE WORLD'),
      h('h2', {}, `Hey, ${state.me.name}.`),
      h('p', {}, 'Good company could be just around the corner.'),
      h('span', { class: 'circle-count' }, h('span', { 'aria-hidden': 'true' }, total ? '🐾' : state.me.stranger?.on ? '🌱' : '🐾'),
        total ? `${total} ${total === 1 ? 'person' : 'people'} in your groups` : state.me.stranger?.on ? 'Stranger mode is on' : 'A little room for your people'),
    ),
    weatherCat(state.me.mood, 'welcome-cat'),
  );
}

function renderMoodButton() {
  const weather = moodInfo(state.me.mood);
  shell.mood.setAttribute('aria-label', weather ? `Mood: ${weather.name}, ${weather.feeling.toLowerCase()}. Change your weather` : 'Mood: choose your weather');
  shell.mood.replaceChildren(h('span', { class: 'mood-fab-icon', 'aria-hidden': 'true' },
    pixelIcon(weather ? `/icons/weather/${weather.id}.png` : '/icons/mood-neutral.png')), h('span', {}, 'MOOD'));
}

function openMood() {
  let saving = false;
  const status = h('p', { class: 'mood-status', role: 'status' });
  const grid = h('div', { class: 'mood-grid', role: 'group', 'aria-label': 'Choose your weather' });
  const clear = h('button', { class: 'btn quiet', type: 'button', onclick: () => saveMood(null) }, 'Clear my mood');
  const sharing = h('button', { class: 'btn quiet', type: 'button', onclick: async () => {
    if (saving) return;
    const showArea = !state.map?.showArea;
    // A GPS prompt must start in this user gesture, and never just from picking a mood.
    if (showArea && localStorage.getItem('eden.geo') !== 'on') openLocationPrompt(true);
    setSaving(true);
    const r = await api('/api/map', { showArea });
    setSaving(false);
    if (r.ok) { setState(r.data); updateSharing(); }
    else status.textContent = r.data?.error || 'Could not update sharing. Try again.';
  } });
  const sharingNote = h('p', { class: 'mood-sharing-note' });
  const updateSharing = () => {
    sharing.textContent = state.map?.showArea ? 'Hide my cat’s rough area' : 'Share my cat’s rough area';
    sharing.setAttribute('aria-pressed', String(!!state.map?.showArea));
    sharingNote.textContent = state.me.paused ? 'Your cat is hidden while you take a break.'
      : state.map?.showArea ? 'Your cat and weather appear in your rough area (about 1 km). Location needs to be on.'
      : 'Your rough area is hidden. During an “On my way” plan, your meeting partner can still see your cat and weather.';
  };
  const setSaving = (on) => {
    saving = on;
    [...grid.querySelectorAll('button'), clear, sharing].forEach((b) => { b.disabled = on; });
  };
  async function saveMood(mood) {
    if (saving) return;
    setSaving(true);
    status.textContent = 'Saving your weather…';
    const r = await api('/api/mood', { mood });
    if (r.ok) {
      closeDialog?.();
      setState(r.data);
      toast(mood ? `${moodInfo(mood).name}. Your cat is wearing your weather.` : 'Mood cleared. Just you and your cat.');
    } else {
      status.textContent = r.data?.error || 'Could not save your mood. Try again.';
      setSaving(false);
    }
  }
  for (const weather of MOODS) grid.append(h('button', {
    class: `mood-option mood-${weather.id}`, type: 'button',
    'aria-pressed': String(state.me.mood === weather.id),
    'aria-label': `${weather.name}, ${weather.feeling.toLowerCase()}`, onclick: () => saveMood(weather.id),
  }, weatherCat(weather.id), h('strong', {}, weather.name), h('span', {}, weather.feeling)));
  updateSharing();
  mountDialog(h('section', { class: 'sheet mood-sheet', role: 'dialog', 'aria-label': 'Your mood weather' },
    h('span', { class: 'eyebrow' }, 'A LITTLE WEATHER, A LITTLE YOU'),
    h('h2', {}, 'What’s your weather?'),
    h('p', { class: 'mood-intro' }, 'Every kind of weather belongs here. Pick what feels like you.'),
    grid, status, clear,
    h('div', { class: 'mood-sharing' }, h('b', {}, 'Your cat on the map'), sharingNote, sharing,
      h('p', {}, 'People who can see your cat can see its weather. Change or clear it any time.')),
  ), h('div', { class: 'backdrop' }));
}

function renderNavigation() {
  shell.nav.replaceChildren(
    ...[
      ['map', 'nav-explore', 'Explore', () => selectHomeView('map')],
      ['plans', 'nav-plans', 'Our plans', () => selectHomeView('plans')],
      ['space', 'nav-space', 'My space', openMenu],
    ].map(([id, icon, label, action]) => h('button', {
      class: `nav-btn${homeView === id ? ' active' : ''}`,
      'aria-current': homeView === id ? 'page' : null, onclick: action,
    }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, pixelIcon(`/icons/navigation/${icon}.png`)), h('span', {}, label),
    id === 'plans' && state.plans?.length ? h('span', { class: 'nav-count' }, state.plans.length) : null)),
  );
}

function selectHomeView(view) {
  homeView = view;
  shell.stage.hidden = view === 'plans';
  renderPlans();
  renderPeek();
  renderNavigation();
  setSheetOpen(view === 'plans' || !map);
  if (view === 'map') frameMap(true);
}

/** What the folded-down sheet says, so the map can take the whole screen without hiding anything. */
function renderPeek() {
  const c = state.card;
  const next = (state.plans || [])[0];
  if (homeView === 'plans') shell.peek.textContent = 'Our plans · a little time together';
  else if (c) shell.peek.textContent = c.progress || `Mochii asks: ${c.title}`;
  else if (next) shell.peek.textContent = `Coming up: ${next.title} · ${fmtWhen(next.startAt)}`;
  else shell.peek.textContent = state.me.paused ? 'A little catnap. Take your time. 🌙' : 'Your people. Your pace. 🐾';
}

function renderStage() {
  const c = state.card;
  const paused = state.me.paused;
  const key = c ? `card:${c.id}` : paused ? 'paused' : `empty:${state.people > 1}`;
  if (key === stageKey) return;
  stageKey = key;
  setSheetOpen(homeView === 'plans' || !!c);
  if (c) return shell.stage.replaceChildren(cardView(c));
  if (paused) {
    return shell.stage.replaceChildren(
      h('div', { class: 'calm' },
        catImage('resting-cat'),
        h('span', { class: 'eyebrow' }, 'CATNAP MODE'),
        h('h2', {}, 'A little space to just be.'),
        h('p', {}, `Back on ${new Date(paused).toLocaleDateString([], { weekday: 'long' })}. Nothing to do until then.`),
        h('button', { class: 'btn quiet', onclick: () => pause(0) }, "I'm back"),
      ),
    );
  }
  shell.stage.replaceChildren(
    h('div', { class: 'calm' },
      catImage(),
      h('span', { class: 'eyebrow' }, 'NO RUSH. NO PRESSURE.'),
      state.people > 1
        ? [h('h2', {}, 'A good moment is on its way.'), h('p', {}, `Mochii will find something lovely to do with your people.${state.me.hasPush ? " We'll give you a little nudge." : ' Check back when you feel like it.'}`)]
        : [h('h2', {}, 'Good things start with two.'),
           h('p', {}, state.me.stranger?.on
             ? 'Stranger mode is on: Mochii will introduce you to someone new when there’s a good match. You can also start a group for your friends.'
             : 'Start a group and share its code, or join a friend’s group with theirs. Mochii only suggests plans with people in your groups.'),
           h('button', { class: 'btn yes', onclick: openGroups }, 'Start or join a group'),
           !state.me.stranger?.on ? h('button', { class: 'btn quiet', onclick: () => toggleStranger(true) }, 'Or meet someone new 🌱') : null],
    ),
  );
}

function cardView(c) {
  const serious = ['survey', 'support', 'care'].includes(c.kind);
  const el = h('article', { class: `card${serious ? ' steady' : ''}`, 'aria-label': c.title });
  const lines = (c.lines || []).map((l) => {
    if (l.when) return h('li', {}, h('span', { class: 'i' }, emojiArt(l.icon || '🕒')), fmtWhen(l.when));
    if (l.map) return h('li', {}, h('span', { class: 'i' }, emojiArt(l.icon || '🗺️')), h('a', { class: 'map', href: mapsUrl(l.map), target: '_blank', rel: 'noopener' }, 'Open in Maps'));
    if (l.tel) return h('li', {}, h('span', { class: 'i' }, emojiArt(l.icon || '📞')), h('a', { class: 'map', href: `tel:${l.tel}` }, l.text));
    return h('li', {}, h('span', { class: 'i' }, emojiArt(l.icon || '•')), l.text);
  });
  // Check-in questions keep their published answer options; everything else is yes or no.
  const answers = c.options
    ? h('div', { class: 'answers options' }, c.options.map((o) => h('button', { class: 'btn option', onclick: () => onAnswer(c, true, el, o.value) }, o.label)))
    : h('div', { class: 'answers' },
        h('button', { class: 'btn yes', onclick: () => onAnswer(c, true, el) }, c.yes || 'Yes'),
        h('button', { class: 'btn no', onclick: () => onAnswer(c, false, el) }, c.no || 'No'),
      );
  el.append(
    ...[
      h('div', { class: 'card-heading' },
        h('div', { class: 'from' }, h('img', { src: '/icons/icon-192.png', alt: '' }), c.progress || 'A little nudge from Mochii'),
        c.emoji ? h('span', { class: 'activity-stamp', 'aria-hidden': 'true' }, emojiArt(c.emoji)) : null,
      ),
      c.note ? h('p', { class: 'note' }, c.note) : null,
      h('h1', {}, c.title),
      lines.length ? h('ul', { class: 'lines' }, lines) : null,
      answers,
    ].filter(Boolean),
  );
  return el;
}

async function onAnswer(card, yes, el, value) {
  if (busy) return;
  if (card.action === 'location') {
    if (yes) return openLocationPrompt(true);
    localStorage.setItem('eden.geo', 'off');
    stopLocation();
  }
  busy = true;
  // Browser permission prompts have to start inside the tap.
  if (yes && card.action === 'notify') void enablePush();
  el.querySelectorAll('button').forEach((b) => (b.disabled = true));
  el.classList.add(yes ? 'leaving-yes' : 'leaving-no');
  const [r] = await Promise.all([api('/api/answer', { cardId: card.id, yes, value }), wait(320)]);
  busy = false;
  if (r.data && r.ok) setState(r.data);
  else {
    stageKey = '';
    const latest = await api('/api/state');
    if (latest.ok) setState(latest.data);
  }
}

function renderPlans() {
  const plans = state.plans || [];
  shell.label.textContent = homeView === 'plans' ? 'Little plans. Real connections.' : 'A little time together';
  shell.label.hidden = !plans.length && homeView !== 'plans';
  shell.plans.replaceChildren(
    ...plans.map((p) =>
      h('div', { class: 'plan' },
        h('div', { class: 'e', 'aria-hidden': 'true' }, emojiArt(p.emoji)),
        h('div', { class: 't' }, p.title),
        h('div', { class: 's' }, `${fmtWhen(p.startAt)} · ${p.place.name}`),
        h('div', { class: 'chips' },
          p.together ? h('span', { class: 'chip warm' }, 'Together now ✨') : null,
          !p.together && p.friendNote ? h('span', { class: 'chip warm' }, p.friendNote) : null,
          p.mode === 'stranger' ? h('span', { class: 'chip' }, '🌱 Someone new') : null,
          p.place.map ? h('a', { class: 'chip', href: mapsUrl(p.place), target: '_blank', rel: 'noopener' }, 'Open in Maps') : null,
          p.mode === 'stranger' && p.friendId ? h('button', { class: 'chip chip-danger', type: 'button', onclick: () => blockFromPlan(p) }, 'Block & report') : null,
        ),
      ),
    ),
  );
  if (!plans.length && homeView === 'plans') shell.plans.append(
    h('div', { class: 'calm empty-plans' }, catImage(), h('h2', {}, 'Room for something lovely.'),
      h('p', {}, 'When you both say yes to a suggestion, your plan will appear right here.'),
      h('button', { class: 'btn yes', onclick: () => { selectHomeView('map'); setSheetOpen(true); } }, state.card ? 'See what Mochii has in mind' : 'Back to your neighbourhood')),
  );
}

setInterval(() => state && shell && (renderPlans(), renderPeek()), 30000);

/* -------------------------------------------------------------------- sheet */

let sheetOpen = true;

function setSheetOpen(open) {
  sheetOpen = open;
  shell?.sheet.classList.toggle('collapsed', !open);
  if (!shell) return;
  shell.head.setAttribute('aria-expanded', String(open));
  if (!open && map && shell.body.contains(document.activeElement)) shell.head.focus();
  shell.body.inert = !!map && !open;
}

/** Drag the sheet's handle up or down (or tap it) to fold Mochii's card away and see the map. */
function setupSheet() {
  const { sheet, head } = shell;
  let drag = null;
  let dragged = false;
  head.addEventListener('pointerdown', (e) => {
    if (!map || e.button !== 0) return;
    dragged = false;
    const peek = parseFloat(getComputedStyle(sheet).getPropertyValue('--peek')) || head.offsetHeight;
    drag = { y: e.clientY, open: sheetOpen, range: sheet.offsetHeight - peek };
    head.setPointerCapture(e.pointerId);
    sheet.classList.add('dragging');
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const y = Math.max(0, Math.min(drag.range, (drag.open ? 0 : drag.range) + e.clientY - drag.y));
    sheet.style.transform = `translateY(${y}px)`;
  });
  const done = (e, cancelled) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    const { open } = drag;
    drag = null;
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
    dragged = cancelled || Math.abs(dy) >= 8;
    if (dragged) setSheetOpen(cancelled ? open : dy < 0);
  };
  head.addEventListener('pointerup', (e) => done(e, false));
  head.addEventListener('pointercancel', (e) => done(e, true));
  head.addEventListener('click', (e) => {
    if (!dragged || e.detail === 0) setSheetOpen(!sheetOpen);
    dragged = false;
  });
  // Reframe after the sheet changes height or the phone rotates, so pins stay above it.
  shell.resize = new ResizeObserver(() => map && frameMap(false));
  shell.resize.observe(sheet);
  sheet.addEventListener('transitionend', (e) => {
    if (e.target === sheet && e.propertyName === 'transform') frameMap(true);
  });
}

/* ---------------------------------------------------------------------- map */

// MapLibre + OpenFreeMap: free vector maps, no API key. Friends only appear as a rough ~1 km area if they chose
// to, or live while they're on their way to meet you; the server never sends anything more precise.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
let ml = null; // the MapLibre module, loaded in the background
let map = null;
let myPos = null;
let framedKeys = ''; // what was on the map the last time it was fitted to the screen
let areasReady = false; // the rough-area layer exists once the map style has loaded
let mapUnavailable = false;
let mapLoadTimer = null;
const markers = new Map(); // key -> { marker, sig }

async function loadMapLibrary() {
  try {
    ml = await import('/vendor/maplibre-gl/maplibre-gl.mjs');
    ml.setWorkerUrl('/vendor/maplibre-gl/maplibre-gl-worker.mjs');
  } catch {
    ml = null; // no map: Mochii works exactly as before
    mapUnavailable = true;
  }
  if (state && shell) render();
}

function ensureMap() {
  if (!ml || !shell || map || mapUnavailable) return;
  document.body.classList.add('has-map'); // the map needs its full-screen size before it starts
  try {
    map = new ml.Map({ container: shell.map, style: MAP_STYLE, center: [24.94, 60.17], zoom: 11, attributionControl: false });
  } catch {
    mapFallback(); // e.g. no WebGL on this device
    return;
  }
  const instance = map;
  // A blocked style, unavailable GPU or stalled network must not leave a blank map forever.
  mapLoadTimer = setTimeout(() => map === instance && mapFallback(), 15000);
  map.on('error', () => {
    if (map === instance && !areasReady && !map.getStyle()) mapFallback();
  });
  map.on('resize', () => frameMap(false));
  map.addControl(new ml.AttributionControl({ compact: true }), 'top-right');
  map.on('load', () => {
    if (map !== instance) return;
    clearTimeout(mapLoadTimer);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3e6b55';
    map.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'areas-fill', type: 'fill', source: 'areas', paint: { 'fill-color': accent, 'fill-opacity': 0.16 } });
    map.addLayer({ id: 'areas-line', type: 'line', source: 'areas', paint: { 'line-color': accent, 'line-opacity': 0.55, 'line-width': 1.5 } });
    areasReady = true;
    updateMap();
  });
  setSheetOpen(homeView === 'plans' || !!state.card);
}

function renderMapNotice() {
  if (!shell) return;
  shell.mapNotice.hidden = !mapUnavailable;
  if (!mapUnavailable) return;
  shell.mapNotice.replaceChildren(
    h('span', {}, 'The map is unavailable. Your questions and plans are still here.'),
    h('button', { class: 'btn quiet', type: 'button', onclick: async () => {
      mapUnavailable = false;
      if (!ml) await loadMapLibrary();
      if (state && shell) render();
    } }, 'Try map again'),
  );
}

function mapFallback() {
  mapUnavailable = true;
  removeMap({ keepPosition: true });
  shell?.map.replaceChildren();
  setSheetOpen(true);
  if (shell && state) {
    renderTop();
    renderMapNotice();
  }
}

function removeMap({ keepPosition = false } = {}) {
  clearTimeout(mapLoadTimer);
  markers.clear();
  map?.remove();
  map = null;
  framedKeys = '';
  areasReady = false;
  if (!keepPosition) myPos = null;
  document.body.classList.remove('has-map');
}

const initial = (name) => (name || '?').trim().charAt(0).toUpperCase();

/** A rough area as a circle polygon, so it scales with the map like a real ~1 km zone. */
function circle(lon, lat, metres) {
  const ring = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    ring.push([lon + (metres * Math.cos(a)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (metres * Math.sin(a)) / 110540]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

const pinEl = (emoji, mod) =>
  h('div', { class: `mk-pin ${mod}` }, h('div', { class: 'bubble' }, emojiArt(emoji), mod === 'together' ? h('i', { class: 'spark' }, '✨') : null), h('div', { class: 'tail' }));

/** Spread cats sharing one coarse location in screen pixels, never by inventing GPS coordinates. */
function catOffsets(friends) {
  const groups = new Map();
  const offsets = new Map();
  for (const f of friends) {
    if (f.kind !== 'area') continue;
    const key = `${f.lat}:${f.lon}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f.id);
  }
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.sort();
    const radius = Math.min(125, Math.max(58, ids.length * 20));
    ids.forEach((id, i) => {
      const angle = (i / ids.length) * 2 * Math.PI;
      offsets.set(id, [Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)]);
    });
  }
  return offsets;
}

function updateMap() {
  if (!map || !state) return;
  const m = state.map || {};
  const items = [];
  const me = myPos ?? m.me;
  if (me) items.push({ key: 'me', at: [me.lon, me.lat], sig: `me:${state.me.mood || ''}`, anchor: 'bottom', el: () => h('div', { class: 'mk-me', title: 'You' }, weatherCat(state.me.mood, '', 'You'), h('span', {}, 'You')) });
  const offsets = catOffsets(m.friends || []);
  for (const f of m.friends || []) {
    const weather = moodInfo(f.mood);
    items.push({
      key: `f:${f.id}:${f.kind}`, at: [f.lon, f.lat], sig: `${f.name}|${f.mood || ''}`, anchor: 'bottom', offset: offsets.get(f.id),
      el: () => h('div', { class: `mk-friend ${f.kind}` }, h('span', { class: 'av' }, weatherCat(f.mood, '', f.name), h('span', { class: 'avatar-initial' }, initial(f.name))), h('span', { class: 'nm' }, f.kind === 'live' ? `${f.name} · on the way` : f.name)),
      pop: () => h('div', { class: 'pop' }, h('b', {}, f.name),
        weather ? h('span', { class: 'mood-chip' }, pixelIcon(`/icons/weather/${weather.id}.png`), `${weather.name} · ${weather.feeling}`) : null,
        f.kind === 'live' ? `On the way to meet you 🚶` : 'Somewhere around here. Only a rough area, never the exact spot.'),
    });
  }
  for (const p of state.plans || []) {
    if (p.place.lat == null) continue;
    items.push({
      key: `p:${p.id}`, at: [p.place.lon, p.place.lat], sig: `${p.emoji}|${p.together}|${p.title}`, anchor: 'bottom',
      el: () => pinEl(p.emoji, p.together ? 'together' : 'plan'),
      pop: () => h('div', { class: 'pop' }, h('b', {}, p.title), `${fmtWhen(p.startAt)} · ${p.place.name}`,
        p.together ? h('span', { class: 'chip warm' }, 'Together now ✨') : null,
        p.place.map ? h('a', { href: mapsUrl(p.place), target: '_blank', rel: 'noopener' }, 'Open in Maps') : null),
    });
  }
  if (m.pin) {
    items.push({
      key: 'pin', at: [m.pin.lon, m.pin.lat], sig: `${m.pin.name}|${m.pin.emoji}`, anchor: 'bottom',
      el: () => pinEl(m.pin.emoji, 'suggested'),
      pop: () => h('div', { class: 'pop' }, h('b', {}, m.pin.name), 'Suggested by Mochii. Answer yes or no on the card.'),
    });
  }

  const keep = new Set();
  for (const it of items) {
    keep.add(it.key);
    const had = markers.get(it.key);
    if (had?.sig === it.sig) {
      had.marker.setLngLat(it.at);
      had.marker.setOffset(it.offset || [0, 0]);
      continue;
    }
    had?.marker.remove();
    const marker = new ml.Marker({ element: it.el(), anchor: it.anchor, offset: it.offset || [0, 0] }).setLngLat(it.at);
    if (it.pop) {
      const popup = new ml.Popup({ offset: 28, closeButton: false, maxWidth: '240px' });
      popup.on('open', () => popup.setDOMContent(it.pop())); // fresh "in 12 min" every time
      marker.setPopup(popup);
    }
    markers.set(it.key, { marker: marker.addTo(map), sig: it.sig });
  }
  for (const [key, v] of markers) {
    if (keep.has(key)) continue;
    v.marker.remove();
    markers.delete(key);
  }
  if (areasReady) {
    const areas = (m.friends || []).filter((f) => f.kind === 'area').map((f) => circle(f.lon, f.lat, f.radius));
    map.getSource('areas').setData({ type: 'FeatureCollection', features: areas });
  }
  // Something new on the map (a suggestion, a plan, a friend heading over)? Bring it into view.
  const keys = items.map((it) => `${it.key}:${it.key === 'pin' ? it.sig : ''}`).sort().join(' ');
  if (keys !== framedKeys) {
    const first = !framedKeys;
    framedKeys = keys;
    requestAnimationFrame(() => frameMap(!first)); // after the sheet has its new height
  }
}

/** Fit everything on screen in the part the sheet doesn't cover (also what ◎ does). */
function frameMap(animate) {
  if (!map || !shell) return;
  const points = [...markers.values()].map((v) => v.marker.getLngLat());
  if (!points.length) return;
  const height = shell.map.clientHeight;
  const width = shell.map.clientWidth;
  if (!width || !height) return;
  const covered = shell.sheet.classList.contains('collapsed')
    ? shell.head.offsetHeight : shell.sheet.offsetHeight;
  const navHeight = shell.nav?.offsetHeight || 0;
  const padding = {
    top: Math.min(210, height * 0.25), left: Math.min(54, width * 0.1), right: Math.min(54, width * 0.1),
    bottom: Math.max(0, Math.min(covered + navHeight + 24, height - Math.min(210, height * 0.25) - 70)),
  };
  // On wider screens the card sits at the right, so use the open map beside it.
  if (width >= 900) {
    padding.right = Math.min((shell.sheet.offsetWidth || 420) + 60, width * 0.55);
    padding.bottom = 50;
  }
  const duration = animate ? 600 : 0;
  if (points.length === 1) return map.easeTo({ center: points[0], zoom: 14, padding, duration });
  const bounds = new ml.LngLatBounds(points[0], points[0]);
  for (const p of points) bounds.extend(p);
  map.fitBounds(bounds, { padding, maxZoom: 15, duration });
}

/* ------------------------------------------------------------------- toasts */

function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  $toasts.append(t);
  setTimeout(() => t.remove(), 4300);
}

function showToasts() {
  for (const t of state.toasts || []) {
    if (shownToasts.has(t.id)) continue;
    shownToasts.add(t.id);
    toast(t.text);
  }
  sessionStorage.setItem('eden.toasts', JSON.stringify([...shownToasts].slice(-50)));
}

/* --------------------------------------------------------------------- menu */

function mountDialog(sheet, back, onClose) {
  closeDialog?.();
  const previous = document.activeElement;
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('tabindex', '-1');
  const close = () => {
    back.remove(); sheet.remove();
    $app.inert = false;
    document.removeEventListener('keydown', keys);
    closeDialog = null;
    if (previous?.isConnected) previous.focus();
    onClose?.();
  };
  const keys = (e) => {
    if (e.key === 'Escape') close();
    if (e.key !== 'Tab') return;
    const buttons = [...sheet.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), a[href], input:not([disabled]), select:not([disabled])')];
    const first = buttons[0], last = buttons.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  };
  back.addEventListener('click', close);
  sheet.prepend(h('button', { class: 'dialog-close icon-btn', 'aria-label': 'Close', onclick: close }, '×'));
  document.body.append(back, sheet);
  $app.inert = true;
  document.addEventListener('keydown', keys);
  closeDialog = close;
  sheet.focus();
}

let inviteBase = null;
async function getInviteBase() {
  if (inviteBase) return inviteBase;
  const r = await api('/api/info');
  inviteBase = r.data?.publicUrl || (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? r.data?.inviteBase : null) || location.origin;
  return inviteBase;
}

/** "Your people": your groups with their codes, start a group, join with a code, stranger mode. */
function openGroups() {
  const groups = state.groups || [];
  const friends = groups.filter((g) => g.kind === 'friends');
  const care = groups.filter((g) => g.kind === 'care');
  const status = h('p', { class: 'dialog-note', role: 'status' });
  const reopen = (data) => { setState(data); closeDialog?.(); openGroups(); };

  const nameInput = h('input', { class: 'invite-address', 'aria-label': 'Group name', placeholder: 'e.g. Sunday walkers', maxlength: 40, autocomplete: 'off' });
  const create = h('button', { class: 'btn yes', type: 'button', onclick: async () => {
    const name = nameInput.value.trim();
    if (!name) { status.textContent = 'Give your group a name first.'; nameInput.focus(); return; }
    create.disabled = true;
    const r = await api('/api/groups', { name });
    create.disabled = false;
    if (!r.ok) { status.textContent = r.data?.error || 'Could not start the group. Try again.'; return; }
    reopen(r.data);
    toast(`“${name}” is ready. Share its link or code to invite people.`);
  } }, 'Start a group');

  const codeInput = h('input', { class: 'invite-address code-input', 'aria-label': 'Invite code', placeholder: 'K7Q2-M9XT', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', maxlength: 80 });
  const join = h('button', { class: 'btn quiet', type: 'button', onclick: async () => {
    if (!codeInput.value.trim()) { status.textContent = 'Type the code your friend sent you.'; codeInput.focus(); return; }
    join.disabled = true;
    const ok = await joinWithCode(codeInput.value);
    join.disabled = false;
    if (ok) { closeDialog?.(); openGroups(); }
  } }, 'Join with a code');

  const sheet = h('section', { class: 'sheet groups-sheet', role: 'dialog', 'aria-label': 'Your people' },
    catImage(),
    h('span', { class: 'eyebrow' }, 'GOOD THINGS START WITH TWO'),
    h('h2', {}, 'Your people'),
    h('p', { class: 'groups-intro' }, 'Mochii only suggests plans with people in your groups, and only they can see your cat on the map.'),
    ...friends.map((g) => groupCard(g, reopen)),
    h('div', { class: 'group-form' }, h('b', {}, friends.length ? 'Start another group' : 'Start a group for your friends'), nameInput, create),
    h('div', { class: 'group-form' }, h('b', {}, 'Got a code from a friend?'), codeInput, join),
    ...care.map((g) => careCard(g, reopen)),
    strangerRow(),
    status,
  );
  mountDialog(sheet, h('div', { class: 'backdrop' }));
}

function groupCard(g, reopen) {
  const link = h('input', { class: 'invite-address', readonly: true, 'aria-label': `Invite link for ${g.name}`, value: `/join/${g.code}` });
  void getInviteBase().then((base) => { link.value = `${base}/join/${g.code}`; });
  const share = h('button', { class: 'btn yes', type: 'button', onclick: async () => {
    const url = link.value;
    const text = `Join “${g.name}” on Mochii, so we can make little plans together: ${url} (code ${g.code})`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Mochii', text, url }); return; } catch { /* closed the share sheet */ }
    }
    try { await navigator.clipboard.writeText(url); share.textContent = 'Link copied ✓'; }
    catch { link.select(); toast('Select and copy the link to share it.'); }
  } }, 'Share invite link');
  const act = (path, body, question) => async () => {
    if (question && !confirm(question)) return;
    const r = await api(path, body);
    if (r.ok) reopen(r.data);
    else toast(r.data?.error || 'That didn’t work. Try again.');
  };
  return h('article', { class: 'group-card', 'aria-label': g.name },
    h('div', { class: 'group-head' }, h('h3', {}, g.name), h('span', { class: 'group-size' }, `${g.size} ${g.size === 1 ? 'person' : 'people'}`)),
    g.fromStrangerMode ? h('p', { class: 'dialog-note' }, '🌱 You met in stranger mode.') : null,
    h('div', { class: 'member-chips' }, ...g.members.map((m) => h('span', { class: 'chip' },
      m.you ? `${m.name} (you)` : m.name,
      g.mine && !m.you ? h('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove ${m.name}`, onclick: act('/api/groups/remove', { groupId: g.id, userId: m.id }, `Remove ${m.name} from ${g.name}?`) }, '×') : null))),
    h('div', { class: 'group-code' }, h('span', {}, 'Invite code'), h('strong', {}, g.code)),
    link, share,
    h('div', { class: 'group-actions' },
      g.mine ? h('button', { class: 'btn quiet', type: 'button', onclick: act('/api/groups/code', { groupId: g.id }, 'Make a new code? The old code and link stop working.') }, 'New code') : null,
      h('button', { class: 'btn danger', type: 'button', onclick: act('/api/groups/leave', { groupId: g.id }, `Leave ${g.name}?`) }, 'Leave'),
    ),
  );
}

function careCard(g, reopen) {
  const staff = g.members.filter((m) => m.role === 'staff').map((m) => m.name);
  const shared = state.me.checkins?.share === true;
  return h('article', { class: 'group-card care-card', 'aria-label': g.name },
    h('div', { class: 'group-head' }, h('h3', {}, `🩺 ${g.name}`), h('span', { class: 'group-size' }, 'Care team')),
    h('p', { class: 'dialog-note' }, `Clinicians: ${staff.join(', ') || '—'}. They never see your friends, places or plans, and other patients never see you.`),
    h('p', { class: 'dialog-note' }, shared ? 'Your check-ins are shared with them. Stop any time from the menu (☰).' : 'Your check-ins are private. You decide in the menu (☰).'),
    h('div', { class: 'group-actions' },
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!confirm(`Leave ${g.name}? They will no longer see your check-ins.`)) return;
        const r = await api('/api/groups/leave', { groupId: g.id });
        if (r.ok) reopen(r.data);
      } }, 'Leave care team'),
    ),
  );
}

function strangerRow() {
  const s = state.me?.stranger || {};
  return h('div', { class: 'row stranger-row' },
    h('b', {}, '🌱 Stranger mode: '),
    s.on
      ? 'on. Mochii may introduce you to another adult who also said yes: coffee, a walk, the gym or studying, at a public place in daytime. They never see where you are.'
      : 'off. Turn it on to meet someone new nearby, one person at a time.',
    h('button', { class: 'btn quiet', type: 'button', onclick: () => toggleStranger(!s.on) }, s.on ? 'Turn stranger mode off' : 'Meet new people'),
  );
}

async function toggleStranger(on) {
  if (on && !state.me?.stranger?.adult && !confirm('Stranger mode is for adults. Are you 18 or older?')) return;
  const r = await api('/api/stranger', on ? { on: true, adult: true } : { on: false });
  if (!r.ok) return toast(r.data?.error || 'Could not change stranger mode. Try again.');
  closeDialog?.();
  stageKey = '';
  setState(r.data);
  toast(on ? 'Stranger mode is on 🌱 Mochii will introduce you when there’s a good match.' : 'Stranger mode is off. Only your groups now.');
}

async function blockFromPlan(p) {
  if (!confirm(`Block ${p.friend}? This plan is cancelled, you won't be matched again, and Mochii's team takes a look.`)) return;
  const r = await api('/api/block', { userId: p.friendId, report: true });
  if (r.ok) { setState(r.data); toast(`${p.friend} is blocked. Thank you for telling us.`); }
  else toast(r.data?.error || 'Could not block. Try again.');
}

/* -------------------------------------------------------- weekly availability */

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const clockTime = cell => `${String(Math.floor(cell / 2)).padStart(2, '0')}:${cell % 2 ? '30' : '00'}`;

function availabilitySummary(schedule) {
  if (!schedule?.enabled) return 'Flexible — no time filter';
  const hours = schedule.days.reduce((n, day) => n + day.length / 2, 0);
  return hours ? `${hours} hours available each week` : 'No times selected — new suggestions paused';
}

function openAvailability() {
  const userId = state.me.id;
  const saved = state.me.availability;
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let days = (saved?.days || WEEKDAYS.map(() => [])).map(day => new Set(day));
  let saving = false, active = true, drag = null;
  let focused = [0, 18];
  const cells = WEEKDAYS.map(() => []);
  const enabled = h('input', { type: 'checkbox', id: 'availability-enabled' });
  enabled.checked = saved?.enabled ?? true;
  const zone = h('select', { id: 'availability-zone', 'aria-label': 'Schedule time zone' });
  const zones = [...new Set([saved?.timeZone || deviceZone, deviceZone, 'UTC', ...(Intl.supportedValuesOf?.('timeZone') || [])])];
  for (const name of zones) zone.append(h('option', { value: name }, name.replaceAll('_', ' ')));
  zone.value = saved?.timeZone || deviceZone;
  const summary = h('p', { class: 'availability-summary', role: 'status', 'aria-live': 'polite' });
  const error = h('p', { class: 'availability-error', role: 'alert' });
  const grid = h('table', { class: 'availability-grid', role: 'grid', 'aria-label': 'Weekly availability in 30-minute blocks', 'aria-describedby': 'availability-help' });
  grid.append(h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Time'),
    ...WEEKDAYS.map(day => h('th', { scope: 'col', abbr: day }, day.slice(0, 3))))));
  const body = h('tbody');
  const focusCell = (day, cell) => {
    cells[focused[0]][focused[1]].tabIndex = -1;
    focused = [day, cell];
    cells[day][cell].tabIndex = 0;
    cells[day][cell].focus({ preventScroll: true });
  };
  const refresh = () => {
    for (let day = 0; day < 7; day++) for (let cell = 0; cell < 48; cell++) {
      const selected = days[day].has(cell);
      cells[day][cell].setAttribute('aria-pressed', String(selected));
      cells[day][cell].textContent = selected ? '✓' : '';
    }
    const count = days.reduce((n, day) => n + day.size, 0);
    summary.textContent = !enabled.checked ? 'Flexible: Mochii can suggest plans outside the highlighted times.'
      : count ? `${count / 2} hours selected · repeats every week`
        : 'No times selected. New suggestions will pause until you add a time.';
    grid.classList.toggle('filter-off', !enabled.checked);
  };
  const toggle = (day, cell) => {
    if (saving) return;
    days[day].has(cell) ? days[day].delete(cell) : days[day].add(cell);
    focusCell(day, cell);
    refresh();
  };
  for (let cell = 0; cell < 48; cell++) {
    const row = h('tr', { class: cell % 2 ? 'half-hour' : 'hour' }, h('th', { scope: 'row' }, clockTime(cell)));
    for (let day = 0; day < 7; day++) {
      const button = h('button', {
        type: 'button', class: 'availability-cell', 'data-day': day, 'data-cell': cell,
        tabindex: day === focused[0] && cell === focused[1] ? '0' : '-1',
        'aria-label': `${WEEKDAYS[day]} ${clockTime(cell)} to ${clockTime(cell + 1)}`,
        onclick: e => { if (e.detail === 0) toggle(day, cell); }, // keyboard / assistive technology
        onkeydown: e => {
          const moves = { ArrowUp: [day, Math.max(0, cell - 1)], ArrowDown: [day, Math.min(47, cell + 1)],
            ArrowLeft: [Math.max(0, day - 1), cell], ArrowRight: [Math.min(6, day + 1), cell], Home: [0, cell], End: [6, cell] };
          if (!moves[e.key]) return;
          e.preventDefault();
          focusCell(...moves[e.key]);
          cells[focused[0]][focused[1]].scrollIntoView({ block: 'nearest' });
        },
      });
      cells[day][cell] = button;
      row.append(h('td', {}, button));
    }
    body.append(row);
  }
  grid.append(body);
  const paint = (day, cell) => {
    days = drag.before.map(set => new Set(set));
    for (let d = Math.min(day, drag.day); d <= Math.max(day, drag.day); d++) {
      for (let c = Math.min(cell, drag.cell); c <= Math.max(cell, drag.cell); c++) {
        drag.add ? days[d].add(c) : days[d].delete(c);
      }
    }
    refresh();
  };
  grid.addEventListener('pointerdown', e => {
    const button = e.target.closest('.availability-cell');
    if (!button || e.button !== 0 || saving || drag) return;
    e.preventDefault();
    const day = Number(button.dataset.day), cell = Number(button.dataset.cell);
    drag = { day, cell, add: !days[day].has(cell), before: days.map(set => new Set(set)), id: e.pointerId };
    focusCell(day, cell);
    grid.setPointerCapture(e.pointerId);
    paint(day, cell);
  });
  grid.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    const button = document.elementFromPoint(e.clientX, e.clientY)?.closest('.availability-cell');
    if (button && grid.contains(button)) paint(Number(button.dataset.day), Number(button.dataset.cell));
  });
  grid.addEventListener('pointerup', e => {
    if (drag?.id !== e.pointerId) return;
    drag = null;
    grid.releasePointerCapture(e.pointerId);
  });
  grid.addEventListener('pointercancel', () => {
    if (drag) { days = drag.before; drag = null; refresh(); }
  });
  grid.addEventListener('lostpointercapture', () => { drag = null; });
  enabled.addEventListener('change', refresh);
  const all = h('button', { type: 'button', class: 'btn quiet', onclick: () => { days = WEEKDAYS.map(() => new Set(Array.from({ length: 48 }, (_, i) => i))); refresh(); } }, 'Select all');
  const clear = h('button', { type: 'button', class: 'btn quiet', onclick: () => { days = WEEKDAYS.map(() => new Set()); refresh(); } }, 'Clear');
  const viewport = h('div', { class: 'availability-scroll' }, grid);
  const save = h('button', { type: 'button', class: 'btn yes', onclick: async () => {
    if (saving) return;
    saving = true;
    for (const control of [save, enabled, zone, all, clear, ...cells.flat()]) control.disabled = true;
    save.textContent = 'Saving…';
    error.textContent = '';
    const r = await api('/api/availability', { enabled: enabled.checked, timeZone: zone.value, days: days.map(day => [...day].sort((a, b) => a - b)) });
    if (!active || state?.me.id !== userId) return;
    if (r.ok) {
      setState(r.data);
      closeDialog?.();
      toast('Your meeting times are saved.');
    } else {
      saving = false;
      for (const control of [save, enabled, zone, all, clear, ...cells.flat()]) control.disabled = false;
      save.textContent = 'Save availability';
      error.textContent = r.data?.error || 'Could not save. Your changes are still here — try again.';
    }
  } }, 'Save availability');
  const sheet = h('div', { class: 'sheet availability-sheet', role: 'dialog', 'aria-labelledby': 'availability-title' },
    h('span', { class: 'eyebrow' }, 'A LITTLE TIME TOGETHER'),
    h('h2', { id: 'availability-title' }, 'When are you free?'),
    h('p', { id: 'availability-help', class: 'availability-help' }, 'Drag across the week or tap a block. Each block is 30 minutes. Use arrow keys to move and Space to select.'),
    h('label', { class: 'availability-toggle', for: 'availability-enabled' }, enabled, 'Only suggest plans during my selected times'),
    h('div', { class: 'availability-toolbar' }, h('label', { for: 'availability-zone' }, 'Time zone', zone), h('div', { class: 'availability-tools' }, all, clear)),
    h('div', { class: 'availability-legend' }, h('span', {}, h('i', { class: 'selected' }), 'Ready to meet'), h('span', {}, h('i'), 'Unavailable')),
    viewport,
    h('p', { class: 'availability-touch-tip' }, 'On a phone, slide the Time column to scroll.'),
    summary,
    h('p', { class: 'availability-note' }, 'Mochii finds a shared time that fits the whole activity. Your weekly schedule is private. Confirmed plans stay as agreed.'),
    error,
    h('div', { class: 'availability-actions' }, h('button', { type: 'button', class: 'btn no', onclick: () => closeDialog?.() }, 'Cancel'), save),
  );
  refresh();
  mountDialog(sheet, h('div', { class: 'backdrop' }), () => { active = false; drag = null; });
  viewport.scrollTop = 12 * 26; // open at 06:00; every hour of the day remains selectable
}

function openMenu() {
  const close = () => closeDialog?.();
  const geoOn = localStorage.getItem('eden.geo') === 'on';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const permission = window.Notification?.permission;
  let pushText;
  if (state.me.hasPush) pushText = 'On. Mochii taps you when a plan needs a yes or no, even when the app is closed.';
  else if (swReg && isApple && !standalone) pushText = 'To get nudges when Mochii is closed: tap Share → "Add to Home Screen", then open Mochii from your Home Screen.';
  else if (swReg && permission === 'granted') pushText = 'On while Mochii is open, even in the background.';
  else if (swReg) pushText = 'Off. Mochii only shows things while it\'s open.';
  else pushText = 'Mochii shows things while it\'s open. Nudges when it\'s closed need a trusted https address (ask the server operator).';
  const ci = state.me.checkins || {};
  const when = (t) => {
    const d = Math.round((Date.now() - t) / 864e5);
    return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  };
  let checkinText;
  if (ci.on !== true) checkinText = 'Off. A short check-in every two weeks helps Mochii notice what you need.';
  else {
    checkinText = `Every two weeks${ci.lastAt ? `, last one ${when(ci.lastAt)}` : ''}. `;
    const teams = (state.groups || []).filter((g) => g.kind === 'care').map((g) => g.name);
    checkinText += ci.share && teams.length ? `Shared with ${teams.join(' and ')}: only your answers and how often you met up.`
      : teams.length ? 'Private: only Mochii uses it.' : 'Private: only Mochii uses it. To share with a clinic, join their care team with their code.';
  }
  const checkins = async (body) => {
    close();
    const r = await api('/api/checkins', body);
    if (r.ok) setState(r.data);
  };
  const canTurnOn = swReg && permission && permission !== 'granted' && !(isApple && !standalone);
  const turnOn = async () => {
    close();
    if (permission === 'denied') return toast('Notifications are blocked for Mochii. You can allow them in your browser settings.');
    await enablePush();
    if (window.Notification.permission === 'granted') toast('Nudges on. Mochii will tap you when a plan needs a yes or no.');
  };

  const back = h('div', { class: 'backdrop' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Menu' },
    catImage('profile-cat'),
    h('span', { class: 'eyebrow' }, 'YOUR SPACE, YOUR PACE'),
    h('h2', {}, `Hi, ${state.me.name}`),
    h('div', { class: 'row' }, h('b', {}, '🗓️ Ready to meet: '), availabilitySummary(state.me.availability)),
    h('button', { class: 'btn quiet', onclick: openAvailability }, 'Set my availability'),
    h('div', { class: 'row' }, h('b', {}, '📍 Location: '), geoOn ? 'on. Mochii uses your location for your map and nearby plans. Your map sharing is controlled below.' : 'off. Allow location to place your cat on the map and find nearby plans.'),
    !geoOn ? h('button', { class: 'btn quiet', onclick: () => openLocationPrompt(true) }, 'Turn location on') : null,
    h('div', { class: 'row' }, h('b', {}, '🗺️ On the map: '),
      state.map?.showArea ? 'friends see roughly where you are (about 1 km), never your exact spot.' : "hidden from friends. They only see where you'll meet for plans.",
      ' When you tap "On my way", the friend you\'re meeting sees you until you arrive.',
    ),
    h('button', {
      class: 'btn quiet',
      onclick: async () => {
        close();
        if (!state.map?.showArea && localStorage.getItem('eden.geo') !== 'on') openLocationPrompt(true);
        const r = await api('/api/map', { showArea: !state.map?.showArea });
        if (r.ok) setState(r.data);
      },
    }, state.map?.showArea ? 'Hide my rough area' : 'Show friends my rough area'),
    h('button', { class: 'btn quiet', onclick: () => { close(); openGroups(); } }, `👥 Your groups (${(state.groups || []).filter((g) => g.kind === 'friends').length})`),
    strangerRow(),
    h('div', { class: 'row' }, h('b', {}, '🔔 Nudges: '), pushText),
    canTurnOn ? h('button', { class: 'btn quiet', onclick: turnOn }, 'Turn nudges on') : null,
    h('div', { class: 'row' }, h('b', {}, '📋 Check-ins: '), checkinText),
    ci.on !== true ? h('button', { class: 'btn quiet', onclick: () => checkins({ on: true }) }, 'Start check-ins') : null,
    ci.on === true && !ci.inProgress ? h('button', { class: 'btn quiet', onclick: () => checkins({ start: true }) }, 'Do a check-in now') : null,
    ci.on === true && (state.groups || []).some((g) => g.kind === 'care')
      ? h('button', { class: 'btn quiet', onclick: () => checkins({ share: !ci.share }) }, ci.share ? 'Stop sharing with my care team' : 'Share with my care team')
      : null,
    ci.on === true ? h('button', { class: 'btn quiet', onclick: () => checkins({ on: false }) }, 'Stop check-ins') : null,
    state.me.paused
      ? h('button', { class: 'btn quiet', onclick: () => (pause(0), close()) }, "I'm back")
      : h('button', { class: 'btn quiet', onclick: () => (pause(3), close()) }, 'Take a break for 3 days'),
    h('button', { class: 'btn quiet', onclick: async () => { close(); await api('/api/logout', {}); signedOut(); } }, 'Log out'),
    h('button', {
      class: 'btn danger',
      onclick: async () => {
        if (!confirm('Delete your account and everything Mochii knows about you? This can\'t be undone.')) return;
        close();
        await api('/api/delete-account', {});
        localStorage.removeItem('eden.geo');
        signedOut();
      },
    }, 'Delete my account'),
    h('div', { class: 'row' },
      h('b', {}, '🆘 Need to talk to someone now? '),
      'MIELI Crisis Helpline ', h('a', { href: 'tel:+358925250111' }, '09 2525 0111'), ' (24/7). In an emergency, call ', h('a', { href: 'tel:112' }, '112'), '.',
    ),
    h('div', { class: 'row' }, 'Only people in your groups can see your cat. No feeds, no chat, no streaks.'),
  );
  mountDialog(sheet, back);
}

async function pause(days) {
  const r = await api('/api/pause', { days });
  if (r.ok) {
    stageKey = '';
    setState(r.data);
  }
}

/* --------------------------------------------------------------------- auth */

function renderAuth() {
  shell?.resize?.disconnect();
  removeMap();
  lastSent = null;
  document.body.classList.remove('home');
  shell = null;
  homeView = 'map';
  stageKey = '';
  const signup = authMode === 'signup';
  const err = h('p', { class: 'error', role: 'alert' });
  const field = (label, attrs) => h('div', { class: 'field' }, h('label', { for: attrs.id }, label), h('input', attrs));
  const banner = h('div', { class: 'invite-banner', hidden: true, role: 'status' });
  if (pendingCode) void api(`/api/invite/${encodeURIComponent(pendingCode)}`).then((r) => {
    if (!banner.isConnected) return;
    banner.hidden = false;
    banner.textContent = r.ok
      ? `🐾 ${r.data.by ? `${r.data.by} invited you to` : 'You’re invited to'} “${r.data.name}”. ${signup ? 'Create an account' : 'Log in'} and you’re in.`
      : 'That invite link didn’t work. You can still sign up and ask your friend for a new code.';
    if (!r.ok) clearInvite();
  });
  const form = h('form', { class: 'auth', novalidate: true },
    h('span', { class: 'eyebrow' }, signup ? 'YOUR PEOPLE ARE THE POINT' : 'MAKE YOURSELF AT HOME'),
    h('h2', {}, signup ? 'A little closer starts here.' : 'Welcome back, friend.'),
    h('p', { class: 'form-intro' }, signup ? 'Make a little space for the people you love.' : 'Your people, your plans, and a little cat. All right here.'),
    banner,
    signup ? field('Your first name', { id: 'name', name: 'name', autocomplete: 'given-name', required: true, maxlength: 30 }) : null,
    field('Username', { id: 'username', name: 'username', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true }),
    field('Password', { id: 'password', name: 'password', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: true, minlength: signup ? 8 : null, placeholder: signup ? 'At least 8 characters' : null }),
    err,
    h('button', { class: 'btn yes', type: 'submit' }, signup ? 'Find my people  →' : 'Come on in  →'),
    h('div', { class: 'switch' },
      h('button', { class: 'btn quiet', type: 'button', onclick: () => ((authMode = signup ? 'login' : 'signup'), renderAuth()) },
        signup ? 'I already have an account' : 'Create a new account'),
    ),
    h('ul', { class: 'promise' },
      h('li', {}, '♡  A little connection. Zero pressure.'),
      h('li', {}, '🔒  You choose what you share.'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const data = Object.fromEntries(new FormData(form));
    if (pendingCode) data.code = pendingCode;
    const r = await api(signup ? '/api/signup' : '/api/login', data);
    btn.disabled = false;
    if (!r.ok) {
      err.textContent = r.data?.error || 'Something went wrong. Try again?';
      return;
    }
    const invited = pendingCode && !r.data.joinError ? (r.data.groups || []).at(-1) : null;
    clearInvite();
    signedIn(r.data);
    if (r.data.joinError) toast(r.data.joinError);
    else if (invited) toast(`You're in “${invited.name}” 🐾 Mochii will suggest little plans together.`);
  });
  const story = h('section', { class: 'auth-story' },
    h('span', { class: 'story-pill' }, 'LESS SCROLLING. MORE LIVING.'),
    h('h1', {}, 'Social media that is ', h('em', {}, 'actually social.')),
    h('p', { class: 'story-copy' }, 'A coffee. A walk. A familiar face. Mochii turns the little “we should” moments into time together.'),
    h('img', { class: 'together-art', src: '/icons/together.png', alt: 'Two cozy cats sharing a coffee in the park', width: '600', height: '360' }),
    h('div', { class: 'story-tags' }, h('span', {}, '🐾 Your kind of company'), h('span', {}, '☕ Real little plans'), h('span', {}, '♡ At your own pace')),
  );
  $app.replaceChildren(
    h('header', { class: 'auth-top' }, brand(), h('span', { class: 'auth-top-note' }, 'Made for moments together.')),
    h('div', { class: 'auth-layout' }, story, h('section', { class: 'auth-card' }, form)),
    h('footer', { class: 'auth-footer' }, 'Small plans. Soft landings. Good company.'),
  );
  document.title = 'Mochii';
}

void boot();
