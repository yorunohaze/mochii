import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fitsAvailability, localTime, normalizeAvailability } from '../server/availability.js';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mochii-availability-'));
process.env.EDEN_DATA_DIR = dataDir;
process.env.EDEN_PLACES = 'off';
const { db } = await import('../server/store.js');
const engine = await import('../server/engine.js');
const { createGroup, joinByCode } = await import('../server/circles.js');
const { byId } = await import('../server/activities.js');
const at = text => Date.parse(text);
const schedule = (entries = {}, timeZone = 'UTC', enabled = true) => ({
  enabled, timeZone, days: Array.from({ length: 7 }, (_, day) => entries[day] || []),
});
const person = (id, availability = null) => ({
  id, name: id, username: id, createdAt: Date.now(), prefs: {}, times: {}, availability,
  asked: { location: true, notify: true, host: true, prefs: ['coffee', 'walk', 'cook'], times: [] },
  canHost: false, loc: null, samples: [], surveys: [], caps: {}, toasts: [], blocked: [],
  stranger: { on: false, adult: false }, paused: 0, noStreak: 0, feltNo: 0,
  lastProposalAt: Date.now(), lastCardAt: Date.now(), lastDoneAt: Date.now(),
});
beforeEach(() => {
  Object.assign(db, { users: {}, cards: {}, plans: {}, sessions: {}, pairs: {}, groups: {}, reports: [], log: [] });
  engine.config.demo = false;
});
after(async () => {
  await delay(1200);
  assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith('mochii-availability-'));
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('availability accepts only a bounded week and a valid time zone', () => {
  assert.deepEqual(normalizeAvailability(schedule({ 0: [4, 2, 4] })).days[0], [2, 4]);
  for (const value of [null, {}, schedule({}, 'invalid'), schedule({ 0: [48] }), schedule({ 0: [-1] }),
    schedule({ 0: [1.5] }), schedule({ 0: ['1'] }), { ...schedule(), enabled: 'yes' },
    { ...schedule(), days: [] }, schedule({ 0: Array(49).fill(1) })]) assert.equal(normalizeAvailability(value), null);
});

test('missing and disabled filters stay flexible; an enabled empty week blocks plans', () => {
  const start = at('2026-11-16T10:00:00Z'), end = start + 45 * 60_000;
  assert.equal(fitsAvailability(null, start, end), true);
  assert.equal(fitsAvailability(schedule({}, 'UTC', false), start, end), true);
  assert.equal(fitsAvailability(schedule(), start, end), false);
});

test('the whole activity must fit, with an exclusive end boundary', () => {
  const week = schedule({ 0: [20, 21] });
  assert.equal(fitsAvailability(week, at('2026-11-16T10:15Z'), at('2026-11-16T11:00Z')), true);
  assert.equal(fitsAvailability(week, at('2026-11-16T10:30Z'), at('2026-11-16T11:15Z')), false);
  assert.equal(fitsAvailability(week, at('2026-11-16T09:59Z'), at('2026-11-16T10:30Z')), false);
});

test('availability crosses Sunday midnight into Monday in the owner time zone', () => {
  const week = schedule({ 6: [47], 0: [0] }, 'Asia/Kathmandu');
  assert.deepEqual(localTime(at('2026-11-15T17:45Z'), week.timeZone), { day: 6, hour: 23, minute: 30 });
  assert.equal(fitsAvailability(week, at('2026-11-15T17:45Z'), at('2026-11-15T18:45Z')), true);
  assert.equal(fitsAvailability(week, at('2026-11-15T17:45Z'), at('2026-11-15T18:46Z')), false);
});

test('spring-forward and repeated fall-back hours use actual elapsed time', () => {
  const spring = schedule({ 6: [3, 6] }, 'America/New_York');
  assert.equal(fitsAvailability(spring, at('2026-03-08T06:30Z'), at('2026-03-08T07:30Z')), true);
  const fall = schedule({ 6: [2, 3] }, 'America/New_York');
  assert.equal(fitsAvailability(fall, at('2026-11-01T05:00Z'), at('2026-11-01T07:00Z')), true);
  assert.equal(fitsAvailability(schedule({ 6: [3] }, 'America/New_York'), at('2026-11-01T05:30Z'), at('2026-11-01T06:30Z')), false);
});

test('matching finds a shared half-hour window beyond the old three-day horizon', () => {
  const a = person('a', schedule({ 6: [36, 37, 38] }, 'Europe/Helsinki'));
  const b = person('b', schedule({ 6: [32, 33, 34] }, 'UTC'));
  const time = engine.pickTime(a, b, byId.walk, at('2026-11-16T08:00Z'));
  assert.ok(time);
  assert.equal(localTime(time.startAt, 'UTC').day, 6);
  for (const u of [a, b]) assert.ok(fitsAvailability(u.availability, time.startAt, time.startAt + 30 * 60_000));
});

test('no overlap or insufficient duration returns no plan, even in demo mode', () => {
  const now = at('2026-11-16T08:00Z');
  const a = person('a', schedule({ 0: [20] }));
  const b = person('b', schedule({ 0: [22] }));
  assert.equal(engine.pickTime(a, b, byId.walk, now), null);
  assert.equal(engine.pickTime(a, person('b'), byId.coffee, now), null);
  engine.config.demo = true;
  assert.equal(engine.pickTime(a, b, byId.walk, now), null);
});

test('a quarter-hour time zone finds the real shared interval', () => {
  const a = person('a', schedule({ 0: [20, 21] }, 'Asia/Kathmandu'));
  const b = person('b', schedule({ 0: [9] }, 'UTC'));
  const time = engine.pickTime(a, b, byId.walk, at('2026-11-15T00:00Z'));
  // 04:30–05:00 UTC is 10:15–10:45 in Kathmandu, inside both schedules.
  assert.equal(time.startAt, at('2026-11-16T04:30Z'));
});

test('stranger plans remain in daytime for both users even with an evening-only filter', () => {
  const allEvenings = Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, [36, 37, 38, 39]]));
  const a = person('a', schedule(allEvenings));
  const b = person('b', schedule(allEvenings));
  assert.equal(engine.pickTime(a, b, byId.walk, at('2026-11-16T08:00Z'), 'stranger'), null);
});

