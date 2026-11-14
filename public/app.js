// Eden phone app. Eden asks; you answer yes or no. That's the whole interface.
const $app = document.getElementById('app');
const $toasts = document.getElementById('toasts');

let state = null;
let stream = null;
let swReg = null;
let shell = null;
let stageKey = '';
let busy = false;
let authMode = 'signup';
let watchId = null;
let lastSent = null;
let knownWaiting = null; // plan questions already seen here, so each one nudges once
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
    return { ok: false, status: 0, data: { error: "Can't reach Eden. Is the host computer on and on the same Wi-Fi?" } };
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

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
  await registerServiceWorker();
  const r = await api('/api/state');
  if (r.ok && r.data) {
    signedIn(r.data);
  } else {
    renderAuth();
  }
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
  const push = !!swReg && 'PushManager' in window && 'Notification' in window;
  let geo = 'geolocation' in navigator ? 'prompt' : 'unsupported';
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (p) geo = p.state;
  } catch {
    // Safari < 16
  }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  await api('/api/caps', { push, geo, standalone });
  if (geo === 'granted' || localStorage.getItem('eden.geo') === 'on') startLocation();
}

/* ------------------------------------------------------------ live updates */

function connect() {
  stream?.close();
  stream = new EventSource('/api/stream');
  stream.addEventListener('state', (e) => setState(JSON.parse(e.data)));
  stream.onerror = async () => {
    const r = await api('/api/state');
    if (r.status === 401) signedOut();
  };
}

function signedOut() {
  stream?.close();
  stream = null;
  stopLocation();
  state = null;
  knownWaiting = null;
  void clearNudges(() => true);
  navigator.clearAppBadge?.()?.catch(() => {});
  renderAuth();
}

function setState(next) {
  if (!next) return;
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
  if (lastSent && now - lastSent.t < 15000) {
    const dLat = (lat - lastSent.lat) * 111e3;
    const dLon = (lon - lastSent.lon) * 111e3 * Math.cos((lat * Math.PI) / 180);
    if (Math.hypot(dLat, dLon) < 30) return;
  }
  lastSent = { lat, lon, t: now };
  void api('/api/location', { lat, lon, acc });
}

function onGeoError(err) {
  if (err?.code === 1) {
    localStorage.setItem('eden.geo', 'off');
    stopLocation();
    void api('/api/caps', { geo: 'denied' });
    toast('Location is off. Eden can still suggest things, just less nearby.');
  }
}

function askLocation() {
  if (!('geolocation' in navigator)) return;
  localStorage.setItem('eden.geo', 'on');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      postPosition(pos);
      startLocation();
    },
    onGeoError,
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
  );
}

function startLocation() {
  if (!('geolocation' in navigator) || watchId != null) return;
  watchId = navigator.geolocation.watchPosition(postPosition, onGeoError, { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 });
}

function stopLocation() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
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
    // no push service here; nudges still work while Eden is open in the background
  }
}

