// Mochii's engine: Mochii takes the first step, people only answer yes or no.
//
//  - It asks a few yes/no questions to learn what someone likes (and keeps learning from every answer).
//  - It pairs people, picks an activity both are likely to enjoy, a time and a real place between them,
//    and asks BOTH the same question at the same time. Nobody is "the one being looked after".
//  - If anyone says no, the other person never hears a "no". Mochii quietly finds another way.
//  - It reminds, notices via GPS when people actually met, and asks afterwards whether it felt good.
//  - On quieter stretches (lots of "no", not getting out, days without company) it suggests smaller,
//    closer, lower-effort things and asks less often.
//  - With the person's yes, a short validated check-in every two weeks (questionnaires.js) tells Mochii how they've
//    really been. A worrying one makes suggestions gentler; sharing it with a care team is a separate yes.
//  - It only ever pairs people who share a friend group, or two people who both turned on stranger mode (18+, public
//    places in daytime, no homes, no live location, a safety question afterwards).
import { ACTIVITIES, byId, SLOTS, TIME_QUESTIONS } from './activities.js';
import { DEFAULT_ZONE, fitsAvailability, localTime, normalizeAvailability } from './availability.js';
import {
  allGroups, allReports, block, blocked, connected, createPairGroup, friendIdsOf, groupsFor, groupsOf, removeUserFromGroups,
} from './circles.js';
import { away, distance, fromYou, jitter, midpoint, roughly } from './geo.js';
import { findPlace, prefetch } from './places.js';
import { notify } from './push.js';
import { CUT, INSTRUMENTS, needsSupport, score, SURVEY, SURVEY_LENGTH } from './questionnaires.js';
import { newId } from './security.js';
import { db, log, save } from './store.js';

export const config = { demo: false };

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function T() {
  return config.demo
    ? { tick: 4e3, proposalGap: 40e3, startIn: 10 * MIN, length: 10 * MIN, remindBefore: 5 * MIN, cardTtl: 8 * MIN, prefGap: 20e3, hours: [0, 24],
        surveyGap: 30 * MIN, surveyTtl: 20 * MIN, surveyRetry: 10 * MIN }
    : { tick: 30e3, proposalGap: 8 * HOUR, startIn: null, length: null, remindBefore: 45 * MIN, cardTtl: 6 * HOUR, prefGap: 3 * HOUR, hours: [9, 20],
        surveyGap: 14 * DAY, surveyTtl: 3 * DAY, surveyRetry: 2 * DAY };
}

/* ---------------------------------------------------------------- live updates */

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);

function changed(...ids) {
  save();
  for (const id of new Set(ids)) {
    // A revision per person, so a phone can tell a late, older snapshot from a newer one and ignore it.
    if (db.users[id]) db.users[id].rev = (db.users[id].rev || 0) + 1;
    for (const fn of listeners) fn(id);
  }
}

function toast(userId, text) {
  const u = db.users[userId];
  if (!u) return;
  u.toasts = [...(u.toasts || []), { id: newId(), text, at: Date.now() }].slice(-6);
  changed(userId);
}

/* -------------------------------------------------------------------- learning */

const prior = () => ({ a: 1, b: 1 });
const beta = (map, key) => (map[key] ??= prior());
const mean = (p) => p.a / (p.a + p.b);

function bump(map, key, yes, weight = 1) {
  const p = beta(map, key);
  if (yes) p.a += weight;
  else p.b += weight;
}

function randn() {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, Math.random()))) * Math.cos(2 * Math.PI * Math.random());
}

