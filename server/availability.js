// A repeating week in the owner's time zone. Monday = 0; each cell is 30 minutes.
// Missing/disabled schedules retain flexible scheduling. An enabled, empty week means unavailable.
const MINUTE = 60_000;
const formatters = new Map();
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DEFAULT_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function normalizeAvailability(value) {
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' ||
      typeof value.timeZone !== 'string' || value.timeZone.length > 100 ||
      !Array.isArray(value.days) || value.days.length !== 7) return null;
  let timeZone;
  try {
    timeZone = new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).resolvedOptions().timeZone;
  } catch { return null; }
  const days = [];
  for (const day of value.days) {
    if (!Array.isArray(day) || day.length > 48 || day.some(cell => !Number.isInteger(cell) || cell < 0 || cell > 47)) return null;
    days.push([...new Set(day)].sort((a, b) => a - b));
  }
  return { enabled: value.enabled, timeZone, days };
}

export function localTime(at, timeZone = DEFAULT_ZONE) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (formatters.size >= 100) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]));
  return { day: weekdays.indexOf(parts.weekday), hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** Check the whole real interval, including midnight and daylight-saving transitions. */
export function fitsAvailability(schedule, startAt, endAt) {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return false;
  if (!schedule?.enabled) return true;
  for (let at = startAt; at < endAt;) {
    const { day, hour, minute } = localTime(at, schedule.timeZone);
    if (!schedule.days[day].includes(hour * 2 + Math.floor(minute / 30))) return false;
    // Advance to the next local half-hour boundary, not a fixed UTC weekday/offset.
    at += (30 - minute % 30) * MINUTE - (at % MINUTE);
  }
  return true;
}
