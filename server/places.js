// Finds real places for activities using OpenStreetMap (Overpass API).
//
// Public Overpass servers can take 20+ seconds, so Eden fetches ONE combined lookup per
// neighbourhood (~2 km cell) in the background as soon as someone's location arrives, and keeps it
// for a day. Suggestions then pick the nearest place instantly.
// Privacy: only the cell centre is sent (never a person's exact position or name).
// Set EDEN_PLACES=off to skip lookups ("a café near you both" + a map search instead).
import fs from 'node:fs';
import path from 'node:path';

import { ACTIVITIES } from './activities.js';
import { distance } from './geo.js';
import { DATA_DIR } from './store.js';

const ENDPOINTS = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OFF = process.env.EDEN_PLACES === 'off';
const DAY = 24 * 3600e3;
// Saved to disk so a slow public map server only has to answer once a day per area.
const CACHE_FILE = path.join(DATA_DIR, 'places.json');
const cells = new Map(); // key -> { at, lat, lon, places: [{name, lat, lon, tags}] }
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')))) {
    if (Date.now() - v.at < 24 * 3600e3) cells.set(k, v);
  }
} catch {
  // no cache yet
}
const saveCache = () => fs.promises.writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(cells))).catch(() => {});
const inflight = new Map(); // key -> Promise
const failedAt = new Map(); // key -> time of last failed lookup (don't hammer a busy server)

const SELECTORS = [...new Set(ACTIVITIES.flatMap((a) => a.osm ?? []))];

function cellOf(p) {
  const lat = Math.round(p.lat / 0.02) * 0.02;
  const lon = Math.round(p.lon / 0.04) * 0.04;
  return { key: `${lat.toFixed(2)},${lon.toFixed(2)}`, lat, lon };
}

function matches(tags, selectors) {
  return selectors.some((sel) =>
    [...sel.matchAll(/\[([^\]=!]+)(!?=)([^\]]+)\]/g)].every(([, k, op, v]) => (op === '=' ? tags[k] === v : tags[k] !== v)),
  );
}

async function fetchCell(cell) {
  const around = `(around:4000,${cell.lat.toFixed(4)},${cell.lon.toFixed(4)})`;
  const query = `[out:json][timeout:40];(${SELECTORS.map((s) => `nwr${s}${around};`).join('')});out center;`;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'eden-prototype/0.2' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const places = (json.elements || [])
        .map((e) => ({ name: e.tags?.name, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, tags: e.tags || {} }))
        .filter((e) => e.name && Number.isFinite(e.lat) && Number.isFinite(e.lon));
      cells.set(cell.key, { at: Date.now(), lat: cell.lat, lon: cell.lon, places });
      failedAt.delete(cell.key);
      void saveCache();
      console.log(`[places] ${places.length} named places around ${cell.key}`);
      return true;
    } catch {
      // try the next server
    }
  }
  failedAt.set(cell.key, Date.now());
  console.log(`[places] map server busy around ${cell.key}; will retry in a few minutes`);
  return false;
}

/** Start (or reuse) the background lookup for the area around a point. */
export function prefetch(point) {
  if (OFF || !point) return Promise.resolve(false);
  const cell = cellOf(point);
  const cached = cells.get(cell.key);
  if (cached && Date.now() - cached.at < DAY) return Promise.resolve(true);
  if (Date.now() - (failedAt.get(cell.key) ?? 0) < 3 * 60e3) return Promise.resolve(false);
  if (!inflight.has(cell.key)) {
    inflight.set(cell.key, fetchCell(cell).finally(() => inflight.delete(cell.key)));
  }
  return inflight.get(cell.key);
}

export async function findPlace(activity, near) {
  const fallback = { name: activity.placeLabel, lat: near.lat, lon: near.lon, search: activity.search, found: false };
  if (OFF || !activity.osm) return fallback;
  // Lookups overlap, so places fetched for a neighbouring area count too.
  const pool = () => [...cells.values()].filter((c) => distance(near, c) < 6000).flatMap((c) => c.places);
  if (!cells.has(cellOf(near).key)) {
    const pending = prefetch(near);
    // Nothing known around here yet: wait a little, but never block a suggestion for long.
    if (!pool().length) await Promise.race([pending, new Promise((r) => setTimeout(r, 8000))]);
  }
  const best = pool()
    .filter((p) => matches(p.tags, activity.osm))
    .map((p) => ({ ...p, d: distance(near, p) }))
    .filter((p) => p.d < 3500)
    .sort((a, b) => a.d - b.d)[0];
  return best ? { name: best.name, lat: best.lat, lon: best.lon, found: true } : fallback;
}