function gamma(k) {
  if (k < 1) return gamma(k + 1) * Math.random() ** (1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Thompson sampling: a plausible "how likely is a yes" given everything learned so far. */
function sample(p) {
  const x = gamma(p.a);
  const y = gamma(p.b);
  return x / (x + y);
}

const pairKey = (a, b) => [a, b].sort().join('|');
const pairOf = (a, b) => (db.pairs[pairKey(a, b)] ??= { a: 1, b: 1, together: 0, last: 0 });

/* ----------------------------------------------------------------------- users */

export function createUser({ name, username, pass }) {
  const u = {
    id: newId(),
    name,
    username,
    pass,
    createdAt: Date.now(),
    prefs: {},
    times: {},
    availability: null,
    canHost: null,
    loc: null,
    home: null,
    samples: [],
    asked: { location: false, notify: false, host: false, survey: false, strangers: false, prefs: [], times: [] },
    stranger: { on: false, adult: false }, // stranger mode: opt-in, adults only
    blocked: [],
    clinician: false, // set by the server operator; lets this account start care teams
    caps: { push: false, geo: 'unknown' },
    showArea: null, // friends see this person's rough area on the map: null = not asked yet
    mood: null, // manually chosen avatar weather; no inferred mood or history
    surveysOn: null, // two-weekly check-in: null = not asked yet
    share: null, // check-ins shared with the care team: null = not asked yet
    survey: null, // the check-in in progress
    surveys: [],
    paused: 0,
    noStreak: 0,
    feltNo: 0,
    lastProposalAt: 0,
    lastCardAt: 0,
    lastDoneAt: 0,
    quiet: false,
    toasts: [],
    push: null,
  };
  db.users[u.id] = u;
  log(`${name} joined`);
  changed(u.id);
  setTimeout(() => void tick(), 300);
  return u;
}

export function removeUser(userId) {
  const u = db.users[userId];
  if (!u) return;
  for (const p of Object.values(db.plans)) {
    if (p.userIds.includes(userId) && ['proposed', 'confirmed'].includes(p.status)) cancelPlan(p, userId, 'left');
  }
  for (const [id, c] of Object.entries(db.cards)) if (c.userId === userId) delete db.cards[id];
  for (const [t, s] of Object.entries(db.sessions)) if (s.userId === userId) delete db.sessions[t];
  for (const k of Object.keys(db.pairs)) if (k.split('|').includes(userId)) delete db.pairs[k];
  const others = audienceOf(userId).filter((id) => id !== userId);
  removeUserFromGroups(userId);
  delete db.users[userId];
  log(`${u.name} deleted their account`);
  changed(userId, ...others);
}

/**
 * Whose screens change when this person's cat, area or weather changes: themself, people they share a friend group
 * with, and anyone they're meeting right now. Nobody else on the server.
 */
function audienceOf(userId) {
  const ids = new Set([userId, ...friendIdsOf(userId)]);
  for (const p of activePlans(userId)) for (const id of p.userIds) ids.add(id);
  return [...ids].filter((id) => db.users[id]);
}

export function setCaps(userId, caps) {
  const u = db.users[userId];
  if (!u) return;
  u.caps = { ...u.caps, ...caps };
  changed(userId);
}

export function setPause(userId, days) {
  const u = db.users[userId];
  if (!u) return;
  u.paused = days > 0 ? Date.now() + days * DAY : 0;
  for (const c of Object.values(db.cards)) {
    if (c.userId === userId && c.status === 'open' && ['pref', 'time', 'host', 'care', 'survey', 'survey_consent', 'share_consent', 'area_consent'].includes(c.kind)) c.status = 'expired';
  }
  if (days > 0) u.survey = null;
  log(days > 0 ? `${u.name} paused Mochii for ${days} days` : `${u.name} is back`);
  changed(...audienceOf(userId)); // remove or restore their marker on open friends' maps immediately
}

export function updateLocation(userId, { lat, lon, acc }) {
  const u = db.users[userId];
  if (!u || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  const now = Date.now();
  const cellBefore = u.loc && now - u.loc.at < AREA_FRESH ? areaKey(u.loc) : null;
  u.loc = { lat, lon, acc: Number.isFinite(acc) ? acc : 50, at: now };
  // Friends' maps only change when this person crosses into another ~1 km area, or moves while on their way to them.
  if (u.showArea === true && areaKey(u.loc) !== cellBefore) changed(...friendIdsOf(userId));
  for (const p of activePlans(userId)) if (p.status === 'confirmed' && p.going[userId]) changed(otherOf(p, userId)?.id);
  const last = u.samples[u.samples.length - 1];
  if (!last || now - last.at > 10 * MIN || distance(last, u.loc) > 75) {
    u.samples.push({ lat, lon, at: now });
    if (u.samples.length > 600) u.samples.splice(0, u.samples.length - 600);
    u.home = estimateHome(u);
    void prefetch(u.loc); // look up places around here in the background
  }
  // Snappy "you're together" when someone is out to meet a friend.
  for (const p of activePlans(userId)) if (p.status === 'confirmed') detectTogether(p);
  save();
}

/** Home = where the phone usually is at night (falls back to the first location seen). */
function estimateHome(u) {
  const night = u.samples.filter((s) => {
    const h = new Date(s.at).getHours();
    return h >= 22 || h < 7;
  });
  const pts = night.length >= 3 ? night : u.samples.slice(0, 1);
  if (!pts.length) return null;
  const lats = pts.map((p) => p.lat).sort((a, b) => a - b);
  const lons = pts.map((p) => p.lon).sort((a, b) => a - b);
  return { lat: lats[lats.length >> 1], lon: lons[lons.length >> 1] };
}

/** Within-person signals only: compared with the person's own routine, never with others. */
export function needsCompany(u) {
  if (u.quiet) return true; // dashboard demo switch
  if (u.noStreak >= 2) return true;
  const last = u.surveys?.at(-1);
  if (last && Date.now() - last.at < 28 * DAY && needsSupport(last)) return true;
  const since = Date.now() - (u.lastDoneAt || u.createdAt);
  if (since > 4 * DAY) return true;
  if (u.home) {
    const recent = u.samples.filter((s) => Date.now() - s.at < 2 * DAY);
    if (recent.length >= 8 && recent.every((s) => distance(s, u.home) < 250)) return true;
  }
  return false;
}

/* ----------------------------------------------------------------------- cards */

const PRIORITY = {
  reminder: 0, proposal: 1, checkin: 2, felt: 3, safety: 3.2, keep: 3.4, care: 4, share_consent: 4.5, survey: 4.6,
  perm_location: 5, perm_notify: 6, host: 7, stranger_offer: 7.2, stranger_adult: 7.3, survey_consent: 7.5,
  area_consent: 7.6, pref: 8, time: 8,
};
// Plan questions: each one also reaches the phone as a notification with the card's own yes/no.
const PUSHED = new Set(['proposal', 'reminder', 'checkin', 'felt']);
// Someone else is waiting on these, so they're delivered right away and stay on screen until answered.
const URGENT = new Set(['proposal', 'reminder']);

function addCard(userId, card) {
  const now = Date.now();
  const c = { id: newId(), userId, status: 'open', createdAt: now, ...card };
  db.cards[c.id] = c;
  const u = db.users[userId];
  u.lastCardAt = now;
  changed(userId);
  if (PUSHED.has(c.kind)) {
    const count = openCards(userId).filter((x) => PUSHED.has(x.kind)).length;
    const ttl = c.expiresAt ? (c.expiresAt - now) / 1000 : 3 * 3600; // a question that's gone shouldn't arrive late
    void notify(u, { ...nudgeFor(c), count }, { ttl, urgency: URGENT.has(c.kind) ? 'high' : 'normal' });
  }
  return c;
}

/** The notification for a plan question: same words and buttons as the card, answerable without opening Mochii. */
function nudgeFor(c) {
  return {
    cardId: c.id,
    tag: `card:${c.id}`,
    title: `${c.emoji ?? ''} ${c.title}`.trim(),
    body: (c.lines ?? []).map((l) => (l.when ? whenText(l.when) : l.text)).filter(Boolean).join('\n'),
    yes: c.yes || 'Yes',
    no: c.no || 'No',
    sticky: URGENT.has(c.kind),
  };
}

function whenText(ts) {
  const d = new Date(ts);
  const days = Math.round((new Date(ts).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long' });
  return `${day} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
}

function openCards(userId) {
  return Object.values(db.cards)
    .filter((c) => c.userId === userId && c.status === 'open')
    .sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9) || a.createdAt - b.createdAt);
}

function expireCards(planId, userId) {
  for (const c of Object.values(db.cards)) {
    if (c.planId === planId && c.status === 'open' && (!userId || c.userId === userId)) c.status = 'expired';
  }
}

function activePlans(userId) {
  const now = Date.now();
  return Object.values(db.plans).filter(
    (p) => p.userIds.includes(userId) && (p.status === 'proposed' || (p.status === 'confirmed' && now < p.endAt + 30 * MIN)),
  );
}

/** Onboarding happens as a short run of yes/no cards, then the rest are sprinkled in later. */
const STARTER = ['coffee', 'walk', 'cook'];

function nextQuestion(u, { onboardingOnly }) {
  if (!u.asked.location) {
    return {
      kind: 'perm_location', emoji: '📍', action: 'location',
      title: 'Can Mochii use your location?',
      lines: [{ icon: '🔒', text: 'To place your cat on the map and find plans nearby. You choose separately whether friends can see your rough area.' }],
      yes: 'Allow location', no: 'Not now',
    };
  }
  if (u.caps.push && !u.asked.notify) {
    return {
      kind: 'perm_notify', emoji: '🔔', action: 'notify',
      title: 'Can Mochii tap you on the shoulder when a plan comes up?',
      lines: [{ icon: '🤫', text: 'Only for plans, never for anything else.' }],
      yes: 'Yes', no: 'Not now',
    };
  }
  const starter = STARTER.find((id) => !u.asked.prefs.includes(id));
  if (starter) return prefCard(starter);
  if (!u.asked.host) {
    return {
      kind: 'host', emoji: '🏠',
      title: 'Would you be okay having a friend over sometimes?',
      lines: [{ icon: '🍝', text: 'For things like cooking or a movie night.' }],
      yes: 'Yes', no: 'Rather not',
    };
  }
  if (onboardingOnly) return null;
  // Nobody to make plans with yet? Offer to meet new people, once. Friends can still invite them any time.
  if (!u.asked.strangers && !friendIdsOf(u.id).size && !u.stranger?.on) return strangerOfferCard();
  if (!u.asked.survey) return surveyConsentCard();
  if (u.surveys?.length && u.share == null && careTeamsOf(u.id).length) return shareCard(u);
  if (u.loc && !u.asked.area && friendIdsOf(u.id).size) return areaCard();
  const pref = ACTIVITIES.find((a) => !u.asked.prefs.includes(a.id));
  if (pref) return prefCard(pref.id);
  const slot = Object.keys(TIME_QUESTIONS).find((s) => !u.asked.times.includes(s));
  if (slot) return { kind: 'time', slot, emoji: '🕒', title: TIME_QUESTIONS[slot], lines: [], yes: 'Yes', no: 'Not really' };
  return null;
}

function prefCard(activityId) {
  const a = byId[activityId];
  return { kind: 'pref', activityId, emoji: a.emoji, title: a.ask, lines: [], yes: 'Yes', no: 'Not really' };
}

/* ------------------------------------------------------------------ stranger mode */

function strangerOfferCard() {
  return {
    kind: 'stranger_offer', emoji: '🌱',
    title: 'Want Mochii to introduce you to someone new nearby?',
    lines: [
      { icon: '👥', text: 'Only other adults who also said yes. First names only.' },
      { icon: '☕', text: 'Coffee, a walk, the gym or studying, at a public place, in daytime. Never anyone’s home.' },
      { icon: '🛡️', text: 'They never see where you are. You can stop any time from the menu (☰).' },
    ],
    yes: 'Yes, sounds nice', no: 'Not now',
  };
}

function adultCard() {
  return {
    kind: 'stranger_adult', emoji: '🪪',
    title: 'Are you 18 or older?',
    lines: [{ icon: '🌱', text: 'Meeting new people is for adults only.' }],
    yes: "Yes, I'm 18+", no: 'No',
  };
}

/** Turn stranger mode on or off. On needs an "I'm 18 or older". */
export function setStranger(userId, { on, adult }) {
  const u = db.users[userId];
  if (!u) return { error: 'Not signed in.' };
  u.asked.strangers = true;
  if (adult === true) u.stranger = { ...u.stranger, adult: true };
  if (on && !u.stranger?.adult) return { error: 'Stranger mode is for adults (18+).' };
  u.stranger = { ...u.stranger, on: !!on, since: on ? Date.now() : null };
  if (!on) {
    // Pending stranger suggestions go away; plans already agreed stay (cancel them like any plan).
    for (const p of Object.values(db.plans)) if (p.mode === 'stranger' && p.status === 'proposed' && p.userIds.includes(userId)) cancelPlan(p, userId, 'declined');
  }
  log(`${u.name} turned stranger mode ${on ? 'on' : 'off'}`);
  changed(userId);
  return { ok: true };
}

const strangerReady = (u) => !!(u?.stranger?.on && u.stranger.adult && u.loc);

/** Block (and optionally report) someone: any plan between them ends, and Mochii never pairs them again. */
export function blockUser(userId, otherId, report = false) {
  for (const p of Object.values(db.plans)) {
    if (p.userIds.includes(userId) && p.userIds.includes(otherId) && ['proposed', 'confirmed'].includes(p.status)) {
      p.status = 'cancelled';
      p.cancelReason = 'blocked';
      expireCards(p.id);
    }
  }
  block(userId, otherId, { report, reason: report ? 'Reported from the app' : '' });
  changed(userId, otherId);
}

function safetyCard(plan, other) {
  return {
    kind: 'safety', planId: plan.id, emoji: '🛡️',
    title: `Did you feel safe with ${other?.name ?? 'them'}?`,
    lines: [{ icon: '🤫', text: `${other?.name ?? 'They'} won't be told what you answer. A no means you're never matched again, and Mochii's team takes a look.` }],
    yes: 'Yes', no: 'No',
  };
}

function keepCard(plan, other) {
  return {
    kind: 'keep', planId: plan.id, emoji: '🤝',
    title: `Stay in touch with ${other?.name ?? 'them'}?`,
    lines: [{ icon: '🐾', text: "If you both say yes, you'll be friends on Mochii and can make plans again. If not, nobody is told." }],
    yes: 'Yes', no: 'No thanks',
  };
}

function onSafety(u, c, yes) {
  const plan = db.plans[c.planId];
  if (!plan) return;
  const other = otherOf(plan, u.id);
  if (!other) return;
  if (yes) {
    addCard(u.id, keepCard(plan, other));
    return;
  }
  block(u.id, other.id, { report: true, reason: 'Did not feel safe after a stranger-mode meet-up', planId: plan.id });
  for (const k of Object.values(db.cards)) if (k.planId === plan.id && k.kind === 'keep' && k.status === 'open') k.status = 'expired';
  toast(u.id, `Thank you for telling us. You won't be matched with ${other.name} again, and Mochii's team will take a look.`);
}

function onKeep(u, c, yes) {
  const plan = db.plans[c.planId];
  if (!plan) return;
  const other = otherOf(plan, u.id);
  (plan.keep ??= {})[u.id] = !!yes;
  if (!yes || !other || blocked(u.id, other.id)) return;
  if (plan.keep[other.id] === true && createPairGroup(other.id, u.id)) {
    toast(u.id, `You and ${other.name} are now friends on Mochii 🐾`);
    toast(other.id, `You and ${u.name} are now friends on Mochii 🐾`);
    changed(u.id, other.id);
  }
}

/* ---------------------------------------------------------------- care teams */

export const careTeamsOf = (userId) => groupsOf(userId, 'care').filter((g) => g.members[userId]?.role === 'patient');

/** Joined a care team after already doing check-ins: ask about sharing straight away. */
export function joinedCareTeam(userId) {
  const u = db.users[userId];
  if (!u) return;
  if (u.share == null && u.surveys?.length && !openCards(userId).some((c) => c.kind === 'share_consent')) addCard(userId, shareCard(u));
  changed(userId);
}

/** Group membership changed (joined, left, removed): refresh everyone in that group. */
export function groupChanged(userIds) {
  changed(...userIds.filter((id) => db.users[id]));
  setTimeout(() => void tick(), 300);
}

function areaCard() {
  return {
    kind: 'area_consent', emoji: '🗺️',
    title: 'Show people in your groups roughly where you are on the map?',
    lines: [
      { icon: '🔒', text: 'Only your neighbourhood (about 1 km), never your exact spot. Nobody outside your groups.' },
      { icon: '🌙', text: "Only after you've opened Mochii in the last few hours. You can hide any time from the menu (☰)." },
    ],
    yes: 'Yes', no: 'Keep me hidden',
  };
}

export function setShowArea(userId, on) {
  const u = db.users[userId];
  if (!u) return;
  u.showArea = !!on;
  u.asked.area = true;
  changed(...audienceOf(userId)); // their friends' maps change
}

const MOOD_IDS = new Set(['sunny', 'rainy', 'foggy', 'cloudy', 'stormy', 'rainbow']);
const moodFor = (u) => MOOD_IDS.has(u.mood) ? u.mood : null;

export function setMood(userId, mood) {
  const u = db.users[userId];
  if (!u || (mood !== null && !MOOD_IDS.has(mood))) return false;
  u.mood = mood;
  // stateFor only sends this weather to people who can already see the cat.
  changed(...audienceOf(userId));
  return true;
}

/* -------------------------------------------------------------------- check-ins */

function surveyConsentCard() {
  return {
    kind: 'survey_consent', emoji: '📋',
    title: 'Would a short check-in every two weeks be okay?',
    lines: [
      { icon: '⏱️', text: `${SURVEY_LENGTH} quick taps about how you've been. It helps Mochii notice what you need.` },
      { icon: '🔒', text: 'It stays private. Nobody sees it, not your friends and not your groups. Only a care team you join can, and only if you say yes.' },
    ],
    yes: 'Yes', no: 'Not now',
  };
}

function shareCard(u) {
  const teams = careTeamsOf(u.id).map((g) => g.name);
  const named = teams.length ? teams.join(' and ') : 'your care team';
  return {
    kind: 'share_consent', emoji: '🩺',
    title: `Share your check-ins with ${named}?`,
    lines: [
      { icon: '📋', text: 'Only your check-in answers and how often you met up with people.' },
      { icon: '🔒', text: 'Never where you go, who you met or what you planned. You can stop any time from the menu (☰).' },
      { icon: '👩‍⚕️', text: `Only the clinicians in ${named}. Never your friends, groups or other patients.` },
      { icon: '🤖', text: 'If they use AI summaries, the AI sees the numbers, never your name.' },
    ],
    yes: 'Yes, share', no: 'Keep it private',
  };
}

/** After a heavy check-in. Reuses the "care" card, so answering it works the same way. */
function supportCard() {
  return {
    kind: 'care', emoji: '💛',
    title: 'The last two weeks sound heavy. Would it help to talk to your care team or someone you trust?',
    lines: [
      { icon: '📞', tel: '+358925250111', text: 'MIELI Crisis Helpline 09 2525 0111 (24/7)' },
      { icon: '🚑', tel: '112', text: 'If you feel unsafe right now, call 112' },
    ],
    yes: 'Maybe, yes', no: 'Not now',
  };
}

function startSurvey(u) {
  u.survey = { id: newId(), startedAt: Date.now(), answers: {} };
}

function surveyDue(u, now) {
  if (!u.surveysOn || u.survey) return false;
  const last = u.surveys?.at(-1)?.at ?? 0;
  return now - last >= T().surveyGap && now - (u.surveyDroppedAt || 0) >= T().surveyRetry;
}

/** The next unanswered question of the check-in in progress, as a card with the published answer options. */
function nextSurveyCard(u, now) {
  if (now - u.survey.startedAt > T().surveyTtl) {
    u.survey = null; // left half-done: start fresh another day (the questions are about the last two weeks)
    u.surveyDroppedAt = now;
    return null;
  }
  let step = 1;
  for (const id of SURVEY) {
    const inst = INSTRUMENTS[id];
    const got = u.survey.answers[id] ?? [];
    const item = inst.items.findIndex((_, i) => got[i] == null);
    if (item >= 0) {
      return {
        kind: 'survey', surveyId: u.survey.id, instrument: id, item,
        title: inst.items[item], note: inst.stem, options: inst.options,
        progress: `Check-in · ${step + item} of ${SURVEY_LENGTH}`,
        lines: [], expiresAt: u.survey.startedAt + T().surveyTtl,
      };
    }
    step += inst.items.length;
  }
  return null;
}

/** Straight after the previous answer, so the next question is already there when the card flies off. */
function queueSurveyCard(u) {
  const q = u.survey && nextSurveyCard(u, Date.now());
  if (q) addCard(u.id, q);
}

function onSurveyAnswer(u, c, value) {
  if (u.survey?.id !== c.surveyId) return;
  (u.survey.answers[c.instrument] ??= [])[c.item] = value;
  const done = SURVEY.every((id) => INSTRUMENTS[id].items.every((_, i) => u.survey.answers[id]?.[i] != null));
  if (done) finishSurvey(u);
  else queueSurveyCard(u);
}

function finishSurvey(u) {
  const entry = { id: newId(), at: Date.now() };
  for (const id of SURVEY) entry[id] = { items: u.survey.answers[id], score: score(id, u.survey.answers[id]) };
  (u.surveys ??= []).push(entry);
  if (u.surveys.length > 100) u.surveys.splice(0, u.surveys.length - 100);
  u.survey = null;
  log(`📋 ${u.name} finished a check-in`); // never the answers: the server log is visible to the operator
  if (entry.phq8.score >= CUT.phq8High) addCard(u.id, supportCard());
  else toast(u.id, "Thanks. That's it for two weeks 💛");
  if (u.share == null && careTeamsOf(u.id).length) addCard(u.id, shareCard(u));
}

export function setSurveys(userId, { on, share, start }) {
  const u = db.users[userId];
  if (!u) return;
  if (on != null) {
    u.surveysOn = !!on;
    u.asked.survey = true;
    if (!on) {
      u.survey = null;
      for (const c of Object.values(db.cards)) if (c.userId === userId && c.status === 'open' && c.kind === 'survey') c.status = 'expired';
    }
  }
  if (share != null) u.share = !!share && careTeamsOf(userId).length > 0;
  if (u.surveysOn && !u.survey && (start || (on && surveyDue(u, Date.now())))) {
    startSurvey(u);
    queueSurveyCard(u);
  }
  changed(userId);
  setTimeout(() => void tick(), 300);
}

/* ---------------------------------------------------------------- the initiator */

export function setAvailability(userId, value) {
  const u = db.users[userId];
  const availability = normalizeAvailability(value);
  if (!u || !availability) return false;
  u.availability = availability;
  // Pending suggestions must obey the new filter; already confirmed plans are commitments.
  for (const plan of Object.values(db.plans)) {
    if (plan.status === 'proposed' && plan.userIds.includes(userId) &&
        !fitsAvailability(availability, plan.startAt, plan.endAt)) cancelPlan(plan, userId, 'availability');
  }
  changed(userId);
  setTimeout(() => void tick(), 300);
  return true;
}

function available(u, now = Date.now()) {
  if (!u || u.paused > now) return false;
  if (u.availability?.enabled && !u.availability.days.some(day => day.length)) return false;
  if (!u.asked.location || STARTER.some((id) => !u.asked.prefs.includes(id))) return false; // still onboarding
  if (activePlans(u.id).length) return false;
  if (openCards(u.id).some((c) => c.kind === 'proposal')) return false;
  return true;
}

const proposing = new Set();

/** Mochii takes the first step: picks a person, an activity, a time and a place, and asks both. */
export async function propose(initiatorId, { force = false } = {}) {
  const u = db.users[initiatorId];
  const now = Date.now();
  if (!u || proposing.has(u.id) || (!force && !available(u, now))) return null;
  if (force && (u.paused > now || activePlans(u.id).length)) return null;

  // Who can be asked: people who share a friend group with them or, in stranger mode, other adults who also said yes,
  // live within about 6 km and were never blocked or reported by either side. Nobody else on the server.
  const friendIds = friendIdsOf(u.id);
  const others = Object.values(db.users).filter((v) => {
    if (v.id === u.id || proposing.has(v.id) || !available(v, now)) return false;
    if (friendIds.has(v.id)) return true;
    return strangerReady(u) && strangerReady(v) && !blocked(u.id, v.id) && distance(u.loc, v.loc) < 6000;
  });
  if (!others.length) return null;

  // Who: people Mochii has seen go well together, who are near, and who haven't met in a while.
  const scored = others.map((v) => {
    const pair = pairOf(u.id, v.id);
    const d = u.loc && v.loc ? distance(u.loc, v.loc) : null;
    const near = d == null ? 0.6 : Math.exp(-d / 8000);
    const rotation = 0.5 + 0.5 * Math.min(1, (now - (pair.last || 0)) / (3 * DAY));
    const care = needsCompany(v) ? 1.3 : 1;
    const stranger = !friendIds.has(v.id);
    return { v, d, stranger, score: sample(pair) * near * rotation * care * (stranger ? 0.6 : 1) }; // friends first
  });
  scored.sort((a, b) => b.score - a.score);
  const recent = Object.values(db.plans)
    .filter((p) => p.userIds.includes(u.id) && now - p.createdAt < 3 * DAY)
    .map((p) => p.activityId);
  let match = null;
  // Try other activities and other people when the highest-ranked choice has no shared time.
  for (const { v, d, stranger } of scored) {
    const mode = stranger ? 'stranger' : 'friends';
    const low = needsCompany(u) || needsCompany(v);
    const hosts = [u, v].filter(x => x.canHost === true && x.loc);
    const options = ACTIVITIES.map(act => {
      if (stranger && !act.strangerOk) return null;
      if (act.home && (!hosts.length || (d != null && d > 15000))) return null;
      let s = sample(beta(u.prefs, act.id)) * sample(beta(v.prefs, act.id));
      if (low) s *= [1.5, 1, 0.3][act.energy];
      if (recent.includes(act.id)) s *= 0.5;
      return { act, s };
    }).filter(Boolean).sort((a, b) => b.s - a.s);
    for (const { act } of options) {
      const time = pickTime(u, v, act, now, mode);
      if (time) { match = { v, stranger, mode, low, hosts, act, time }; break; }
    }
    if (match) break;
  }
  if (!match) return null;
  const { v, stranger, mode, low, hosts, act, time } = match;
  const { startAt, slot } = time;
  const length = T().length ?? act.minutes * MIN;

  proposing.add(u.id);
  proposing.add(v.id);
  try {
    let place;
    let hostId = null;
    if (act.home) {
      const host = hosts.length === 2 ? hosts[Math.random() < 0.5 ? 0 : 1] : hosts[0];
      hostId = host.id;
      const spot = host.home ?? host.loc;
      place = { home: true, lat: spot.lat, lon: spot.lon, name: `${host.name}'s place` };
    } else {
      const center = u.loc && v.loc ? midpoint(u.loc, v.loc) : (u.loc ?? v.loc);
      place = center
        ? await findPlace(act, center)
        : { name: act.placeLabel, search: act.search, found: false };
    }
    if (stranger && !place.found) return null; // strangers only ever meet at a real, named public place
    if (!(force ? db.users[u.id] : available(u)) || !available(v)) return null; // things changed while looking
    if (!fitsAvailability(u.availability, startAt, startAt + length) ||
        !fitsAvailability(v.availability, startAt, startAt + length)) return null;

    const plan = {
      id: newId(),
      activityId: act.id,
      mode,
      userIds: [u.id, v.id],
      hostId,
      slot,
      timeSlots: time.timeSlots,
      startAt,
      endAt: startAt + length,
      place,
      low,
      status: 'proposed',
      answers: { [u.id]: null, [v.id]: null },
      going: {},
      together: false,
      reminded: false,
      createdAt: now,
    };
    db.plans[plan.id] = plan;
    u.lastProposalAt = v.lastProposalAt = now;
    const expiresAt = Math.min(now + T().cardTtl, startAt - 5 * MIN);
    for (const [me, other] of [[u, v], [v, u]]) addCard(me.id, { ...proposalCard(plan, me, other), expiresAt });
    log(`Asked ${u.name} + ${v.name}${stranger ? ' (stranger mode)' : ''}: ${act.emoji} ${act.name}${low ? ' (gentle)' : ''} · ${place.name}`);
    return plan;
  } finally {
    proposing.delete(u.id);
    proposing.delete(v.id);
  }
}

export function pickTime(u, v, act, now, mode = 'friends') {
  const filtered = u.availability?.enabled || v.availability?.enabled;
  if (config.demo && !filtered) {
    const startAt = Math.ceil((now + T().startIn) / (5 * MIN)) * 5 * MIN;
    return { startAt, slot: slotOf(new Date(startAt).getHours()) };
  }
  const options = [];
  if (filtered) {
    const length = T().length ?? act.minutes * MIN;
    const zoneU = u.availability?.timeZone || v.availability?.timeZone || DEFAULT_ZONE;
    const zoneV = v.availability?.timeZone || zoneU;
    const step = 15 * MIN; // also accommodates time zones offset by 15/45 minutes
    const earliest = now + (config.demo ? T().startIn : 2 * HOUR);
    for (let startAt = Math.ceil(earliest / step) * step; startAt < now + 8 * DAY; startAt += step) {
      const endAt = startAt + length;
      const a = localTime(startAt, zoneU), b = localTime(startAt, zoneV);
      const slotU = slotOf(a.hour), slotV = slotOf(b.hour);
      if (!act.times.includes(slotU) || !act.times.includes(slotV)) continue;
      if (mode === 'stranger') {
        const endA = localTime(endAt - 1, zoneU), endB = localTime(endAt - 1, zoneV);
        if ([a, b, endA, endB].some(t => t.hour < 8 || t.hour >= 17)) continue;
      }
      if (!fitsAvailability(u.availability, startAt, endAt) || !fitsAvailability(v.availability, startAt, endAt)) continue;
      const soon = 1 / (1 + (startAt - now) / DAY);
      options.push({ startAt, slot: slotU, timeSlots: { [u.id]: slotU, [v.id]: slotV },
        s: sample(beta(u.times, slotU)) * sample(beta(v.times, slotV)) * soon });
    }
    options.sort((a, b) => b.s - a.s);
    return options[0] ?? null;
  }
  for (let day = 0; day < 3; day++) {
    // Meeting someone new: daytime only.
    const slots = mode === 'stranger' ? act.times.filter((x) => x !== 'evening') : act.times;
    for (const slot of slots.length ? slots : ['afternoon']) {
      const t = new Date(now);
      t.setDate(t.getDate() + day);
      t.setHours(SLOTS[slot].hour, 0, 0, 0);
      if (t.getTime() - now < 2 * HOUR) continue;
      const soon = [1, 0.8, 0.5][day];
      options.push({ startAt: t.getTime(), slot, s: sample(beta(u.times, slot)) * sample(beta(v.times, slot)) * soon });
    }
  }
  options.sort((a, b) => b.s - a.s);
  return options[0] ?? null;
}

const slotOf = (h) => (h >= 7 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : 'evening');

function placeLine(plan, me, other) {
  const p = plan.place;
  if (p.home) {
    if (plan.hostId !== me.id) return `At ${db.users[plan.hostId]?.name ?? other.name}'s place`;
    return plan.status === 'proposed' ? `At your place. ${other.name} gets directions if you both say yes.` : 'At your place';
  }
  if (p.found && me.loc) return `${p.name} · ${fromYou(distance(me.loc, p))}`;
  return p.name;
}

const sharedGroup = (a, b) => groupsOf(a, 'friends').find((g) => g.members[b]) ?? null;

function proposalCard(plan, me, other) {
  const act = byId[plan.activityId];
  const lines = [
    { icon: '🕒', when: plan.startAt },
    { icon: '📍', text: placeLine(plan, me, other) },
  ];
  if (plan.mode === 'stranger') {
    // Someone new: no distance to them, no map, first name only.
    lines.unshift({ icon: '🌱', text: `Someone new: ${other.name}, who also wants to meet people` });
    lines.push({ icon: '🛡️', text: 'A public place, in daytime. Leave whenever you like.' });
  } else {
    const group = sharedGroup(me.id, other.id);
    if (group) lines.push({ icon: '👥', text: group.name });
    if (me.loc && other.loc) lines.push({ icon: '👋', text: `${other.name} is ${away(distance(me.loc, other.loc))}` });
  }
  return { kind: 'proposal', planId: plan.id, emoji: act.emoji, title: act.propose(other.name), lines, yes: "Yes, let's", no: 'Not this time' };
}

/* ------------------------------------------------------------------- answers */

/**
 * Returns null if the card isn't open anymore (or the answer isn't one of its options), otherwise what Mochii said
 * back (for answers tapped on a notification). Check-in cards take `value`, every other card `yes`.
 */
export function answer(userId, cardId, yes, value) {
  const c = db.cards[cardId];
  const u = db.users[userId];
  if (!c || !u || c.userId !== userId || c.status !== 'open') return null;
  if (c.options && !c.options.some((o) => o.value === value)) return null;
  const seen = new Set((u.toasts || []).map((t) => t.id));
  c.status = 'answered';
  c.answer = c.options ? value : !!yes;
  c.answeredAt = Date.now();

  switch (c.kind) {
    case 'perm_location':
      u.asked.location = true;
      break;
    case 'perm_notify':
      u.asked.notify = true;
      break;
    case 'pref':
      bump(u.prefs, c.activityId, yes, 2);
      u.asked.prefs.push(c.activityId);
      break;
    case 'time':
      bump(u.times, c.slot, yes, 2);
      u.asked.times.push(c.slot);
      break;
    case 'host':
      u.canHost = !!yes;
      u.asked.host = true;
      break;
    case 'proposal':
      onProposal(u, c, !!yes);
      break;
    case 'reminder':
      onReminder(u, c, !!yes);
      break;
    case 'checkin':
      onCheckin(u, c, !!yes);
      break;
    case 'felt':
      onFelt(u, c, !!yes);
      break;
    case 'care':
      u.careAskedAt = Date.now();
      toast(u.id, yes ? 'Good idea. Mochii will keep things gentle in the meantime 💛' : "Okay. Mochii's here either way.");
      break;
    case 'survey_consent':
      u.asked.survey = true;
      u.surveysOn = !!yes;
      if (yes) {
        startSurvey(u);
        queueSurveyCard(u);
      } else toast(u.id, 'Okay. You can start check-ins any time from the menu (☰).');
      break;
    case 'share_consent':
      u.share = !!yes;
      toast(u.id, yes ? 'Shared with your care team. You can stop any time from the menu (☰).' : 'Kept private. Mochii only uses it to suggest the right things.');
      break;
    case 'survey':
      onSurveyAnswer(u, c, value);
      break;
    case 'safety':
      onSafety(u, c, !!yes);
      break;
    case 'keep':
      onKeep(u, c, !!yes);
      break;
    case 'stranger_offer':
      u.asked.strangers = true;
      if (!yes) toast(u.id, 'Okay. You can turn on stranger mode any time from the menu (☰), or join friends with a code.');
      else if (u.stranger?.adult) setStranger(u.id, { on: true });
      else addCard(u.id, adultCard());
      break;
    case 'stranger_adult':
      if (yes) {
        setStranger(u.id, { on: true, adult: true });
        toast(u.id, "Stranger mode is on. Mochii will introduce you to someone new when there's a good match 🌱");
      } else {
        u.stranger = { ...u.stranger, on: false, adult: false };
        toast(u.id, 'Okay, stranger mode stays off. Friends can still invite you with a code.');
      }
      break;
    case 'area_consent':
      u.asked.area = true;
      u.showArea = !!yes;
      toast(u.id, yes ? 'Friends now see your rough area on the map.' : "You're hidden on the map. Plans still show where you'll meet.");
      changed(...audienceOf(u.id));
      break;
  }
  changed(userId);
  setTimeout(() => void tick(), 400);
  const reply = (u.toasts || []).filter((t) => !seen.has(t.id)).map((t) => t.text);
  return { reply: reply.join(' ') || null };
}

const otherOf = (plan, userId) => db.users[plan.userIds.find((x) => x !== userId)];

function onProposal(u, c, yes) {
  const plan = db.plans[c.planId];
  if (!plan || plan.status !== 'proposed') return;
  const other = otherOf(plan, u.id);
  plan.answers[u.id] = yes;
  bump(u.prefs, plan.activityId, yes, 1);
  bump(u.times, plan.timeSlots?.[u.id] ?? plan.slot, yes, 0.5);
  u.noStreak = yes ? 0 : u.noStreak + 1;

  if (!yes) {
    cancelPlan(plan, u.id, 'declined');
    return;
  }
  if (plan.answers[other?.id] === true) {
    plan.status = 'confirmed';
    plan.confirmedAt = Date.now();
    const act = byId[plan.activityId];
    toast(u.id, `It's on! ${other.name} is in too.`);
    toast(other.id, `It's on! ${u.name} is in too.`);
    void notify(other, { title: 'Mochii', body: `It's on: ${act.emoji} ${act.name} with ${u.name}` });
    log(`✓ ${u.name} + ${other.name}: ${act.name} is on`);
  } else {
    toast(u.id, 'Great. Mochii will let you know.');
  }
}

/** The other person never hears "no". If they'd said yes, Mochii quietly lines up something else. */
function cancelPlan(plan, byUserId, reason) {
  plan.status = 'cancelled';
  plan.cancelReason = reason;
  expireCards(plan.id);
  const other = otherOf(plan, byUserId);
  const by = db.users[byUserId];
  if (!other) return;
  if (reason === 'cant-today') {
    toast(other.id, `${by?.name ?? 'Your friend'} can't make it today. That's okay. Mochii will set up another time.`);
    other.lastProposalAt = 0;
  } else if (plan.answers[other.id] === true) {
    toast(other.id, "That one won't work out. Mochii's lining up something else 💛");
    other.lastProposalAt = 0; // try again soon, maybe with someone else
  }
  log(`✗ ${byId[plan.activityId].name} for ${plan.userIds.map((id) => db.users[id]?.name).join(' + ')} (${reason})`);
  changed(...plan.userIds);
}

function onReminder(u, c, yes) {
  const plan = db.plans[c.planId];
  if (!plan || plan.status !== 'confirmed') return;
  const other = otherOf(plan, u.id);
  if (yes) {
    plan.going[u.id] = true;
    const hosting = plan.place.home && plan.hostId === u.id;
    toast(other.id, hosting ? `${u.name} is ready for you 🏠` : `${u.name} is on the way 🚶`);
  } else {
    bump(u.prefs, plan.activityId, false, 0.5);
    cancelPlan(plan, u.id, 'cant-today');
  }
}

function onCheckin(u, c, yes) {
  const plan = db.plans[c.planId];
  if (!plan) return;
  const other = otherOf(plan, u.id);
  if (yes) {
    addCard(u.id, feltCard(plan, other));
  } else {
    bump(u.prefs, plan.activityId, false, 0.5);
    toast(u.id, "That's okay. Mochii will try again another time.");
  }
}

function onFelt(u, c, yes) {
  const plan = db.plans[c.planId];
  if (!plan) return;
  const other = otherOf(plan, u.id);
  const pair = pairOf(u.id, other?.id ?? 'x');
  pair.last = Date.now();
  pair.together += 0.5; // each of the two answers counts half
  u.lastDoneAt = Date.now();
  if (yes) {
    bump(u.prefs, plan.activityId, true, 1);
    pair.a += 1;
    u.noStreak = 0;
    u.feltNo = 0;
    toast(u.id, 'Glad to hear it 💛');
  } else {
    bump(u.prefs, plan.activityId, false, 0.5);
    pair.b += 0.5;
    u.feltNo += 1;
    toast(u.id, 'Thanks for being honest. Some days are like that.');
  }
  if (plan.mode === 'stranger' && other) addCard(u.id, safetyCard(plan, other));
}

function feltCard(plan, other) {
  const act = byId[plan.activityId];
  return {
    kind: 'felt', planId: plan.id, emoji: '💛',
    title: `Did spending time with ${other?.name ?? 'them'} lift you a bit?`,
    lines: [{ icon: act.emoji, text: act.name }],
    yes: 'Yes', no: 'Not really',
  };
}

/* ---------------------------------------------------------------- the clock */

function detectTogether(plan) {
  const now = Date.now();
  if (plan.together || now < plan.startAt - 20 * MIN || now > plan.endAt + 20 * MIN) return;
  const [a, b] = plan.userIds.map((id) => db.users[id]);
  if (!a?.loc || !b?.loc) return;
  if (now - a.loc.at > 5 * MIN || now - b.loc.at > 5 * MIN) return;
  const limit = Math.min(300, Math.max(120, (a.loc.acc ?? 50) + (b.loc.acc ?? 50)));
  if (distance(a.loc, b.loc) > limit) return;
  plan.together = true;
  plan.togetherAt = now;
  toast(a.id, `You're together with ${b.name} ✨ Enjoy.`);
  toast(b.id, `You're together with ${a.name} ✨ Enjoy.`);
  log(`📍 ${a.name} + ${b.name} met up (GPS)`);
}

function sendReminders(plan) {
  plan.reminded = true;
  const act = byId[plan.activityId];
  for (const id of plan.userIds) {
    const me = db.users[id];
    const other = otherOf(plan, id);
    if (!me || !other) continue;
    const showMap = !plan.place.home || plan.hostId !== id;
    addCard(id, {
      kind: 'reminder', planId: plan.id, emoji: act.emoji,
      title: plan.place.home && plan.hostId === id ? `${other.name} is coming over soon. Still good?` : `Heading out to meet ${other.name} soon?`,
      lines: [
        { icon: '🕒', when: plan.startAt },
        { icon: '📍', text: placeLine(plan, me, other) },
        ...(showMap ? [{ icon: '🗺️', map: { lat: plan.place.lat, lon: plan.place.lon, name: plan.place.name, search: plan.place.search } }] : []),
        ...(plan.mode === 'stranger'
          ? [{ icon: '🛡️', text: 'Meet inside the place. It helps to tell someone you trust where you’re going.' }]
          : showMap ? [{ icon: '👀', text: `"On my way" lets ${other.name} see you on the map until you meet.` }] : []),
      ],
      yes: plan.place.home && plan.hostId === id ? 'Yes' : 'On my way',
      no: "Can't today",
    });
  }
}

function endPlan(plan) {
  plan.status = 'done';
  const act = byId[plan.activityId];
  for (const id of plan.userIds) {
    const other = otherOf(plan, id);
    if (!db.users[id]) continue;
    if (plan.together) addCard(id, feltCard(plan, other));
    else addCard(id, { kind: 'checkin', planId: plan.id, emoji: act.emoji, title: act.did(other?.name ?? 'your friend'), lines: [], yes: 'Yes', no: 'No' });
  }
}

let running = false;
let prunedAt = 0;

/** Keeps the in-memory store small: answered cards after 35 days, finished plans after 60, idle sessions after 60. */
export function prune(now = Date.now()) {
  prunedAt = now;
  for (const [id, c] of Object.entries(db.cards)) if (c.status !== 'open' && now - c.createdAt > 35 * DAY) delete db.cards[id];
  for (const [id, p] of Object.entries(db.plans)) {
    if (['done', 'cancelled'].includes(p.status) && now - p.createdAt > 60 * DAY) delete db.plans[id];
  }
  for (const [t, ses] of Object.entries(db.sessions)) if (now - (ses.seen ?? ses.at) > 60 * DAY || !db.users[ses.userId]) delete db.sessions[t];
  save();
}

export async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const t = T();
    if (now - prunedAt > HOUR) prune(now);

    for (const c of Object.values(db.cards)) {
      if (c.status !== 'open' || !c.expiresAt || now < c.expiresAt) continue;
      c.status = 'expired';
      const plan = db.plans[c.planId];
      if (c.kind === 'proposal' && plan?.status === 'proposed') cancelPlan(plan, c.userId, 'no answer');
      changed(c.userId);
    }

    for (const plan of Object.values(db.plans)) {
      if (plan.status !== 'confirmed') continue;
      // (each of these notifies the phones itself when something changes)
      if (!plan.reminded && now >= plan.startAt - t.remindBefore) sendReminders(plan);
      detectTogether(plan);
      if (now >= plan.endAt) endPlan(plan);
    }

    const [from, to] = t.hours;
    const hour = new Date(now).getHours();
    const awake = hour >= from && hour < to;

    for (const u of Object.values(db.users)) {
      if (u.paused > now) continue;
      const open = openCards(u.id);

      // Quick yes/no onboarding, one card at a time.
      if (!open.length) {
        const q = nextQuestion(u, { onboardingOnly: true });
        if (q) {
          addCard(u.id, q);
          continue;
        }
      }
      if (open.some((c) => c.kind !== 'survey')) continue; // one thing at a time, but a half-done check-in never blocks plans

      // Feeling flat after several outings? Suggest support, gently, at most once a week.
      if (!open.length && u.feltNo >= 3 && now - (u.careAskedAt || 0) > 7 * DAY) {
        addCard(u.id, {
          kind: 'care', emoji: '🌱',
          title: 'Things have felt flat lately. Would it help to talk to someone you trust, or your therapist?',
          lines: [{ icon: '💛', text: "Not a diagnosis. Just a thought, from Mochii." }],
          yes: 'Maybe, yes', no: 'Not now',
        });
        continue;
      }

      // Mochii takes the first step.
      const gap = needsCompany(u) ? t.proposalGap * 0.75 : t.proposalGap * (1 + Math.min(u.noStreak, 4) * 0.5);
      if (awake && now - u.lastProposalAt >= gap && available(u, now)) {
        const plan = await propose(u.id);
        if (plan) continue;
      }
      if (open.length) continue; // a check-in question is waiting

      // The two-weekly check-in, one question at a time, whenever nothing else needs an answer.
      if (u.survey || surveyDue(u, now)) {
        if (!u.survey) startSurvey(u);
        const q = nextSurveyCard(u, now);
        if (q) {
          addCard(u.id, q);
          continue;
        }
      }

      // Otherwise, now and then, one more thing to learn about them.
      if (now - u.lastCardAt >= t.prefGap && !activePlans(u.id).some((p) => p.status === 'proposed')) {
        const q = nextQuestion(u, { onboardingOnly: false });
        if (q) addCard(u.id, q);
      }
    }
  } catch (e) {
    console.error('[engine]', e);
  } finally {
    running = false;
  }
}

let interval = null;
export function start() {
  clearInterval(interval);
  interval = setInterval(() => void tick(), T().tick);
  for (const u of Object.values(db.users)) if (u.loc) void prefetch(u.loc);
  void tick();
}

export function setDemo(on) {
  config.demo = !!on;
  start();
}

/* ------------------------------------------------------------------------ map */

// Friends only ever see which ~1 km cell someone is in (around 60°N), never the spot, and only if they said yes.
const AREA = { lat: 0.01, lon: 0.02 };
const AREA_FRESH = 3 * HOUR; // after that they just aren't shown: no "last seen"
const areaKey = (p) => `${Math.floor(p.lat / AREA.lat)}:${Math.floor(p.lon / AREA.lon)}`;
const centre = (v, step) => Number(((Math.floor(v / step) + 0.5) * step).toFixed(4));
const areaOf = (p) => ({ lat: centre(p.lat, AREA.lat), lon: centre(p.lon, AREA.lon) });

/** A plan where `v` tapped "On my way" to meet `u` and hasn't arrived yet: the only time `u` sees `v`'s real position. */
function onTheWay(u, v, now) {
  return Object.values(db.plans).find(
    (p) => p.status === 'confirmed' && p.mode !== 'stranger' && p.userIds.includes(u.id) && p.userIds.includes(v.id) && p.going[v.id] && !p.together && now <= p.endAt
      && !(p.place.home && p.hostId === v.id) && now - v.loc.at < 10 * MIN,
  );
}

function mapFor(u, now) {
  const friends = [];
  for (const v of Object.values(db.users)) {
    if (v.id === u.id || !v.loc || v.paused > now || !connected(u.id, v.id)) continue; // only people in your groups
    const plan = onTheWay(u, v, now);
    if (plan) friends.push({ id: v.id, name: v.name, kind: 'live', lat: v.loc.lat, lon: v.loc.lon, planId: plan.id, mood: moodFor(v) });
    else if (v.showArea === true && now - v.loc.at < AREA_FRESH) friends.push({ id: v.id, name: v.name, kind: 'area', ...areaOf(v.loc), radius: 800, mood: moodFor(v) });
  }
  // The place of a suggestion that's waiting for an answer (never someone's home before both said yes).
  const card = openCards(u.id)[0];
  const plan = card?.kind === 'proposal' ? db.plans[card.planId] : null;
  const pin = plan && !plan.place.home && plan.place.found
    ? { lat: plan.place.lat, lon: plan.place.lon, name: plan.place.name, emoji: byId[plan.activityId].emoji }
    : null;
  return { me: u.loc ? { lat: u.loc.lat, lon: u.loc.lon } : null, showArea: u.showArea ?? null, friends, pin };
}

/* ------------------------------------------------------------- what phones see */

export function stateFor(userId) {
  const u = db.users[userId];
  if (!u) return null;
  const now = Date.now();
  const cards = openCards(userId);
  const plans = Object.values(db.plans)
    .filter((p) => p.userIds.includes(userId) && p.status === 'confirmed' && now < p.endAt + 30 * MIN)
    .sort((a, b) => a.startAt - b.startAt)
    .map((p) => {
      const act = byId[p.activityId];
      const other = otherOf(p, userId);
      const mine = p.place.home && p.hostId === userId;
      return {
        id: p.id,
        emoji: act.emoji,
        title: `${act.name} with ${other?.name ?? 'a friend'}`,
        friend: other?.name ?? 'Your friend',
        friendId: other?.id ?? null,
        startAt: p.startAt,
        endAt: p.endAt,
        place: { name: mine ? 'Your place' : p.place.name, lat: p.place.lat, lon: p.place.lon, search: p.place.search, map: !mine },
        together: p.together,
        mode: p.mode ?? 'friends',
        friendNote: p.going[other?.id]
          ? p.place.home && p.hostId === other?.id
            ? `${other.name} is ready for you 🏠`
            : `${other?.name} is on the way 🚶`
          : null,
      };
    });
  return {
    rev: u.rev || 0,
    me: {
      id: u.id, name: u.name, username: u.username, paused: u.paused > now ? u.paused : 0, wantsLocation: u.asked.location, hasPush: !!u.push,
      mood: moodFor(u),
      availability: u.availability ?? null,
      checkins: { on: u.surveysOn ?? null, share: u.share ?? null, count: u.surveys?.length ?? 0, lastAt: u.surveys?.at(-1)?.at ?? null, inProgress: !!u.survey },
      stranger: { on: !!u.stranger?.on, adult: !!u.stranger?.adult },
      clinician: !!u.clinician,
    },
    groups: groupsFor(userId),
    card: cards[0] ? publicCard(cards[0]) : null,
    waiting: cards.filter((c) => PUSHED.has(c.kind)).map((c) => c.id), // plan questions with a notification out
    plans,
    map: mapFor(u, now),
    toasts: (u.toasts || []).filter((t) => now - t.at < 90e3),
    people: 1 + friendIdsOf(userId).size, // you plus everyone you can make plans with (not the whole server)
    demo: config.demo,
  };
}

function publicCard(c) {
  return {
    id: c.id, kind: c.kind, emoji: c.emoji, title: c.title, lines: c.lines ?? [], yes: c.yes, no: c.no, action: c.action ?? null,
    nudge: PUSHED.has(c.kind) ? nudgeFor(c) : null,
    options: c.options ?? null, note: c.note ?? null, progress: c.progress ?? null,
  };
}

/* ---------------------------------------------------------- host dashboard */

export function adminState() {
  const now = Date.now();
  const users = Object.values(db.users).map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    joined: u.createdAt,
    paused: u.paused > now,
    quiet: u.quiet,
    needsCompany: needsCompany(u),
    noStreak: u.noStreak,
    hasLocation: !!u.loc,
    locationAge: u.loc ? now - u.loc.at : null,
    push: !!u.push,
    canHost: u.canHost,
    checkins: { on: u.surveysOn ?? null, share: u.share ?? null, count: u.surveys?.length ?? 0, inProgress: !!u.survey },
    showArea: u.showArea === true,
    clinician: !!u.clinician,
    stranger: !!u.stranger?.on,
    groups: groupsOf(u.id).length,
    friends: friendIdsOf(u.id).size,
    openCard: openCards(u.id)[0]?.title ?? null,
    likes: ACTIVITIES.map((a) => ({ id: a.id, emoji: a.emoji, name: a.name, p: mean(beta(u.prefs, a.id)), n: Math.round(beta(u.prefs, a.id).a + beta(u.prefs, a.id).b - 2) }))
      .sort((x, y) => y.p - x.p),
    distances: Object.values(db.users)
      .filter((v) => v.id !== u.id && v.loc && u.loc)
      .map((v) => ({ name: v.name, text: roughly(distance(u.loc, v.loc)) })),
  }));
  const plans = Object.values(db.plans)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
    .map((p) => ({
      id: p.id,
      activity: `${byId[p.activityId].emoji} ${byId[p.activityId].name}`,
      people: p.userIds.map((id) => db.users[id]?.name ?? '(gone)'),
      answers: p.userIds.map((id) => p.answers[id]),
      status: p.status,
      startAt: p.startAt,
      place: p.place.name,
      placeFound: !!p.place.found || !!p.place.home,
      reminded: p.reminded,
      together: p.together,
      low: p.low,
      mode: p.mode ?? 'friends',
    }));
  const groups = allGroups()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100)
    .map((g) => ({ id: g.id, name: g.name, kind: g.kind, size: Object.keys(g.members).length, owner: db.users[g.ownerId]?.name ?? '(gone)', fromStrangerMode: !!g.fromStrangerMode, createdAt: g.createdAt }));
  const reports = allReports().slice(0, 100).map((r) => ({
    ...r, byName: db.users[r.by]?.name ?? '(deleted)', aboutName: db.users[r.about]?.name ?? '(deleted)', aboutUsername: db.users[r.about]?.username ?? null,
  }));
  return { demo: config.demo, users, plans, groups, reports, log: db.log.slice(0, 60) };
}

