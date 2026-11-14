# Eden: Eden asks, you say yes or no

A web app you host on your own laptop. Friends open it on their phones, create an account, and from then on **Eden takes the first step**. It suggests doing something together: coffee, cooking, the gym, a walk, groceries, sauna, a movie night… The only thing anyone ever does is tap **Yes** or **No**.

Built for people recovering from depression, where reaching out is the hardest part. Nobody has to send the first message, pick a plan or find a place.

---

## How it works

1. **Sign up** with a name, username and password.
2. **A few yes/no questions.** Can Eden use your location? Can it send you a nudge? Do you like coffee, walks, cooking? Would you have a friend over? More questions come up now and then later.
3. **Eden suggests something.** It picks two people, an activity both will probably like, a time, and a **real place between them** from OpenStreetMap, e.g. *"Grab a coffee with Sam? Today 15:00 · Hav a Java · about 600 m from you"*. **Both get the same question at the same time**, so nobody is "the one being looked after".
4. **Both say yes → it's on.** If someone says no, the other person never hears a "no". Eden quietly finds something else.
   Every plan question also arrives as a **notification with the same Yes / No buttons**, so you can answer without opening Eden (see [Nudges](#nudges-when-the-app-is-closed-optional)).
5. **On the day:** a reminder ("Heading out to meet Sam soon?" → *On my way*), with a map link.
6. **GPS notices you met** ("You're together with Sam ✨"). Afterwards there's one question: *"Did it lift you a bit?"*
7. **Eden learns** from every yes and no. It learns what each person likes, at which times, and with whom. On quieter stretches (several no's, days without company, staying home) it suggests smaller, closer, easier things and asks less often. If outings keep feeling flat, it gently suggests talking to someone you trust.
8. **A short check-in every two weeks, if you say yes.** It uses three validated questionnaires (WHO-5, PHQ-8 and a three-item loneliness scale), one question per card. A worrying check-in makes Eden gentler. With a second yes, a care team sees how you've been between visits. Sources and rules: [CHECKINS.md](CHECKINS.md).

No feeds, no chat, no streaks, no scores.

---

## Run it

Needs **Node.js 20+**. The laptop and phones must be on the **same Wi-Fi**.

```bash
cd eden-web
npm install
node server/index.js --demo
```

`--demo` = fast rhythm for testing: suggestions every ~40 s, plans start in ~10 min. Leave it off for the real rhythm: a couple of suggestions a day, between 9:00 and 20:00.
(On this Windows machine PowerShell blocks `npm run …` scripts, so call `node` directly as above.)

The terminal prints a **QR code** and an address like `https://192.168.0.203:3443`.

**On each phone:** scan the QR code or type the address. The first time, Safari says *"This Connection Is Not Private"* → tap **Show Details** → **visit this website** → **Visit Website**. That warning appears because the certificate is your own laptop's. Phones only allow GPS on HTTPS pages, which is why it's needed.

**Host dashboard** (this computer only): <http://localhost:3000/admin>. It shows who joined, what Eden is asking each person, learned likes and every plan, plus testing buttons:
- **Suggest something now** for any person
- **Remind now**, **Pretend they met**, **End → ask how it went** to fast-forward a plan
- **quieter days**, to see Eden switch to gentler suggestions
- **Put everyone without GPS near Aalto**, for testing on laptops
- **Check-in now**, and **+ sample: steady / slipping** to give someone a made-up check-in history
- **Reset everything**

**Care-team view** (this computer only): <http://localhost:3000/clinician>. It shows people who chose to share their check-ins. Each one gets a status from fixed, cited rules ("Doing okay", "Keep an eye on", "Might need a call"), the reasons, their check-in history and their meet-ups. To add AI-written summaries, start Eden with an Anthropic API key:

```bash
ANTHROPIC_API_KEY=sk-ant-... node server/index.js --demo
```

(PowerShell: `$env:ANTHROPIC_API_KEY="sk-ant-..."; node server/index.js --demo`)

Testing alone on one computer: open `http://localhost:3000` and `http://127.0.0.1:3000` in the same browser. They keep separate logins, so you can be two people.

### Nudges when the app is closed (optional)

Whenever a plan needs your yes or no (a suggestion, "heading out soon?", "did you meet?", "did it lift you a bit?"), Eden sends a notification with that card's own buttons, e.g. **Yes, let's** / **Not this time**. Tapping a button answers right there, and Eden's reply ("It's on! Sam is in too.") comes back as a quiet notification. Tapping the notification itself opens Eden. Suggestions and reminders stay on screen until answered. Answered or expired questions clear themselves, and the app icon shows how many are waiting. Anyone can switch nudges on later from the menu (☰).

While Eden is open in a background tab, it shows these notifications itself, so on `localhost` they work without any setup once you allow notifications. When Eden is fully closed, it needs push, and push needs a **trusted** HTTPS address, for example a free Cloudflare tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Open the `https://….trycloudflare.com` address it prints. On iPhone (iOS 16.4+): Share → **Add to Home Screen**, open Eden from the Home Screen, and say yes to "Can Eden tap you on the shoulder…". A tunnel also works across different networks, e.g. phones on mobile data.

---

## Privacy

- Everything is stored in `data/` on the host's laptop. Nothing goes to a cloud service, with one optional exception: if the host sets `ANTHROPIC_API_KEY`, AI summaries send the check-in numbers of people who chose to share to Claude. Claude never gets a name, place, friend or date (details in [CHECKINS.md](CHECKINS.md)).
- Check-ins are opt-in, and sharing them with a care team is a second, separate yes. Both can be changed any time in the menu (☰). The host's activity log never shows answers.
- Other people only see **roughly how far away** you are ("about 1 km"), never where you are.
- For home activities (cooking, movie night, games), the guest gets directions only after the host has said yes to hosting and to that plan.
- To find places, Eden sends only a rough area centre (about 2 km) to OpenStreetMap's public API, never a name or exact position. Results are cached for a day. Set `EDEN_PLACES=off` to turn this off. Eden then says "a café near you both" with a map search instead.
- Anyone can delete their account from the menu (☰). The host can wipe everything from the dashboard.
- Eden is not a medical device and doesn't diagnose.

## Limits

- **GPS only updates while Eden is open** (true of all web apps). "You're together" detection needs both phones to have Eden open around the meeting time.
- The self-signed certificate warning appears once per phone, and push notifications don't work with it. Use a tunnel for that (see above).
- The public OpenStreetMap server is sometimes slow or busy. Eden then falls back to "a café near you both" with a map search, and successful lookups are cached on disk.
- Everyone on the same server is one circle. There's no friend-list management yet.

## Files

```
server/index.js       HTTP + HTTPS server, accounts, live updates (SSE), host API
server/engine.js      the initiator: pairing, activity/time/place choice, cards, reminders,
                      GPS meet-up detection, learning (Thompson sampling), quieter-stretch care
server/activities.js  the things to do together (add your own here)
server/questionnaires.js  the check-in: WHO-5, PHQ-8, loneliness scale (published wording and scoring)
server/clinician.js   care-team view: status rules and optional AI summaries (Claude)
server/places.js      real places from OpenStreetMap (combined, cached lookups)
server/security.js    password hashing, sessions, self-signed certificate
server/push.js        optional Web Push
server/store.js       JSON file storage in data/
public/index.html, app.js, styles.css   the phone app (one card at a time)
public/admin.html     host dashboard
public/clinician.html care-team view (people who shared their check-ins)
public/sw.js          service worker: notifications with Yes / No buttons, answered without opening Eden
```
