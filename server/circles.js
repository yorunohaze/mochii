// Groups (friend groups and care teams), invite codes, blocking and reports.
//
// Mochii runs on one shared server, so nobody sees or gets paired with anybody just because they signed up.
//  - Friend groups: anyone can start one and invite people with a code. Mochii only pairs people who share a
//    friend group, and only they can see each other's cat, rough area and weather on the map.
//  - Care teams: a clinician starts one and gives patients its code. Joining never connects patients to each other;
//    it only lets that team see check-ins the patient chooses to share.
//  - Stranger mode (engine.js) is the one, opt-in exception, with its own safety rules.
import crypto from 'node:crypto';

import { newId } from './security.js';
import { db, log } from './store.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: easy to read out loud
export const MAX_MEMBERS = 30;
export const MAX_GROUPS_PER_USER = 12;

const groups = () => (db.groups ??= {});
const reports = () => (db.reports ??= []);

/** 8 characters (~1e12 combinations, plus rate limits), shown as XXXX-XXXX. */
function newCode() {
  for (;;) {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!Object.values(groups()).some((g) => g.code === code)) return code;
  }
}

/** Accepts "k7q2 m9xt", "K7Q2M9XT", "K7Q2-M9XT" or a full /join/ link. */
export function normaliseCode(input) {
  const s = String(input ?? '').toUpperCase().split('/JOIN/').pop().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
}

export const groupByCode = (code) => {
  const c = normaliseCode(code);
  return c ? Object.values(groups()).find((g) => g.code === c) ?? null : null;
};

export const groupsOf = (userId, kind) =>
  Object.values(groups()).filter((g) => g.members[userId] && (!kind || g.kind === kind));

/** True when two people share at least one friend group and neither has blocked the other. */
export function connected(a, b) {
  if (!a || !b || a === b || blocked(a, b)) return false;
  return groupsOf(a, 'friends').some((g) => g.members[b]);
}

/** Everyone someone shares a friend group with (not counting blocks). */
export function friendIdsOf(userId) {
  const ids = new Set();
  for (const g of groupsOf(userId, 'friends')) for (const id of Object.keys(g.members)) if (id !== userId) ids.add(id);
  for (const id of [...ids]) if (blocked(userId, id)) ids.delete(id);
  return ids;
}

export function blocked(a, b) {
  return !!(db.users[a]?.blocked?.includes(b) || db.users[b]?.blocked?.includes(a));
}

export function createGroup(ownerId, name, kind = 'friends') {
  const owner = db.users[ownerId];
  if (!owner) return { error: 'Not signed in.' };
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!clean) return { error: 'Give your group a name.' };
  if (kind === 'care' && !owner.clinician) return { error: 'Only clinician accounts can start a care team.' };
  if (groupsOf(ownerId).length >= MAX_GROUPS_PER_USER) return { error: `You can be in up to ${MAX_GROUPS_PER_USER} groups.` };
  const g = {
    id: newId(),
    name: clean,
    kind,
    code: newCode(),
    ownerId,
    members: { [ownerId]: { role: kind === 'care' ? 'staff' : 'owner', at: Date.now() } },
    createdAt: Date.now(),
  };
  groups()[g.id] = g;
  log(`${owner.name} started ${kind === 'care' ? 'care team' : 'group'} “${clean}”`);
  return { group: g };
}

/** Friend groups made automatically when two people met in stranger mode and both said "stay in touch". */
export function createPairGroup(a, b) {
  const [ua, ub] = [db.users[a], db.users[b]];
  if (!ua || !ub || connected(a, b)) return null;
  const g = {
    id: newId(),
    name: `${ua.name} & ${ub.name}`,
    kind: 'friends',
    code: newCode(),
    ownerId: a,
    members: { [a]: { role: 'owner', at: Date.now() }, [b]: { role: 'member', at: Date.now() } },
    fromStrangerMode: true,
    createdAt: Date.now(),
  };
  groups()[g.id] = g;
  log(`🤝 ${ua.name} and ${ub.name} met in stranger mode and became friends`);
  return g;
}

