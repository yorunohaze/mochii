import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Set isolation BEFORE loading the store or any module that creates persistent keys.
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden-map-unit-'));
process.env.EDEN_DATA_DIR = dataDir;
process.env.EDEN_PLACES = 'off';
const { db } = await import('../server/store.js');
const engine = await import('../server/engine.js');
const events = [];
engine.onChange((id) => events.push({ id, state: engine.stateFor(id) }));
const MIN = 60000;

function user(id, extra = {}) {
  return {
    id, name: id, username: id, asked: {}, prefs: {}, times: {}, samples: [],
    surveys: [], toasts: [], paused: 0, showArea: null,
    loc: { lat: 60.1901234, lon: 24.8312345, at: Date.now(), acc: 15 },
    ...extra,
  };
}
function plan(extra = {}) {
  return {
    id: 'plan', userIds: ['Alice', 'Bob'], status: 'confirmed', activityId: 'coffee',
    going: { Bob: true }, answers: {}, together: false,
    startAt: Date.now() + MIN, endAt: Date.now() + 30 * MIN,
    place: { lat: 60.185, lon: 24.825, name: 'Cafe', home: false, found: true },
    ...extra,
  };
}
const friends = (id = 'Alice') => engine.stateFor(id).map.friends;

// Alice, Bob and Cara are in one friend group; on a shared server that's what lets them see each other at all.
const crew = () => ({ crew: { id: 'crew', name: 'Crew', kind: 'friends', code: 'CREW-2345', ownerId: 'Alice', createdAt: 0,
  members: { Alice: { role: 'owner', at: 0 }, Bob: { role: 'member', at: 0 }, Cara: { role: 'member', at: 0 } } } });

