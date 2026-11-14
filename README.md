# Mochii — social media that is actually social

A little cat helping you spend more time with your people. **Mochii runs on one shared server.** Everyone signs up, starts a **friend group** or joins one with a **code**, and from then on **Mochii takes the first step**: coffee, a walk, cooking, the gym, groceries, sauna, a movie night… You just say **Yes** or **No**. People without a group yet can turn on **stranger mode** to meet someone new, safely.

Originally Project Eden, built around making connection easier when reaching out feels hard. Nobody has to send the first message, pick a plan or find a place. Optional private wellbeing check-ins, shared only with a care team you join, remain available.

The cat theme adapts the cream, peach, mint and lavender palette, cocoa outlines, rounded Nunito typography and cat artwork from `Hackathon-Junction/mochi`. **Explore** opens the map, **Our plans** shows confirmed meet-ups, and **My space** holds groups, stranger mode, sharing, notifications and check-in settings. The font's license is included in `public/fonts/OFL.txt`.

The existing `eden` session cookie, browser preferences, `EDEN_*` environment variables and `data/` layout are retained so existing accounts keep working. Accounts from the old one-circle version start with no group: they need to start or join one before Mochii suggests plans between them.

---

## How it works

1. **Sign up** with a name, username and password (8+ characters). Opening a friend's invite link first (`…/join/K7Q2-M9XT`) shows *"Ana invited you to Sunday walkers"*, and you're in that group the moment your account exists.
2. **Your people.** The **+** button opens your groups. **Start a group** gives it a code like `K7Q2-M9XT` and a link to share; **Join with a code** takes a friend's. Mochii only suggests plans with people in your groups, and only they can see your cat on the map. Group owners can remove people or make a new code (the old one stops working).
3. **A few yes/no questions.** Can Mochii use your location? Do you like coffee, walks, cooking? Would you have a friend over? More come up now and then.
4. **Mochii suggests something.** It picks someone from your groups, an activity you'll both probably like, a time, and a **real place between you** from OpenStreetMap, e.g. *"Grab a coffee with Ben? Today 15:00 · Hav a Java · about 600 m from you · Sunday walkers"*. **Both get the same question at the same time**, so nobody is "the one being looked after".
5. **Both say yes → it's on.** If someone says no, the other person never hears a "no". Mochii quietly finds something else. Every plan question also arrives as a **notification with the same Yes / No buttons** (see [Nudges](#nudges-when-the-app-is-closed-optional)).
6. **On the day:** a reminder ("Heading out to meet Ben soon?" → *On my way*), with a map link. **GPS notices you met** ("You're together ✨"). Afterwards: *"Did it lift you a bit?"*
7. **Mochii learns** from every yes and no: what each person likes, at which times, and with whom. On quieter stretches it suggests smaller, closer, easier things and asks less often. If outings keep feeling flat, it gently suggests talking to someone you trust.
8. **A short check-in every two weeks, if you say yes.** Three validated questionnaires (WHO-5, PHQ-8, three-item loneliness scale), one question per card. A worrying check-in makes Mochii gentler and shows crisis numbers. It stays private unless you **join a clinic's care team with their code** and then say yes to sharing. Sources and rules: [CHECKINS.md](CHECKINS.md).

No feeds, no chat, no streaks, no scores.

### Stranger mode: meeting someone new

For people who don't have a group yet, or want new faces. People without a group are offered it once, as a yes/no card. It's always in **My space**.

- **Opt-in, adults only.** You say yes and confirm you're 18+. Mochii only ever matches two people who both did.
- **Safer by design.** Only **coffee, a walk, the gym or studying**, only at a **real, named public place**, only **in daytime**, within about 6 km. Never anyone's home, never sauna.
- **Less revealing.** First names only. They never see where you are: no distance to them, no map, and no live location even after "On my way".
- **Afterwards, two yes/no questions.** *"Did you feel safe with Dee?"* A no blocks them for good, files a report for the operator, and they're never told. *"Stay in touch with Dee?"* If you both say yes, you become friends in a little group of your own; if not, nobody is told.
- **Block & report** is on every stranger-mode plan in **Our plans**.

### The map and your cat's weather

