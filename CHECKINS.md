# Check-ins: validated questionnaires in Eden

Every two weeks, Eden can ask a short check-in made of three validated questionnaires. It helps Eden notice what someone needs to stay well. With a second, separate yes, it also gives a care team a quick look between visits. This file explains what Eden asks, why, how the answers are used, and where every number comes from.

Eden is not a medical device. The check-in doesn't diagnose anything, and nobody watches the answers in real time.

---

## Why a check-in

- **Relapse after TMS is common.** In a meta-analysis of 19 studies, about two thirds of people who responded to rTMS still responded at 3 months, about half at 6 months and 46% at 12 months. Maintenance treatment may extend the effect (Senova et al., 2019).
- **Leftover symptoms are one of the strongest warning signs.** A four-phase systematic review ranked residual symptoms, earlier episodes and childhood maltreatment as the best-supported risk factors for relapse and recurrence (Buckman et al., 2018). Residual symptoms are the one you can follow at home with a short validated scale.
- **Loneliness and poor social support predict worse outcomes in depression** (Wang et al., 2018). This is exactly what Eden works on, so Eden also measures it.

## What Eden asks

| Questionnaire | Measures | Questions | Answers | Score | Period |
|---|---|---|---|---|---|
| **WHO-5** Well-Being Index | Wellbeing (positive mental health) | 5 | 6 options, "At no time" (0) to "All of the time" (5) | Raw 0–25 × 4 = **0–100** | Last two weeks |
| **PHQ-8** Patient Health Questionnaire | Depression symptoms | 8 | 4 options, "Not at all" (0) to "Nearly every day" (3) | **0–24** | Last 2 weeks |
| **Three-Item Loneliness Scale** (TILS, often called "UCLA-3") | Loneliness | 3 | "Hardly ever" (1), "Some of the time" (2), "Often" (3) | **3–9** | Now |

That's 16 taps in total. The wording, answer options and scoring are the published ones, in `server/questionnaires.js`. Changing them would break the validation, so don't edit them to fit the yes/no style. They're the one place in Eden with more than two buttons.

