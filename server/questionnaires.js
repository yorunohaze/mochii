// The validated questionnaires behind Eden's check-in (every two weeks, one question per card).
// Wording, answer options and scoring are the published ones: changing them would break the validation.
// Full references, cut-offs and the reasoning behind them: CHECKINS.md.
//
//   WHO-5  wellbeing over the last two weeks. Topp et al. 2015, doi:10.1159/000376585
//   PHQ-8  depression symptoms over the last two weeks. Kroenke et al. 2009, doi:10.1016/j.jad.2008.06.026
//          This is the PHQ-9 without item 9 (thoughts of self-harm). The PHQ-8 is meant for settings where nobody can
//          respond to a worrying answer in time, which is Eden's situation. Wu et al. 2020 (doi:10.1017/S0033291719001314)
//          found its accuracy close to the PHQ-9's.
//   TILS   Three-Item Loneliness Scale, often called "UCLA-3". Hughes et al. 2004, doi:10.1177/0164027504268574
// PHQ licence: "No permission required to reproduce, translate, display or distribute" (phqscreeners.com).

const PHQ_OPTIONS = [
  { label: 'Not at all', value: 0 },
  { label: 'Several days', value: 1 },
  { label: 'More than half the days', value: 2 },
  { label: 'Nearly every day', value: 3 },
];

export const INSTRUMENTS = {
  who5: {
    name: 'WHO-5',
    stem: 'Over the last two weeks…',
    options: [
      { label: 'All of the time', value: 5 },
      { label: 'Most of the time', value: 4 },
      { label: 'More than half of the time', value: 3 },
      { label: 'Less than half of the time', value: 2 },
      { label: 'Some of the time', value: 1 },
      { label: 'At no time', value: 0 },
    ],
    items: [
      'I have felt cheerful and in good spirits',
      'I have felt calm and relaxed',
      'I have felt active and vigorous',
      'I woke up feeling fresh and rested',
      'My daily life has been filled with things that interest me',
    ],
  },
  phq8: {
    name: 'PHQ-8',
    stem: 'Over the last 2 weeks, how often have you been bothered by…',
    options: PHQ_OPTIONS,
    items: [
      'Little interest or pleasure in doing things',
      'Feeling down, depressed, or hopeless',
      'Trouble falling or staying asleep, or sleeping too much',
      'Feeling tired or having little energy',
      'Poor appetite or overeating',
      'Feeling bad about yourself — or that you are a failure or have let yourself or your family down',
      'Trouble concentrating on things, such as reading the newspaper or watching television',
      'Moving or speaking so slowly that other people could have noticed? Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual',
    ],
    // Short names for the care-team view (item answers never leave the host computer).
    short: ['interest', 'mood', 'sleep', 'energy', 'appetite', 'self-worth', 'concentration', 'slowed or restless'],
  },
  tils: {
    name: 'Three-Item Loneliness Scale',
    stem: null,
    options: [
      { label: 'Hardly ever', value: 1 },
      { label: 'Some of the time', value: 2 },
      { label: 'Often', value: 3 },
    ],
    items: ['How often do you feel that you lack companionship?', 'How often do you feel left out?', 'How often do you feel isolated from others?'],
  },
};

/** Order of one check-in: the positively worded WHO-5 first, so it doesn't open with symptoms. */
export const SURVEY = ['who5', 'phq8', 'tils'];
export const SURVEY_LENGTH = SURVEY.reduce((n, id) => n + INSTRUMENTS[id].items.length, 0);

/** WHO-5 is reported as a percentage (raw 0–25 × 4); PHQ-8 is 0–24; TILS is 3–9. */
export function score(id, answers) {
  const sum = answers.reduce((a, b) => a + b, 0);
  return id === 'who5' ? sum * 4 : sum;
}

/** Published cut-offs and change thresholds. Each one is cited in CHECKINS.md. */
export const CUT = {
  phq8Moderate: 10, // "current depression" cut-point (Kroenke et al. 2009)
  phq8High: 15, // moderately severe (Kroenke et al. 2001)
  phq8Change: 5, // reliable change for one person (Löwe et al. 2004)
  who5Low: 50, // depression screening cut-off (Topp et al. 2015)
  who5Change: 10, // clinically relevant change (Topp et al. 2015)
  tilsLonely: 6, // commonly used, but no agreed cut-off exists
};

export function phq8Band(s) {
  return s >= 20 ? 'severe' : s >= 15 ? 'moderately severe' : s >= 10 ? 'moderate' : s >= 5 ? 'mild' : 'minimal';
}

/** A recent check-in worth answering with gentler, lower-effort, more frequent company. */
export const needsSupport = (entry) => entry.phq8.score >= CUT.phq8Moderate || entry.who5.score <= CUT.who5Low || entry.tils.score >= CUT.tilsLonely;