**The home screen is a map**, like Snap Map. It shows you, your plans and where you'll meet, the place Mochii is suggesting, and a ✨ when you're together. Mochii's question sits in a sheet over the map: it rises when there's something to answer. **People in your groups** appear only if they choose to, and only as a rough area (about 1 km), never their exact spot. The exception: when a friend taps **On my way** for a plan with you, you see them live until they arrive (never in stranger mode). The map is [MapLibre](https://maplibre.org) with free [OpenFreeMap](https://openfreemap.org) tiles. If WebGL or map downloads fail, Mochii shows the questions and plans with a **Try map again** button.

The **MOOD** button (bottom left) lets you choose **Sunny (happy)**, **Rainy (sad)**, **Foggy (uncertain)**, **Cloudy (low energy)**, **Stormy (overwhelmed)** or **Rainbow (hopeful)**. Your cat wears that weather. Only people in your groups who can already see your cat see its weather; choosing a mood never turns on sharing. Run `node scripts/generate-mood-cats.mjs` to regenerate the six weather variants.

On your first sign-in, Mochii shows a location invitation. **Allow location** requests the browser's permission; **Not now** keeps it off. Location needs HTTPS (or `localhost`).

---

## Run it

Needs **Node.js 20+**.

```bash
cd eden-web
npm install
node server/index.js --demo
```

`--demo` = fast rhythm for testing: suggestions every ~40 s, plans start in ~10 min, and the daytime rule for stranger mode is relaxed. Leave it off for the real rhythm: a couple of suggestions a day, between 9:00 and 20:00.
(On Windows, PowerShell may block `npm run …`; call `node` directly as above, or use `npm.cmd`.)

### Testing on your Wi-Fi

Without extra settings, Mochii also serves a self-signed HTTPS port (3443) so phones on the same Wi-Fi can use GPS. The terminal prints a **QR code** and an address like `https://192.168.0.203:3443`. The first time, Safari says *"This Connection Is Not Private"*: tap **Show Details** → **visit this website**. Invite links created while testing point at that address.

Testing alone on one computer: `http://localhost:3000`, `http://127.0.0.1:3000` and your Wi-Fi address (`http://192.168.x.x:3000`) keep separate logins, so you can be three people.

### Running it as the shared server

Put Mochii behind a reverse proxy that provides real HTTPS (Caddy, nginx, or a hosting platform), on one Node process with a persistent disk for `data/`:

```bash
PUBLIC_URL=https://mochii.example \
TRUST_PROXY=1 \
HTTPS_PORT=0 \
EDEN_ADMIN_TOKEN=<a long random secret> \
node server/index.js
```

| Variable | What it does |
|---|---|
| `PUBLIC_URL` | The address people open; used for invite links and the QR code. |
| `TRUST_PROXY=1` | Believe `X-Forwarded-For` / `X-Forwarded-Proto` from your proxy (real client IPs for rate limits, `Secure` cookies). Only set it behind a proxy. |
| `HTTPS_PORT=0` | Turn off the self-signed test certificate; the proxy does HTTPS. |
| `EDEN_ADMIN_TOKEN` | Unlocks the operator dashboard from anywhere, with that token. **Without it, the dashboard only opens on the server's own keyboard**, and never through a proxy or tunnel. |
| `PORT` | HTTP port (default 3000). |
| `EDEN_DATA_DIR` | Where data lives (default `./data`). |
| `ANTHROPIC_API_KEY` | Optional AI summaries in the care-team view. |
| `EDEN_PLACES=off` | Skip OpenStreetMap venue lookups. |

With a real HTTPS address, push notifications work too (on iPhone after **Add to Home Screen**, iOS 16.4+).

### Operator dashboard

`/admin`: on the server itself, or anywhere with `EDEN_ADMIN_TOKEN`. It shows everyone, their groups, what Mochii is asking them, learned likes, every plan, **all groups**, and **safety reports** from stranger mode (mark them handled). Per person: **clinician account** (lets them start care teams), and testing buttons (**Suggest something now**, **quieter days**, **stranger mode**, **Check-in now**, **+ sample** check-in histories). Per plan: **Remind now**, **Pretend they met**, **End → ask how it went**. **Reset everything** only exists in demo rhythm.

### Care teams

1. The operator ticks **clinician account** for a clinician's Mochii account.
2. The clinician opens `/clinician` (logged in), **starts a care team** and gets its code.
3. Patients join with that code (**Your people → Got a code?**, or the link). Joining shares nothing by itself. Patients never see each other, and are never paired with each other.
4. After a check-in, the patient is asked *"Share your check-ins with Otaniemi TMS clinic?"*, which they can stop any time.
5. The clinician sees only their own teams' patients who said yes: a status from fixed, cited rules ("Doing okay", "Keep an eye on", "Might need a call"), reasons, check-in history and meet-up counts, plus optional AI summaries (`ANTHROPIC_API_KEY`).

### Nudges when the app is closed (optional)

Whenever a plan needs your yes or no, Mochii sends a notification with that card's own buttons, e.g. **Yes, let's** / **Not this time**. Tapping a button answers right there; Mochii's reply comes back as a quiet notification. While Mochii is open in a background tab it shows these itself; when it's fully closed it needs push, which needs a trusted HTTPS address (a real server, or a tunnel such as `cloudflared tunnel --url http://localhost:3000` for testing; the dashboards stay closed to tunnel visitors).

---

## Privacy and safety

- People only ever see, and get paired with, people in their groups, or (stranger mode) another adult who also opted in. Nobody else on the server.
- On the map, people in your groups see nothing unless you say yes, then only which ~1 km area you're in, only if you've opened Mochii in the last 3 hours. The exception is the friend you're meeting, after you tap "On my way", until you arrive. Never a stranger.
- For home activities (cooking, movie night, games), the guest gets directions only after the host has said yes to hosting and to that plan. Strangers never get home activities.
- Check-ins are private. Only a care team you joined with its code sees them, and only after a separate yes. AI summaries never get a name, place, friend or date (details in [CHECKINS.md](CHECKINS.md)). The operator's activity log never shows answers.
- Security: passwords hashed with scrypt; sessions expire after 60 days without use; logins, sign-ups, invite lookups and code joins are rate-limited; invite codes are 8 characters (~10¹² combinations); the operator dashboard needs a token (or the server's own keyboard, never via a proxy).
- To find places, Mochii sends only a rough area centre (about 2 km) to OpenStreetMap's public API. Map tiles come from OpenFreeMap.
- Anyone can delete their account from the menu (☰). Old answered cards are cleared after 35 days, finished plans after 60.
- Mochii is not a medical device and doesn't diagnose.

## Checks

```bash
npm run check
npm test
```

The tests cover groups and invite codes, stranger mode and its safety questions, care-team scoping, operator access (including that tunnel/proxy requests are refused), rate limits, map visibility and consent, live sharing boundaries, map loading failures and sheet accessibility. They use temporary data and never touch your `data/` directory.

## Limits

- **One server process, data in a JSON file in memory.** Comfortable for a few thousand people; beyond that, move `store.js` to a real database (and rate limits to a shared store) before running several instances.
- **GPS only updates while Mochii is open** (true of all web apps). "You're together" detection needs both phones open around the meeting time.
- Stranger mode relies on self-declared age and a yes/no safety question; a public launch would add identity or phone verification and a staffed moderation process for reports.
- The public OpenStreetMap server is sometimes slow. Mochii then falls back to "a café near you both" with a map search; successful lookups are cached on disk.
- Check-ins are health data (special category under the GDPR): a real deployment with clinics needs a legal basis, data processing agreements and secure hosting.

## Files

```
server/index.js       HTTP(S) server: accounts, sessions, rate limits, groups/invites/stranger API, live updates (SSE),
                      operator API (token or local keyboard only), clinician API
server/circles.js     friend groups, care teams, invite codes, blocking and reports
server/engine.js      the initiator: who (groups / stranger mode), what, when, where; cards, reminders, GPS meet-ups,
                      learning (Thompson sampling), quieter-stretch care, safety questions after stranger meet-ups
server/activities.js  things to do together; which ones are okay with someone new (strangerOk)
server/questionnaires.js  the check-in: WHO-5, PHQ-8, loneliness scale (published wording and scoring)
server/clinician.js   care-team view: only a clinician's own patients who said yes; status rules, optional AI summaries
server/places.js      real places from OpenStreetMap (combined, cached lookups)
server/security.js    password hashing, tokens, self-signed test certificate
server/push.js        optional Web Push
server/store.js       JSON file storage (EDEN_DATA_DIR)
public/app.js         the phone app: map, one card at a time, Your people (groups and codes), stranger mode
public/admin.html     operator dashboard
public/clinician.html care-team view for clinician accounts
public/sw.js          service worker: notifications with Yes / No buttons
```
