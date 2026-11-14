const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

/** Distance in metres between {lat, lon} points. */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function midpoint(a, b) {
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}

/** "about 900 m" / "about 3 km". Never more precise than that. */
export function roughly(m) {
  if (m < 150) return 'right nearby';
  if (m < 950) return `about ${Math.round(m / 100) * 100} m`;
  if (m < 10000) return `about ${Math.max(1, Math.round(m / 1000))} km`;
  return `about ${Math.round(m / 5000) * 5} km`;
}

/** "right nearby" / "about 900 m away". */
export const away = (m) => (m < 150 ? 'right nearby' : `${roughly(m)} away`);

/** "right nearby" / "about 900 m from you". */
export const fromYou = (m) => (m < 150 ? 'right nearby' : `${roughly(m)} from you`);

/** Move a point by up to `metres` in a random direction (demo placement). */
export function jitter(p, metres) {
  const r = metres * Math.sqrt(Math.random());
  const t = Math.random() * 2 * Math.PI;
  return {
    lat: p.lat + (r * Math.cos(t)) / 111320,
    lon: p.lon + (r * Math.sin(t)) / (111320 * Math.cos(rad(p.lat))),
  };
}
