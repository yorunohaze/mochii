import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Isolated data, and a pre-filled place cache so stranger-mode suggestions find a real public place without network.
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mochii-circles-'));
process.env.EDEN_DATA_DIR = dataDir;
delete process.env.EDEN_PLACES;
const HERE = { lat: 60.1867, lon: 24.8277 }; // Otaniemi
const cellKey = (p) => `${(Math.round(p.lat / 0.02) * 0.02).toFixed(2)},${(Math.round(p.lon / 0.04) * 0.04).toFixed(2)}`;
const cafe = { name: 'Test Café', lat: 60.1869, lon: 24.8281, tags: { amenity: 'cafe', name: 'Test Café' } };
const park = { name: 'Test Park', lat: 60.1860, lon: 24.8270, tags: { leisure: 'park', name: 'Test Park' } };
await fs.writeFile(path.join(dataDir, 'places.json'), JSON.stringify({ [cellKey(HERE)]: { at: Date.now(), lat: 60.18, lon: 24.84, places: [cafe, park] } }));

const { db } = await import('../server/store.js');
const circles = await import('../server/circles.js');
const engine = await import('../server/engine.js');
const clinician = await import('../server/clinician.js');

const now = () => Date.now();
function person(id, extra = {}) {
  return {
    id, name: id, username: id.toLowerCase(), createdAt: now(),
    asked: { location: true, notify: true, host: true, survey: true, strangers: true, area: true, prefs: ['coffee', 'walk', 'cook'], times: [] },
    prefs: { coffee: { a: 9, b: 1 }, walk: { a: 9, b: 1 } }, times: {}, canHost: true,
    loc: { ...HERE, acc: 20, at: now() }, home: { ...HERE }, samples: [], surveys: [], toasts: [], blocked: [],
    caps: {}, stranger: { on: false, adult: false }, paused: 0, noStreak: 0, feltNo: 0,
    lastProposalAt: now(), lastCardAt: now(), lastDoneAt: now(), showArea: true, share: null, ...extra,
  };
}
const cardsOf = (id, kind) => Object.values(db.cards).filter((c) => c.userId === id && c.status === 'open' && (!kind || c.kind === kind));
const answerKind = (id, kind, yes) => {
  const c = cardsOf(id, kind)[0];
  assert.ok(c, `${id} should have an open ${kind} card`);
  return engine.answer(id, c.id, yes);
};