export function joinByCode(userId, code) {
  const u = db.users[userId];
  const g = groupByCode(code);
  if (!u) return { error: 'Not signed in.' };
  if (!g) return { error: "That code didn't match a group. Check it with the person who sent it." };
  if (g.members[userId]) return { group: g, already: true };
  if (Object.keys(g.members).length >= MAX_MEMBERS) return { error: 'That group is full.' };
  if (groupsOf(userId).length >= MAX_GROUPS_PER_USER) return { error: `You can be in up to ${MAX_GROUPS_PER_USER} groups.` };
  const owner = db.users[g.ownerId];
  if (owner && blocked(userId, g.ownerId)) return { error: "That code didn't match a group. Check it with the person who sent it." };
  g.members[userId] = { role: g.kind === 'care' ? 'patient' : 'member', at: Date.now() };
  log(`${u.name} joined ${g.kind === 'care' ? 'care team' : 'group'} “${g.name}”`);
  return { group: g };
}

export function leaveGroup(userId, groupId) {
  const g = groups()[groupId];
  if (!g?.members[userId]) return { error: "You're not in that group." };
  delete g.members[userId];
  const left = Object.keys(g.members);
  if (!left.length) delete groups()[groupId];
  else if (g.ownerId === userId) {
    // Hand the group to whoever has been in it longest (staff first in a care team).
    const next = left.sort((x, y) => (g.members[y].role === 'staff') - (g.members[x].role === 'staff') || g.members[x].at - g.members[y].at)[0];
    g.ownerId = next;
    if (g.kind === 'friends') g.members[next].role = 'owner';
  }
  return { ok: true };
}

export function removeMember(ownerId, groupId, memberId) {
  const g = groups()[groupId];
  if (!g || g.ownerId !== ownerId) return { error: 'Only the person who started the group can remove people.' };
  if (memberId === ownerId) return leaveGroup(ownerId, groupId);
  if (!g.members[memberId]) return { error: "They're not in this group." };
  delete g.members[memberId];
  return { ok: true };
}

/** A fresh code: the old one stops working (e.g. if it was shared too widely). */
export function newGroupCode(ownerId, groupId) {
  const g = groups()[groupId];
  if (!g || g.ownerId !== ownerId) return { error: 'Only the person who started the group can change its code.' };
  g.code = newCode();
  return { group: g };
}

export function block(userId, otherId, { report = false, reason = '', planId = null } = {}) {
  const u = db.users[userId];
  if (!u || !db.users[otherId] || userId === otherId) return;
  u.blocked = [...new Set([...(u.blocked ?? []), otherId])];
  // Blocking also removes you from groups you only share because of a stranger-mode meet-up.
  for (const g of groupsOf(userId, 'friends')) {
    if (g.fromStrangerMode && g.members[otherId] && Object.keys(g.members).length === 2) delete groups()[g.id];
  }
  if (report) {
    reports().unshift({ id: newId(), at: Date.now(), by: userId, about: otherId, reason: String(reason).slice(0, 200), planId, status: 'open' });
    if (reports().length > 500) reports().length = 500;
    log(`⚑ A safety report was filed (see Reports)`); // no names in the shared log
  }
}

export function removeUserFromGroups(userId) {
  for (const g of groupsOf(userId)) leaveGroup(userId, g.id);
  for (const v of Object.values(db.users)) if (v.blocked?.includes(userId)) v.blocked = v.blocked.filter((x) => x !== userId);
}

/** What the person themself sees about their groups. Codes only for members; names only, never usernames. */
export function groupsFor(userId) {
  return groupsOf(userId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      code: g.code,
      mine: g.ownerId === userId,
      role: g.members[userId].role,
      fromStrangerMode: !!g.fromStrangerMode,
      // A patient never sees the other patients of a care team: only its staff.
      members: Object.entries(g.members)
        .filter(([id, m]) => db.users[id] && (g.kind === 'friends' || m.role === 'staff' || id === userId))
        .map(([id, m]) => ({ id, name: db.users[id].name, role: m.role, you: id === userId })),
      size: Object.keys(g.members).length,
    }));
}

/** Public preview for an invite link: just enough to say "You're invited to …". */
export function invitePreview(code) {
  const g = groupByCode(code);
  if (!g) return null;
  return { name: g.name, kind: g.kind, size: Object.keys(g.members).length, by: db.users[g.ownerId]?.name ?? null };
}

export const allReports = () => reports();
export const allGroups = () => Object.values(groups());