**Licences:**
- **PHQ:** the PHQ screeners state "No permission required to reproduce, translate, display or distribute" ([phqscreeners.com](https://www.phqscreeners.com)).
- **WHO-5:** free to use. Check the current terms on the official WHO-5 site before a formal study.
- **TILS:** published in full in Hughes et al. (2004) and used, for example, in the UK Office for National Statistics' national loneliness indicators.

### Why the PHQ-8 and not the PHQ-9

Item 9 of the PHQ-9 asks about thoughts of being better off dead or of self-harm. The PHQ-8 drops it. It's meant for settings where nobody can respond to a worrying answer in time (Kroenke et al., 2009). That is Eden's situation: answers sit on a laptop, and nobody is on call.

A meta-analysis of individual participant data found the PHQ-8's accuracy for major depression very close to the PHQ-9's (Wu et al., 2020). Leaving item 9 out does not make Eden a safety tool. Instead:
- Every person's menu (☰) always shows the MIELI Crisis Helpline (09 2525 0111, 24/7) and 112.
- A heavy check-in brings up a support card with both numbers (see below).

## How a check-in works

- **Consent first.** After onboarding, Eden asks once: "Would a short check-in every two weeks be okay?" "Not now" is respected. Check-ins can be started, stopped or run early from the menu.
- **One question per card,** WHO-5 first, so it doesn't open with symptoms. Plan questions (suggestions, reminders) always come first, and a half-done check-in never blocks plans.
- **Every 14 days.** If a check-in isn't finished within 3 days, Eden drops it and tries again 2 days later. The questions ask about the last two weeks, so old half-answers aren't kept. In demo rhythm, check-ins come every 30 minutes instead.
- **Sharing is a second, separate yes,** asked after the first check-in: "Share your check-ins with your care team?" It shares only the check-in answers and how often the person met up with people, never places, names of friends or plans. It can be switched off any time in the menu.

## How Eden uses the answers

1. **Gentler suggestions.** A check-in from the last four weeks with PHQ-8 ≥ 10, WHO-5 ≤ 50 or loneliness ≥ 6 puts Eden into its "quieter stretch" mode. Suggestions become smaller, closer and lower in effort, and come a little more often. This happens whether or not the person shares.
2. **A support card after a heavy check-in.** PHQ-8 ≥ 15 (moderately severe) brings up: "The last two weeks sound heavy. Would it help to talk to your care team or someone you trust?" The card has tappable links to MIELI and 112.
3. **The care-team view** (`/clinician`, host computer only) shows people who chose to share. Each person gets a status from the fixed rules below, the reasons, a plain summary, their check-in history and their meet-ups.

### Care-team rules

People are compared only with their own first check-in, never with other people.

| Rule | Status | Source |
|---|---|---|
| PHQ-8 ≥ 15 (moderately severe or severe) | Might need a call | Severity bands 5/10/15/20: Kroenke et al., 2001 |
| PHQ-8 up ≥ 5 points since their first check-in | Might need a call | 5 points = reliable change for one person: Löwe et al., 2004 |
| PHQ-8 ≥ 10 | Keep an eye on | Cut-point for current depression: Kroenke et al., 2009 |
| WHO-5 ≤ 50 | Keep an eye on | Depression screening cut-off: Topp et al., 2015 |
| WHO-5 down ≥ 10 points since their first check-in | Keep an eye on | 10 points = clinically relevant change: Topp et al., 2015 |
| Loneliness ≥ 6 | Keep an eye on | Commonly used. There is **no agreed cut-off** for the TILS |
| No check-in for 21 days (check-ins on) | Keep an eye on | Eden's own rule: missing check-ins can mean withdrawal |
| Said no to all of 3+ suggestions in 2 weeks | Keep an eye on | Eden's own rule |
| 2+ meet-ups in 2 weeks that didn't lift their mood | Keep an eye on | Eden's own rule (the "doing vs. feeling" gap) |

The last three rules are product heuristics, not published thresholds.

## AI summaries (optional)

If the host computer has `ANTHROPIC_API_KEY` set, the care-team view gets a **Write AI summary** button for each person. Claude (`claude-opus-5-5`) turns the numbers into a short summary for a busy clinician: a headline, two to four sentences, and up to three things worth asking about.

**Claude gets:**
- Totals for each check-in, labelled "days ago".
- Meet-up counts.
- The rule status and reasons.
- Whether sample data is included.

**Claude never gets:**
- The person's name. They're "Person A", and the name is put back on the host computer.
- Their username, places, friends, plan details or dates.
- Item-level answers.

**Other rules:**
- Rules decide the status. Claude is told to explain it, not change it, and not to diagnose.
- The answer comes back in a fixed JSON format. If Claude declines, the API retries on Anthropic's recommended fallback model.
- Summaries are kept in memory only and refreshed when the data changes.
- Without a key, the rule-based summary still works and nothing leaves the laptop.

## Demo tools (host dashboard)

- **Check-in now** starts a check-in for that person. If they haven't said yes to check-ins yet, it asks them first.
- **+ sample: steady / slipping** adds four made-up check-ins two weeks apart, so the care-team view has a history to show. Sample entries are labelled everywhere they appear. The person still has to say yes to sharing on their phone before they show up in the care-team view.

## Limits

- The cut-offs come from population studies. For one person, the trend against their own first check-in matters more than any single number.
- None of these questionnaires was validated as a relapse predictor in a TMS population. That needs a proper study, together with the clinicians.
- Validated translations exist (the PHQ has translations in many languages), but Eden currently asks in English only.
- Check-in answers are health data, a special category of personal data under the GDPR. A real deployment needs a legal basis, a data processing agreement for any AI provider, and secure hosting. This prototype runs on one laptop.

## References

1. Kroenke K, Spitzer RL, Williams JBW. The PHQ-9: validity of a brief depression severity measure. *J Gen Intern Med.* 2001;16(9):606–613. [doi:10.1046/j.1525-1497.2001.016009606.x](https://doi.org/10.1046/j.1525-1497.2001.016009606.x)
2. Kroenke K, Strine TW, Spitzer RL, Williams JBW, Berry JT, Mokdad AH. The PHQ-8 as a measure of current depression in the general population. *J Affect Disord.* 2009;114(1–3):163–173. [doi:10.1016/j.jad.2008.06.026](https://doi.org/10.1016/j.jad.2008.06.026)
3. Wu Y, Levis B, et al. Equivalency of the diagnostic accuracy of the PHQ-8 and PHQ-9: a systematic review and individual participant data meta-analysis. *Psychol Med.* 2020;50(8):1368–1380. [doi:10.1017/S0033291719001314](https://doi.org/10.1017/S0033291719001314)
4. Löwe B, Unützer J, Callahan CM, Perkins AJ, Kroenke K. Monitoring depression treatment outcomes with the Patient Health Questionnaire-9. *Med Care.* 2004;42(12):1194–1201. [doi:10.1097/00005650-200412000-00006](https://doi.org/10.1097/00005650-200412000-00006)
5. Topp CW, Østergaard SD, Søndergaard S, Bech P. The WHO-5 Well-Being Index: a systematic review of the literature. *Psychother Psychosom.* 2015;84(3):167–176. [doi:10.1159/000376585](https://doi.org/10.1159/000376585)
6. Hughes ME, Waite LJ, Hawkley LC, Cacioppo JT. A short scale for measuring loneliness in large surveys: results from two population-based studies. *Res Aging.* 2004;26(6):655–672. [doi:10.1177/0164027504268574](https://doi.org/10.1177/0164027504268574)
7. Buckman JEJ, Underwood A, Clarke K, et al. Risk factors for relapse and recurrence of depression in adults and how they operate: a four-phase systematic review and meta-synthesis. *Clin Psychol Rev.* 2018;64:13–38. [doi:10.1016/j.cpr.2018.07.005](https://doi.org/10.1016/j.cpr.2018.07.005)
8. Wang J, Mann F, Lloyd-Evans B, Ma R, Johnson S. Associations between loneliness and perceived social support and outcomes of mental health problems: a systematic review. *BMC Psychiatry.* 2018;18:156. [doi:10.1186/s12888-018-1736-5](https://doi.org/10.1186/s12888-018-1736-5)
9. Senova S, Cotovio G, Pascual-Leone A, Oliveira-Maia AJ. Durability of antidepressant response to repetitive transcranial magnetic stimulation: systematic review and meta-analysis. *Brain Stimul.* 2019;12(1):119–128. [doi:10.1016/j.brs.2018.10.001](https://doi.org/10.1016/j.brs.2018.10.001)
10. PHQ Screeners: instructions, translations and terms of use. [phqscreeners.com](https://www.phqscreeners.com)