beforeEach(() => {
  Object.assign(db, { users: {}, cards: {}, plans: {}, sessions: {}, pairs: {}, groups: {}, reports: [], log: [] });
  for (const id of ['Ana', 'Ben', 'Cy', 'Dee']) db.users[id] = person(id);
});
after(async () => {
  await delay(1500); // let the engine's delayed tick and the store's debounced write finish first
  assert.ok(path.basename(dataDir).startsWith('mochii-circles-'));
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('codes are readable, forgiving to type, and joining needs the exact code', () => {
  const { group } = circles.createGroup('Ana', '  Climbing   crew ');
  assert.equal(group.name, 'Climbing crew');
  assert.match(group.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const loose = group.code.toLowerCase().replace('-', ' ');
  assert.equal(circles.normaliseCode(loose), group.code);
  assert.equal(circles.normaliseCode(`https://mochii.example/join/${group.code}`), group.code);
  assert.ok(circles.joinByCode('Ben', 'ZZZZ-ZZZZ').error);
  assert.equal(circles.joinByCode('Ben', loose).group.id, group.id);
  assert.ok(circles.connected('Ana', 'Ben'));
});

test('on a shared server, people outside your groups are invisible and never paired', async () => {
  assert.deepEqual(engine.stateFor('Ana').map.friends, []);
  assert.equal(engine.stateFor('Ana').people, 1);
  assert.equal(await engine.propose('Ana', { force: true }), null);

  const { group } = circles.createGroup('Ana', 'Pair');
  circles.joinByCode('Ben', group.code);
  assert.deepEqual(engine.stateFor('Ana').map.friends.map((f) => f.name), ['Ben']);
  assert.equal(engine.stateFor('Cy').map.friends.length, 0); // Cy is on the same server, not in the group
  const plan = await engine.propose('Ana', { force: true });
  assert.deepEqual(plan.userIds.sort(), ['Ana', 'Ben']);
  assert.equal(plan.mode, 'friends');
});

test('leaving or a new code changes who can join and who is connected', () => {
  const { group } = circles.createGroup('Ana', 'G');
  const old = group.code;
  circles.joinByCode('Ben', old);
  assert.ok(circles.newGroupCode('Ben', group.id).error); // only the owner
  circles.newGroupCode('Ana', group.id);
  assert.ok(circles.joinByCode('Cy', old).error);
  circles.leaveGroup('Ana', group.id);
  assert.equal(db.groups[group.id].ownerId, 'Ben'); // handed over, not deleted
  assert.equal(circles.connected('Ana', 'Ben'), false);
});

test('stranger mode needs an 18+ yes, and only pairs two people who both turned it on', async () => {
  assert.ok(engine.setStranger('Ana', { on: true }).error);
  engine.setStranger('Ana', { on: true, adult: true });
  assert.equal(await engine.propose('Ana', { force: true }), null); // nobody else opted in
  engine.setStranger('Ben', { on: true, adult: true });
  const plan = await engine.propose('Ana', { force: true });
  assert.equal(plan.mode, 'stranger');
  assert.ok(['coffee', 'walk', 'gym', 'study'].includes(plan.activityId));
  assert.equal(plan.place.home, undefined);
  assert.equal(plan.place.found, true);
  const card = cardsOf('Ben', 'proposal')[0];
  assert.ok(card.lines.some((l) => /Someone new/.test(l.text ?? '')));
  assert.ok(!card.lines.some((l) => /away$/.test(l.text ?? ''))); // no distance to a stranger
});

test('strangers never see each other on the map, not even after "On my way"', async () => {
  engine.setStranger('Ana', { on: true, adult: true });
  engine.setStranger('Ben', { on: true, adult: true });
  const plan = await engine.propose('Ana', { force: true });
  answerKind('Ana', 'proposal', true);
  answerKind('Ben', 'proposal', true);
  assert.equal(db.plans[plan.id].status, 'confirmed');
  engine.admin.remind(plan.id);
  answerKind('Ben', 'reminder', true);
  assert.deepEqual(engine.stateFor('Ana').map.friends, []);
  assert.ok(!cardsOf('Ana', 'reminder')[0].lines.some((l) => /see you on the map/.test(l.text ?? '')));
});

test('after meeting: felt safe + both say stay in touch → friends; not safe → blocked and reported', async () => {
  engine.setStranger('Ana', { on: true, adult: true });
  engine.setStranger('Ben', { on: true, adult: true });
  engine.setStranger('Cy', { on: true, adult: true });
  db.users.Cy.paused = now() + 864e5; // keep Cy out of this first match
  const plan = await engine.propose('Ana', { force: true });
  answerKind('Ana', 'proposal', true);
  answerKind('Ben', 'proposal', true);
  engine.admin.meet(plan.id);
  engine.admin.end(plan.id);
  for (const id of ['Ana', 'Ben']) {
    answerKind(id, 'felt', true);
    answerKind(id, 'safety', true);
  }
  answerKind('Ana', 'keep', true);
  assert.equal(circles.connected('Ana', 'Ben'), false); // one yes isn't enough, and nobody is told
  answerKind('Ben', 'keep', true);
  assert.equal(circles.connected('Ana', 'Ben'), true);

  // A second stranger meet-up where Cy doesn't feel safe.
  db.users.Cy.paused = 0;
  db.users.Ben.paused = now() + 864e5;
  const p2 = await engine.propose('Cy', { force: true });
  assert.deepEqual(p2.userIds.sort(), ['Ana', 'Cy']);
  answerKind('Ana', 'proposal', true);
  answerKind('Cy', 'proposal', true);
  engine.admin.end(p2.id);
  answerKind('Cy', 'checkin', true);
  answerKind('Cy', 'felt', false);
  answerKind('Cy', 'safety', false);
  assert.ok(circles.blocked('Ana', 'Cy'));
  assert.equal(db.reports[0].about, 'Ana');
  assert.equal(cardsOf('Cy', 'keep').length, 0);
  db.plans[p2.id].status = 'done';
  assert.equal(await engine.propose('Cy', { force: true }), null); // never matched again
});

test('a care team sees only its own patients who said yes, and patients are never connected to each other', () => {
  db.users.Dee.clinician = true;
  assert.ok(circles.createGroup('Ana', 'Clinic', 'care').error); // not a clinician
  const { group } = circles.createGroup('Dee', 'Otaniemi TMS clinic', 'care');
  circles.joinByCode('Ana', group.code);
  circles.joinByCode('Ben', group.code);
  assert.equal(circles.connected('Ana', 'Ben'), false);
  db.users.Ana.surveys = [{ at: now(), who5: { score: 40, items: [2, 2, 2, 2, 2] }, phq8: { score: 12, items: [2, 2, 2, 2, 1, 1, 1, 1] }, tils: { score: 6, items: [2, 2, 2] } }];
  engine.setSurveys('Ana', { share: true });
  engine.setSurveys('Cy', { share: true }); // not in a care team: nothing to share with
  assert.equal(db.users.Cy.share, false);
  const view = clinician.overview('Dee');
  assert.deepEqual(view.people.map((p) => p.name), ['Ana']);
  assert.equal(view.notSharing, 1);
  db.users.Cy.clinician = true;
  assert.deepEqual(clinician.overview('Cy').people, []); // another clinician sees nothing
  assert.equal(clinician.canSee('Cy', 'Ana'), false);
  // a patient sees the team's staff, never the other patients
  const seen = engine.stateFor('Ana').groups.find((g) => g.kind === 'care').members.map((m) => m.name);
  assert.deepEqual(seen.sort(), ['Ana', 'Dee']);
});
