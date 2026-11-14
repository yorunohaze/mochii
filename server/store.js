// Tiny JSON-file database. Everything lives on the host's own machine in ./data.
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.EDEN_DATA_DIR
  ? path.resolve(process.env.EDEN_DATA_DIR)
  : path.resolve(import.meta.dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

const empty = () => ({ users: {}, sessions: {}, cards: {}, plans: {}, pairs: {}, log: [] });

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = (() => {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return empty();
  }
})();

let timer = null;
export function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const text = JSON.stringify(db);
    try {
      fs.writeFileSync(FILE + '.tmp', text);
      fs.renameSync(FILE + '.tmp', FILE);
    } catch {
      fs.writeFileSync(FILE, text);
    }
  }, 250);
}

export function resetDb() {
  const fresh = empty();
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, fresh);
  save();
}

/** Host-visible activity log (shown on the dashboard). */
export function log(text) {
  db.log.unshift({ at: Date.now(), text });
  if (db.log.length > 300) db.log.length = 300;
  save();
}
