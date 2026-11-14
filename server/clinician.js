// Care-team view: a quick look at how each person who chose to share has been doing, from their check-ins and how
// often they've met up with people. Fixed rules decide who might need a call (every threshold is cited in
// CHECKINS.md). Claude only writes the plain-language summary, from numbers with no name, place, partner or date.
// Not a diagnosis.
import Anthropic from '@anthropic-ai/sdk';

import { CUT, INSTRUMENTS, phq8Band } from './questionnaires.js';
import { db } from './store.js';

const DAY = 864e5;
const STATUS = ['Doing okay', 'Keep an eye on', 'Might need a call'];
const ALIAS = 'Person A';

/* ------------------------------------------------------------------ meet-ups */

function activity(userId, from, to) {
  const cards = Object.values(db.cards).filter((c) => c.userId === userId && c.createdAt >= from && c.createdAt < to);
  const proposals = cards.filter((c) => c.kind === 'proposal');
  const felt = cards.filter((c) => c.kind === 'felt'); // only asked after people actually met
  return {
    suggestions: proposals.length,
    saidYes: proposals.filter((c) => c.answer === true).length,
    leftUnanswered: proposals.filter((c) => {
      const plan = db.plans[c.planId];
      return c.status === 'expired' && plan?.cancelReason === 'no answer' && plan.answers[userId] == null;
    }).length,
    metUp: felt.length,
    liftedMood: felt.filter((c) => c.answer === true).length,
    feltFlat: felt.filter((c) => c.answer === false).length,
  };
}

function lastMeetup(userId) {
  let t = 0;
  for (const c of Object.values(db.cards)) if (c.userId === userId && c.kind === 'felt' && c.createdAt > t) t = c.createdAt;
  return t || null;
}

/* --------------------------------------------------------------------- rules */

/** Who might need a call, and why. Compares people only with their own first check-in, never with others. */
function assess(u, now) {
  const all = u.surveys ?? [];
  const latest = all.at(-1);
  const first = all[0];
  const reasons = [];
  let level = 0;
  const flag = (l, text) => {
    level = Math.max(level, l);
    reasons.push(text);
  };
  if (latest) {
    const p = latest.phq8.score;
    const w = latest.who5.score;
    if (p >= CUT.phq8High) flag(2, `PHQ-8 is ${p} (${phq8Band(p)}).`);
    else if (p >= CUT.phq8Moderate) flag(1, `PHQ-8 is ${p} (${phq8Band(p)}).`);
    if (all.length > 1 && p - first.phq8.score >= CUT.phq8Change) {
      flag(2, `PHQ-8 rose ${p - first.phq8.score} points since their first check-in (${first.phq8.score} → ${p}).`);
    }
    if (w <= CUT.who5Low) flag(1, `WHO-5 wellbeing is low (${w}/100).`);
    if (all.length > 1 && first.who5.score - w >= CUT.who5Change) {
      flag(1, `WHO-5 fell ${first.who5.score - w} points since their first check-in (${first.who5.score} → ${w}).`);
    }
    if (latest.tils.score >= CUT.tilsLonely) flag(1, `Often feels lonely (loneliness ${latest.tils.score}/9).`);
    if (u.surveysOn && now - latest.at > 21 * DAY) flag(1, `No check-in for ${Math.round((now - latest.at) / DAY)} days.`);
  }
  const recent = activity(u.id, now - 14 * DAY, now);
  if (recent.suggestions >= 3 && recent.saidYes === 0) flag(1, `Said no to all ${recent.suggestions} suggestions in the last 2 weeks.`);
  if (recent.feltFlat >= 2) flag(1, `${recent.feltFlat} meet-ups in the last 2 weeks didn't lift their mood.`);
  return { level, reasons, recent, before: activity(u.id, now - 28 * DAY, now - 14 * DAY) };
}

const ago = (t, now) => {
  const d = Math.round((now - t) / DAY);
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};
const times = (n) => (n === 1 ? 'once' : `${n} times`);
const suggestions = (n) => `${n} suggestion${n === 1 ? '' : 's'}`;

/** The same picture in words, built here on the host computer (so it may use names and item answers). */
function describe(u, a, now) {
  const latest = u.surveys?.at(-1);
  const parts = [];
  if (!latest) parts.push(`${u.name} hasn't done a check-in yet.`);
  else {
    parts.push(`Last check-in ${ago(latest.at, now)}: PHQ-8 ${latest.phq8.score} (${phq8Band(latest.phq8.score)}), WHO-5 ${latest.who5.score}/100, loneliness ${latest.tils.score}/9.`);
    const most = latest.phq8.items
      .map((v, i) => (v >= 2 ? `${INSTRUMENTS.phq8.short[i]}${v === 3 ? ' (nearly every day)' : ''}` : null))
      .filter(Boolean);
    if (most.length) parts.push(`Most bothered by: ${most.join(', ')}.`);
  }
  const r = a.recent;
  parts.push(`Last 2 weeks: ${suggestions(r.suggestions)}, said yes to ${r.saidYes}, met up ${times(r.metUp)}.`);
  parts.push(`The 2 weeks before: ${suggestions(a.before.suggestions)}, met up ${times(a.before.metUp)}.`);
  return parts.join(' ');
}