test('proposal matching tries another friend and a shorter activity when needed', async () => {
  const week = cell => schedule(Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, [cell]])));
  db.users.a = person('a', week(28));
  db.users.b = person('b', week(32));
  db.users.c = person('c', week(28));
  const { group } = createGroup('a', 'Friends');
  joinByCode('b', group.code); joinByCode('c', group.code);
  db.pairs['a|b'] = { a: 1e9, b: 1, last: 0 };
  db.pairs['a|c'] = { a: 1, b: 1e9, last: 0 };
  db.users.a.prefs.coffee = db.users.c.prefs.coffee = { a: 1e9, b: 1 };
  const plan = await engine.propose('a', { force: true });
  assert.ok(plan);
  assert.deepEqual(plan.userIds, ['a', 'c']);
  assert.ok(['walk', 'groceries'].includes(plan.activityId));
  assert.ok(fitsAvailability(db.users.a.availability, plan.startAt, plan.endAt));
});

test('saving removes conflicting pending suggestions but keeps confirmed plans and private schedules', () => {
  db.users.a = person('a'); db.users.b = person('b');
  const { group } = createGroup('a', 'Friends'); joinByCode('b', group.code);
  const startAt = Date.now() + 864e5;
  const plan = { id: 'pending', activityId: 'walk', status: 'proposed', userIds: ['a', 'b'], answers: { a: null, b: true },
    startAt, endAt: startAt + 1800e3, place: { name: 'Park' }, going: {}, createdAt: Date.now() };
  db.plans.pending = plan;
  db.plans.confirmed = { ...plan, id: 'confirmed', status: 'confirmed' };
  const before = engine.stateFor('a').rev;
  assert.equal(engine.setAvailability('a', schedule()), true);
  assert.equal(plan.status, 'cancelled');
  assert.equal(db.plans.confirmed.status, 'confirmed');
  assert.ok(engine.stateFor('a').rev > before);
  assert.deepEqual(engine.stateFor('a').me.availability, schedule());
  assert.equal(engine.stateFor('b').me.availability, null);
  assert.equal(engine.stateFor('b').groups[0].members.find(m => m.id === 'a')?.availability, undefined);
});

test('an availability edit during venue lookup cannot create a conflicting proposal', async () => {
  db.users.a = person('a'); db.users.b = person('b');
  db.users.a.loc = db.users.b.loc = { lat: 60.18, lon: 24.82, at: Date.now() };
  const { group } = createGroup('a', 'Friends'); joinByCode('b', group.code);
  const pending = engine.propose('a', { force: true });
  engine.setAvailability('a', schedule());
  assert.equal(await pending, null);
  assert.equal(Object.keys(db.plans).length, 0);
});