/**
 * Every plan question gets a notification with its own yes/no. Push sends it when Eden is closed;
 * while Eden is open in the background, the page asks for it itself (same tag, so never twice).
 * Looking at Eden, or answering anywhere, clears them.
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
    shell = {
      top: h('header', { class: 'top' }),
      stage: h('section', { class: 'stage', 'aria-live': 'polite' }),
      label: h('p', { class: 'section-label' }),
      plans: h('div', { class: 'plans' }),
    };
    $app.replaceChildren(shell.top, shell.stage, shell.label, shell.plans);
    stageKey = '';
  }
  renderTop();
  renderStage();
  renderPlans();
  showToasts();
  document.title = state.card ? '(1) Eden' : 'Eden';
}

function renderTop() {
  shell.top.replaceChildren(
    h('div', { class: 'brand' }, h('img', { src: '/icons/icon.svg', alt: '' }), 'Eden'),
    h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: openMenu }, '☰'),
  );
}

function renderStage() {
  const c = state.card;
  const paused = state.me.paused;
  const key = c ? `card:${c.id}` : paused ? 'paused' : `empty:${state.people > 1}`;
  if (key === stageKey) return;
  stageKey = key;
  if (c) return shell.stage.replaceChildren(cardView(c));
  if (paused) {
    return shell.stage.replaceChildren(
      h('div', { class: 'calm' },
        h('div', { class: 'leaf' }, '🌙'),
        h('h2', {}, 'Eden is giving you some space.'),
        h('p', {}, `Back on ${new Date(paused).toLocaleDateString([], { weekday: 'long' })}. Nothing to do until then.`),
        h('button', { class: 'btn quiet', onclick: () => pause(0) }, "I'm back"),
      ),
    );
  }
  shell.stage.replaceChildren(
    h('div', { class: 'calm' },
      h('div', { class: 'leaf' }, '🌿'),
      state.people > 1
        ? [h('h2', {}, 'Nothing to decide right now.'), h('p', {}, `Eden will ask when there's something good to do with your people.${state.me.hasPush ? " It'll tap you on the shoulder." : ' You can leave this open.'}`)]
        : [h('h2', {}, "You're the first one here."), h('p', {}, 'Eden starts suggesting things as soon as someone else joins. Share this address with a friend.')],
    ),
  );
}

function cardView(c) {
  const el = h('article', { class: 'card', 'aria-label': c.title });
  const lines = (c.lines || []).map((l) => {
    if (l.when) return h('li', {}, h('span', { class: 'i' }, l.icon || '🕒'), fmtWhen(l.when));
    if (l.map) return h('li', {}, h('span', { class: 'i' }, l.icon || '🗺️'), h('a', { class: 'map', href: mapsUrl(l.map), target: '_blank', rel: 'noopener' }, 'Open in Maps'));
    if (l.tel) return h('li', {}, h('span', { class: 'i' }, l.icon || '📞'), h('a', { class: 'map', href: `tel:${l.tel}` }, l.text));
    return h('li', {}, h('span', { class: 'i' }, l.icon || '•'), l.text);
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
      h('div', { class: 'from' }, c.progress || 'Eden asks'),
      c.emoji ? h('div', { class: 'emoji', 'aria-hidden': 'true' }, c.emoji) : null,
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
  busy = true;
  // Browser permission prompts have to start inside the tap.
  if (yes && card.action === 'location') askLocation();
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
  shell.label.textContent = plans.length ? 'Coming up' : '';
  shell.label.hidden = !plans.length;
  shell.plans.replaceChildren(
    ...plans.map((p) =>
      h('div', { class: 'plan' },
        h('div', { class: 'e', 'aria-hidden': 'true' }, p.emoji),
        h('div', { class: 't' }, p.title),
        h('div', { class: 's' }, `${fmtWhen(p.startAt)} · ${p.place.name}`),
        h('div', { class: 'chips' },
          p.together ? h('span', { class: 'chip warm' }, 'Together now ✨') : null,
          !p.together && p.friendNote ? h('span', { class: 'chip warm' }, p.friendNote) : null,
          p.place.map ? h('a', { class: 'chip', href: mapsUrl(p.place), target: '_blank', rel: 'noopener' }, 'Open in Maps') : null,
        ),
      ),
    ),
  );
}

setInterval(() => state && shell && renderPlans(), 30000);

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

function openMenu() {
  const close = () => {
    back.remove();
    sheet.remove();
  };
  const geoOn = localStorage.getItem('eden.geo') === 'on';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const permission = window.Notification?.permission;
  let pushText;
  if (state.me.hasPush) pushText = 'On. Eden taps you when a plan needs a yes or no, even when the app is closed.';
  else if (swReg && isApple && !standalone) pushText = 'To get nudges when Eden is closed: tap Share → "Add to Home Screen", then open Eden from your Home Screen.';
  else if (swReg && permission === 'granted') pushText = 'On while Eden is open, even in the background.';
  else if (swReg) pushText = 'Off. Eden only shows things while it\'s open.';
  else pushText = 'Eden shows things while it\'s open. Nudges when it\'s closed need a trusted https address (ask your host).';
  const ci = state.me.checkins || {};
  const when = (t) => {
    const d = Math.round((Date.now() - t) / 864e5);
    return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  };
  let checkinText;
  if (ci.on !== true) checkinText = 'Off. A short check-in every two weeks helps Eden notice what you need.';
  else {
    checkinText = `Every two weeks${ci.lastAt ? `, last one ${when(ci.lastAt)}` : ''}. `;
    checkinText += ci.share ? 'Shared with your care team: only your answers and how often you met up.' : 'Private: only Eden uses it.';
  }
  const checkins = async (body) => {
    close();
    const r = await api('/api/checkins', body);
    if (r.ok) setState(r.data);
  };
  const canTurnOn = swReg && permission && permission !== 'granted' && !(isApple && !standalone);
  const turnOn = async () => {
    close();
    if (permission === 'denied') return toast('Notifications are blocked for Eden. You can allow them in your browser settings.');
    await enablePush();
    if (window.Notification.permission === 'granted') toast('Nudges on. Eden will tap you when a plan needs a yes or no.');
  };

  const back = h('div', { class: 'backdrop', onclick: () => close() });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Menu' },
    h('div', { class: 'grab' }),
    h('h2', {}, `Hi, ${state.me.name}`),
    h('div', { class: 'row' }, h('b', {}, '📍 Location: '), geoOn ? 'on. Others only see roughly how far away you are.' : 'off. Eden can still suggest things, just less nearby.'),
    !geoOn ? h('button', { class: 'btn quiet', onclick: () => (askLocation(), close()) }, 'Turn location on') : null,
    h('div', { class: 'row' }, h('b', {}, '🔔 Nudges: '), pushText),
    canTurnOn ? h('button', { class: 'btn quiet', onclick: turnOn }, 'Turn nudges on') : null,
    h('div', { class: 'row' }, h('b', {}, '📋 Check-ins: '), checkinText),
    ci.on !== true ? h('button', { class: 'btn quiet', onclick: () => checkins({ on: true }) }, 'Start check-ins') : null,
    ci.on === true && !ci.inProgress ? h('button', { class: 'btn quiet', onclick: () => checkins({ start: true }) }, 'Do a check-in now') : null,
    ci.on === true
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
        if (!confirm('Delete your account and everything Eden knows about you? This can\'t be undone.')) return;
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
    h('div', { class: 'row' }, 'Everything is stored on your host\'s computer. No feeds, no chat, no streaks.'),
  );
  document.body.append(back, sheet);
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
  shell = null;
  stageKey = '';
  const signup = authMode === 'signup';
  const err = h('p', { class: 'error', role: 'alert' });
  const field = (label, attrs) => h('div', { class: 'field' }, h('label', { for: attrs.id }, label), h('input', attrs));
  const form = h('form', { class: 'auth', novalidate: true },
    h('div', { class: 'hero' },
      h('img', { src: '/icons/icon.svg', alt: '' }),
      h('h1', {}, 'Eden'),
      h('p', { class: 'tag' }, 'Eden suggests things to do with your people. You just say yes or no.'),
    ),
    signup ? field('Your first name', { id: 'name', name: 'name', autocomplete: 'given-name', required: true, maxlength: 30 }) : null,
    field('Username', { id: 'username', name: 'username', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true }),
    field('Password', { id: 'password', name: 'password', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: true }),
    err,
    h('button', { class: 'btn yes', type: 'submit' }, signup ? 'Create my account' : 'Log in'),
    h('div', { class: 'switch' },
      h('button', { class: 'btn quiet', type: 'button', onclick: () => ((authMode = signup ? 'login' : 'signup'), renderAuth()) },
        signup ? 'I already have an account' : 'Create a new account'),
    ),
    h('ul', { class: 'promise' },
      h('li', {}, '• No feeds, no chat, no streaks.'),
      h('li', {}, '• Nothing is shared unless you say yes.'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const data = Object.fromEntries(new FormData(form));
    const r = await api(signup ? '/api/signup' : '/api/login', data);
    btn.disabled = false;
    if (!r.ok) {
      err.textContent = r.data?.error || 'Something went wrong. Try again?';
      return;
    }
    signedIn(r.data);
  });
  $app.replaceChildren(form);
  document.title = 'Eden';
}

void boot();