/* ------------------------------------------------------------------ overview */

export function overview() {
  const now = Date.now();
  const users = Object.values(db.users);
  const shared = users.filter((u) => u.share === true);
  const people = shared
    .map((u) => {
      const a = assess(u, now);
      const all = u.surveys ?? [];
      const cached = cache.get(u.id);
      return {
        id: u.id,
        name: u.name,
        status: { level: a.level, label: STATUS[a.level] },
        reasons: a.reasons,
        summary: describe(u, a, now),
        checkins: all.map((s) => ({ at: s.at, phq8: s.phq8.score, band: phq8Band(s.phq8.score), who5: s.who5.score, tils: s.tils.score, sample: !!s.sample })),
        activity: { recent: a.recent, before: a.before, lastMeetupAt: lastMeetup(u.id) },
        sample: all.some((s) => s.sample),
        ai: cached && cached.key === JSON.stringify(payloadFor(u, now)) ? withName(cached, u.name) : null,
      };
    })
    .sort((x, y) => y.status.level - x.status.level || x.name.localeCompare(y.name));
  return { people, notSharing: users.length - shared.length, aiReady: aiReady() };
}

/* ---------------------------------------------------------------- AI summary */

const SYSTEM = `You help a clinician quickly see how someone recovering from depression has been doing between visits.
The data comes from Mochii, a non-clinical app that suggests meeting up with friends and, with the person's consent, runs a short validated check-in every two weeks.

Measures:
- PHQ-8 (0-24): 5, 10, 15 and 20 mark mild, moderate, moderately severe and severe symptoms. A change of 5 or more points is a reliable change for one person.
- WHO-5 wellbeing (0-100): 50 or below suggests low wellbeing. A change of 10 or more points is clinically relevant.
- Three-Item Loneliness Scale (3-9): 6 or more is often used to mean lonely, though there is no agreed cut-off.
- Meet-ups: suggestions Mochii made, how many the person said yes to, how many happened, and whether those lifted their mood.

The status and reasons were set by fixed rules. Explain them; don't change or second-guess them.
Write for a busy clinician: plain language, the numbers and their direction, what stands out compared with this person's own earlier check-ins, and what could be worth asking about in a call. Don't diagnose and don't go beyond the data. Say so when data is thin or missing.
Call the person "${ALIAS}" and use they/them. If includesSampleData is true, say that the check-ins include sample data.`;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One short line.' },
    summary: { type: 'string', description: 'Two to four sentences.' },
    askAbout: { type: 'array', items: { type: 'string' }, description: 'Up to three things worth asking about in a call.' },
  },
  required: ['headline', 'summary', 'askAbout'],
  additionalProperties: false,
};

const cache = new Map(); // userId -> { key, at, model, result }: kept in memory only
let anthropic = null;

export const aiReady = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** Everything Claude sees: numbers only. Days ago instead of dates; the rule reasons never contain names. */
function payloadFor(u, now) {
  const a = assess(u, now);
  const all = u.surveys ?? [];
  const last = lastMeetup(u.id);
  return {
    person: ALIAS,
    checkinsOn: !!u.surveysOn,
    checkins: all.map((s) => ({ daysAgo: Math.round((now - s.at) / DAY), phq8: s.phq8.score, who5: s.who5.score, loneliness: s.tils.score })),
    meetups: { last14Days: a.recent, previous14Days: a.before, daysSinceLastMeetup: last ? Math.round((now - last) / DAY) : null },
    status: STATUS[a.level],
    reasons: a.reasons,
    includesSampleData: all.some((s) => s.sample),
  };
}

function withName(cached, name) {
  const named = (s) => s.replaceAll(ALIAS, name);
  const r = cached.result;
  return { at: cached.at, model: cached.model, headline: named(r.headline), summary: named(r.summary), askAbout: r.askAbout.map(named) };
}

export async function aiSummary(userId) {
  const u = db.users[userId];
  if (u?.share !== true) return { error: 'Only for people who chose to share their check-ins.' };
  if (!aiReady()) return { error: 'Set ANTHROPIC_API_KEY on the host computer to turn on AI summaries.' };
  const payload = payloadFor(u, Date.now());
  const key = JSON.stringify(payload);
  try {
    anthropic ??= new Anthropic();
    const response = await anthropic.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      // If Claude declines, the API reruns the request on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
    });
    if (response.stop_reason === 'refusal') return { error: "Claude couldn't write this summary. The rule-based summary still applies." };
    if (response.stop_reason === 'max_tokens') return { error: 'The summary was cut off. Try again.' };
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const entry = { key, at: Date.now(), model: response.model, result: JSON.parse(text) };
    cache.set(u.id, entry);
    return { ai: withName(entry, u.name) };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { error: 'The Anthropic API key was not accepted.' };
    if (e instanceof Anthropic.RateLimitError) return { error: 'Claude is busy right now. Try again in a minute.' };
    if (e instanceof Anthropic.APIConnectionError) return { error: "Can't reach the Claude API. Is this computer online?" };
    if (e instanceof Anthropic.APIError) return { error: `Claude API error (${e.status}). The rule-based summary still applies.` };
    if (e instanceof SyntaxError) return { error: "Claude's answer couldn't be read. Try again." };
    throw e;
  }
}