export const admin = {
  propose: (userId) => propose(userId, { force: true }),
  remind(planId) {
    const p = db.plans[planId];
    if (p?.status === 'confirmed' && !p.reminded) sendReminders(p);
  },
  meet(planId) {
    const p = db.plans[planId];
    if (p?.status !== 'confirmed') return;
    p.startAt = Math.min(p.startAt, Date.now());
    const [a, b] = p.userIds.map((id) => db.users[id]);
    const spot = { lat: p.place.lat ?? a.loc?.lat ?? 60.1866, lon: p.place.lon ?? a.loc?.lon ?? 24.8282 };
    for (const x of [a, b]) x.loc = { ...jitter(spot, 25), acc: 20, at: Date.now() };
    detectTogether(p);
    changed(...p.userIds);
  },
  end(planId) {
    const p = db.plans[planId];
    if (p?.status !== 'confirmed') return;
    p.endAt = Date.now();
    endPlan(p);
    changed(...p.userIds);
  },
  cancel(planId) {
    const p = db.plans[planId];
    if (p && ['proposed', 'confirmed'].includes(p.status)) {
      p.status = 'cancelled';
      expireCards(p.id);
      changed(...p.userIds);
    }
  },
  quiet(userId, on) {
    const u = db.users[userId];
    if (u) u.quiet = !!on;
    save();
  },
  /** Put people without a GPS fix around a point (default: Aalto University, Otaniemi). */
  place(center = { lat: 60.1867, lon: 24.8277 }) {
    for (const u of Object.values(db.users)) {
      if (u.loc && Date.now() - u.loc.at < 30 * MIN) continue;
      const p = jitter(center, 1500);
      u.loc = { ...p, acc: 30, at: Date.now() };
      u.samples.push({ ...p, at: Date.now() });
      u.home ??= p;
      changed(u.id);
    }
    void prefetch(center);
  },
  /** Start a check-in now, or ask the person whether check-ins are okay if they haven't said yes yet. */
  survey(userId) {
    const u = db.users[userId];
    if (!u) return;
    if (u.surveysOn) return setSurveys(userId, { start: true });
    if (!openCards(userId).some((c) => c.kind === 'survey_consent')) addCard(userId, surveyConsentCard());
  },
  /**
   * Four made-up check-ins, two weeks apart, so the care-team view has a history to show in a demo.
   * Marked as sample data everywhere they appear.
   */
  sample(userId, trend) {
    const u = db.users[userId];
    if (!u) return;
    const curves = {
      steady: { who5: [60, 64, 60, 68], phq8: [5, 4, 6, 4], tils: [4, 4, 5, 4] },
      slipping: { who5: [68, 60, 48, 36], phq8: [4, 6, 10, 14], tils: [4, 5, 6, 7] },
    };
    const curve = curves[trend] ?? curves.steady;
    const now = Date.now();
    u.surveys = (u.surveys ?? []).filter((s) => !s.sample);
    for (let k = 0; k < 4; k++) {
      const entry = { id: newId(), at: now - (3 - k) * 14 * DAY - DAY, sample: true };
      for (const id of SURVEY) {
        const inst = INSTRUMENTS[id];
        const values = inst.options.map((o) => o.value);
        const total = id === 'who5' ? curve.who5[k] / 4 : curve[id][k];
        const items = spread(total, inst.items.length, Math.min(...values), Math.max(...values));
        entry[id] = { items, score: score(id, items) };
      }
      u.surveys.push(entry);
    }
    u.surveys.sort((a, b) => a.at - b.at);
    log(`📋 Sample check-ins added for ${u.name} (${trend === 'slipping' ? 'slipping' : 'steady'})`);
    changed(userId);
  },
  remove: removeUser,
  /** Clinician accounts can start care teams; set by the server operator only. */
  clinician(userId, on) {
    const u = db.users[userId];
    if (!u) return;
    u.clinician = !!on;
    log(`${u.name} is ${on ? 'now' : 'no longer'} a clinician account`);
    changed(userId);
  },
  resolveReport(reportId) {
    const r = allReports().find((x) => x.id === reportId);
    if (r) r.status = 'resolved';
    save();
  },
  /** Fake a stranger-mode opt-in for testing (adult confirmed). */
  stranger(userId, on) {
    setStranger(userId, { on: !!on, adult: true });
  },
};

/** Item answers between min and max that add up to total, spread evenly. */
function spread(total, n, min, max) {
  const items = Array(n).fill(min);
  let left = Math.min(total, n * max) - n * min;
  for (let i = 0; left > 0; i = (i + 1) % n) {
    if (items[i] < max) {
      items[i]++;
      left--;
    }
  }
  return items;
}