beforeEach(() => {
  Object.assign(db, { users: { Alice: user('Alice'), Bob: user('Bob'), Cara: user('Cara') }, cards: {}, plans: {}, sessions: {}, pairs: {}, groups: crew(), reports: [], log: [] });
  events.length = 0;
});
after(async () => {
  await delay(350); // let the store's pending write finish before removing this owned test directory
  assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith('eden-map-unit-'));
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('locations are hidden by default; only your own position is exact', () => {
  assert.deepEqual(friends(), []);
  assert.deepEqual(engine.stateFor('Alice').map.me, { lat: 60.1901234, lon: 24.8312345 });
});

test('consent reveals a rounded area with no accuracy, timestamp or exact location', () => {
  engine.setShowArea('Bob', true);
  assert.deepEqual(friends(), [{ id: 'Bob', name: 'Bob', kind: 'area', lat: 60.195, lon: 24.83, radius: 800, mood: null }]);
  assert.ok(events.some((e) => e.id === 'Alice' && e.state.map.friends.length === 1));
  engine.setShowArea('Bob', false);
  assert.deepEqual(friends(), []);
});

test('taking a break and returning update other open maps immediately', () => {
  db.users.Bob.showArea = true;
  engine.setPause('Bob', 3);
  assert.deepEqual(events.find((e) => e.id === 'Alice').state.map.friends, []);
  events.length = 0;
  engine.setPause('Bob', 0);
  assert.equal(events.find((e) => e.id === 'Alice').state.map.friends[0].name, 'Bob');
});

test('deleting a visible user removes them from friends maps immediately', () => {
  db.users.Bob.showArea = true;
  engine.removeUser('Bob');
  assert.deepEqual(events.find((e) => e.id === 'Alice').state.map.friends, []);
  assert.equal(events.find((e) => e.id === 'Bob').state, null);
});

test('rough positions expire after three hours', () => {
  db.users.Bob.showArea = true;
  db.users.Bob.loc.at -= 181 * MIN;
  assert.deepEqual(friends(), []);
});

test('On my way shares exact coordinates only with the confirmed partner', () => {
  db.plans.plan = plan();
  assert.deepEqual(friends(), [{ id: 'Bob', name: 'Bob', kind: 'live', lat: 60.1901234, lon: 24.8312345, planId: 'plan', mood: null }]);
  assert.deepEqual(friends('Cara'), []);
  db.plans.plan.going = {};
  assert.deepEqual(friends(), []);
});

test('live position stops on arrival, cancellation, expiry, stale GPS or a break', () => {
  for (const extra of [{ together: true }, { status: 'cancelled' }, { endAt: Date.now() - 1 }]) {
    db.plans.plan = plan(extra);
    assert.deepEqual(friends(), []);
  }
  db.plans.plan = plan();
  db.users.Bob.loc.at -= 11 * MIN;
  assert.deepEqual(friends(), []);
  db.users.Bob.loc.at = Date.now();
  engine.setPause('Bob', 3);
  assert.deepEqual(friends(), []);
});

test('live location falls back to the coarse area only when separately enabled', () => {
  db.plans.plan = plan({ together: true });
  db.users.Bob.showArea = true;
  assert.equal(friends()[0].kind, 'area');
  assert.equal(friends()[0].lat, 60.195);
});

test('hosting does not expose the hosts live position', () => {
  db.plans.plan = plan({ hostId: 'Bob', place: { home: true, name: 'Home', lat: 60.19, lon: 24.83 } });
  assert.deepEqual(friends(), []);
});

test('suggestions pin public venues, never homes before confirmation', () => {
  db.plans.plan = plan({ status: 'proposed' });
  db.cards.card = { id: 'card', userId: 'Alice', kind: 'proposal', planId: 'plan', status: 'open', createdAt: Date.now() };
  assert.equal(engine.stateFor('Alice').map.pin.name, 'Cafe');
  db.plans.plan.place.home = true;
  assert.equal(engine.stateFor('Alice').map.pin, null);
});

test('invalid coordinates cannot break friends maps', () => {
  const original = { ...db.users.Bob.loc };
  for (const pos of [{ lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: NaN, lon: 24 }]) engine.updateLocation('Bob', pos);
  assert.deepEqual(db.users.Bob.loc, original);
});

test('weather is unset for existing accounts and never turns on location sharing', () => {
  assert.equal(engine.stateFor('Bob').me.mood, null);
  assert.equal(engine.setMood('Bob', 'rainy'), true);
  assert.equal(db.users.Bob.mood, 'rainy');
  assert.equal(engine.stateFor('Bob').me.mood, 'rainy');
  assert.equal(db.users.Bob.showArea, null);
  assert.deepEqual(friends(), []);
  assert.equal(db.log.length, 0);
});

test('visible cats share their weather immediately and clearing it reaches other maps', () => {
  engine.setShowArea('Bob', true);
  events.length = 0;
  engine.setMood('Bob', 'foggy');
  assert.equal(events.find((e) => e.id === 'Alice').state.map.friends[0].mood, 'foggy');
  assert.equal(friends()[0].lat, 60.195);
  events.length = 0;
  engine.setMood('Bob', null);
  assert.equal(events.find((e) => e.id === 'Alice').state.map.friends[0].mood, null);
});

test('weather disappears with a hidden, paused or stale cat', () => {
  engine.setMood('Bob', 'sunny');
  engine.setShowArea('Bob', true);
  engine.setShowArea('Bob', false);
  assert.deepEqual(friends(), []);
  engine.setShowArea('Bob', true);
  engine.setPause('Bob', 3);
  assert.deepEqual(friends(), []);
  engine.setPause('Bob', 0);
  db.users.Bob.loc.at -= 181 * MIN;
  assert.deepEqual(friends(), []);
  assert.equal(engine.stateFor('Bob').me.mood, 'sunny');
});

test('On my way shares weather only with the same people who can see that live cat', () => {
  engine.setMood('Bob', 'rainbow');
  db.plans.plan = plan();
  assert.equal(friends()[0].mood, 'rainbow');
  assert.deepEqual(friends('Cara'), []);
});

test('weather rejects unknown values and cannot inject an avatar path', () => {
  engine.setMood('Bob', 'cloudy');
  for (const value of [undefined, '', 'snowy', '../../secret', { id: 'sunny' }, 1, true]) {
    assert.equal(engine.setMood('Bob', value), false);
    assert.equal(db.users.Bob.mood, 'cloudy');
  }
  assert.equal(engine.setMood('missing', 'sunny'), false);
  for (const mood of ['sunny', 'rainy', 'foggy', 'cloudy', 'stormy', 'rainbow']) assert.equal(engine.setMood('Bob', mood), true);
});
