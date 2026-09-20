# Phone Light Show — MVP prototype

Fan journey: **scan QR → open page, no app → tap Join (no stand/section/row/
seat picker) → wait → admin starts the show → torches/screens sync together
→ everyone who joined is auto-entered into a giveaway, deduped per device →
admin picks a random winner and messages that device directly.**

## Why there's no seat map in here

A detailed row/seat map is only needed for **section/seat-level effects**
(spelling something out, a wave rolling section by section, mosaic/pixel-art
where each seat is one "pixel"). It is **not** needed for the basic
synchronized experience this MVP targets — a global broadcast to everyone
doesn't need to know where anyone is sitting. That's why joining here has no
seat step at all: one broadcast channel, no per-seat routing. The seat map
becomes relevant again only when you build the "later versions" section-based
or wave effects.

## Sync to a song

Admin panel → "Sync to a song": pick an audio file (stays local to your
browser — never uploaded anywhere), get its BPM either by typing it in or
tapping the "Tap tempo" button along with the beat, then hit "Play song +
start lights". This plays the song **from the admin's device only** and
pulses every connected phone in time with it.

Deliberately **not** implemented: each participant's phone playing the song
itself. Multiple nearby phones each playing audio independently causes
audible echo/phase artifacts, and keeping audio sample-accurate across many
independent devices is a much harder sync problem than lights — which is
why real stadiums use one PA system for audio and only sync the visual
effect to it. This mirrors that: one shared audio source (this laptop, or a
Bluetooth speaker), phones only sync their flashing to it.

Mechanism: the server echoes the resolved `startAt` timestamp back to the
admin's own connection (same message it sends the phones), and the admin
page runs the identical clock-sync trick the phones use to schedule its
local `audio.play()` against that timestamp — so the song and the lights
start at the same synced instant regardless of network latency. Verified in
testing: `play()` fired within 18ms of the announced target time.

One browser quirk this works around: mobile/desktop browsers block
`audio.play()` unless it happens inside a direct user gesture, but this
song needs to start ~2.5s *after* the button click (to match the phones'
lead time), which no longer counts as "direct." Fix is the standard
workaround — a play-then-immediately-pause cycle runs synchronously inside
the actual click, which "unlocks" that audio element so the later
timer-scheduled `play()` call is allowed to proceed.

BPM is clamped the same way the light pulse itself is (400–1200ms/beat, see
"Scaling decision" below for why) — very fast songs need "half-time" checked
so the lights pulse every other beat instead of hitting the floor.

## Run it locally

```bash
npm install
ADMIN_KEY=pick-a-real-secret npm start
```

Three pages, three tabs to test with:

- `http://localhost:3000/qr.html` — the public "connected screen" (this is
  what you'd put on the stadium video board): a big QR code pointing at the
  participant page, a live "fans connected" count, and a 🔴 Live indicator
  that lights up the moment the admin starts the show. No login needed —
  safe to put in front of an audience. The QR always encodes whatever
  host/URL *this page itself* was loaded from, so it's correct whether
  you're on `localhost`, a LAN IP, or a public ngrok/HTTPS URL — nothing to
  configure.
- `http://localhost:3000/` — the participant page (what scanning the QR
  opens).
- `http://localhost:3000/admin.html` — the control panel — it'll ask for the
  admin key before showing any controls. **Don't skip setting `ADMIN_KEY`**
  — anyone who finds `/admin.html` without it can start/stop the show and
  run the giveaway (see "Admin access" below).

## Test with a real phone

`getUserMedia` (needed to control the real camera torch on Android Chrome)
only works in a "secure context" — HTTPS, or `localhost` itself. Your phone
is not `localhost`, so for a real test you need a public HTTPS URL. Easiest
option:

```bash
npx ngrok http 3000
```

Open `https://xxxx.ngrok-free.app/qr.html` on your laptop (or on a second
screen) — it auto-generates the right QR code for that exact URL, no manual
QR tool needed. Scan it with your phone. Tap
"Enable my light", then trigger a cue from `/admin.html` on your laptop.

- On **Android Chrome**, you should see the real camera LED flash.
- On **iOS Safari**, there's no torch API — you'll see the screen flash
  white/black instead. That's expected, not a bug (see explanation below).

## How the sync actually works

1. On connect, each phone measures round-trip time to the server 5 times
   (`{type:'ping'}` → `{type:'pong', serverTime}`) and keeps the
   lowest-RTT sample to estimate `offset = serverTime − localTime`.
2. Admin triggers a pattern → server picks `startAt = now + 2.5s` (enough
   lead time for the cue message to reach every phone) and broadcasts the
   whole pattern (a list of `{t, on}` steps) to everyone at once.
3. Each phone independently schedules its own `setTimeout`s for
   `(startAt + step.t) − offset`, so every phone fires at the same
   *wall-clock* instant regardless of when the WebSocket message actually
   arrived.

This is the same idea NTP uses for clock sync — it's what makes thousands of
independently-connected phones look like one coordinated display instead of
a ragged wave.

## Admin access

`admin.html` gates every privileged action (start/stop, one-off cues, pick
winner, reset pool) behind an `ADMIN_KEY` shared secret — see `server.js`.
There's no user database or session system, just a shared passcode checked
per-socket server-side; it's intentionally minimal for a first version, but
it's the difference between "only our team can control this" and "anyone
who finds the URL can end the giveaway or spam-trigger effects." Change the
default before any real event — the server prints a loud warning on startup
if you don't.

## Giveaway mechanics

- **Entry**: happens on the explicit "Join the Light Show" tap, not just on
  page load — loading the page and leaving without tapping Join does not
  enter someone into the giveaway.
- **De-dup key**: a random UUID generated client-side and persisted in
  `localStorage` (`public/index.html`, `getDeviceId()`). The server keys its
  giveaway pool (a `Map`) by this id, so re-joining (page refresh, network
  drop + reconnect) updates the same pool entry instead of creating a new
  one — verified in testing: a device that joined, then reconnected with the
  same id, still counted as exactly one entry.
- **Known limitation (documented, not fixed, for v1)**: this only identifies
  a *browser/device*, not a *person*. Clearing site data, using a private
  window, or borrowing a second phone gets a fresh id and a second entry.
  Stadium-wide IP-based dedup was considered and rejected — many genuine
  fans share the same IP behind venue Wi-Fi/carrier NAT, so it would
  wrongly block real entries far more than it stops abuse. If abuse turns
  out to be a real problem at scale, the next step up is verifying a phone
  number or a one-time code, which is a bigger v2 feature, not a v1 tweak.
- **Winner selection**: random among devices that haven't already won
  (`server.js`, `pick-winner`), so the same device can't be drawn twice
  across multiple draws in one session. `reset-giveaway` clears the whole
  pool — use it between your small-group test and the full arena test so
  test entries don't linger into the real draw.
- **Winner delivery**: if the winning device is currently connected, the
  message is pushed immediately. If it dropped (closed the tab, lost
  signal), the message is queued server-side and delivered automatically
  the moment that same device id reconnects — no re-draw needed.

## Scaling decision: single instance, not a cluster

For a venue in the volleyball-arena size range (roughly hundreds to low
tens-of-thousands of seats), the right architecture is **one Node process**,
not a load-balanced pool of instances behind Redis pub/sub. A WebSocket
connection here is almost entirely idle — 5 ping/pong exchanges at connect
time, then silence until a cue fires — so one process comfortably holds far
more concurrent sockets than a venue this size will ever have people. Adding
a load balancer + a pub/sub fan-out layer between instances buys you
capacity you don't need, at the cost of a real new failure mode: if two
backend instances' system clocks disagree even by a few tens of ms, phones
attached to different instances desync from each other, purely because
"server time" no longer means one consistent thing. See `deploy/` for the
production setup this implies:

- `deploy/nginx.conf` — TLS termination + WebSocket proxying in front of the
  single Node process (this is a reverse proxy, not a load balancer across
  multiple app instances).
- `deploy/phone-light-show.service` — a systemd unit so the process
  auto-restarts on crash instead of silently dying mid-show.
- `scripts/load-test.js` — simulates N clients against a running instance,
  running the same clock-sync/cue-fire logic real phones do, and reports the
  actual fire-time spread. **Run this from the empty venue, on the same
  network the phones will use, before committing to "one process is
  enough."** In an on-machine loopback test with 200 simulated clients this
  measured a 5.5ms median / 6.5ms worst-case fire-time spread — comfortably
  under the ~30-50ms threshold for a flash to read as simultaneous — but
  loopback numbers aren't a substitute for testing on the real venue network,
  where Wi-Fi/cellular latency and jitter are the actual variables that
  matter.

**When you'd actually reach for the multi-instance + Redis pub/sub
architecture instead:** if a load test on real venue hardware shows you
approaching the ceiling of a single process (CPU-bound on the broadcast
fan-out, or hitting OS file-descriptor/socket limits), or you're scaling
this same codebase up to an actual large stadium (tens of thousands of
concurrent sockets). Cross that bridge with evidence from `load-test.js`,
not in advance.

## What you'd change for a real stadium deployment

- **Scale**: a single Node `ws` server handles a few thousand sockets fine on
  decent hardware, but for tens of thousands you'd put it behind a managed
  realtime service (Pusher, Ably, PubNub) or run multiple WS server
  instances behind a sticky-session load balancer with Redis pub/sub
  fan-out between them.
- **HTTPS is mandatory** — get a real TLS cert (Let's Encrypt, or your CDN's
  managed cert) rather than ngrok.
- **Lead time tuning**: 2.5s is generous for a small test; in production
  you'd tune it down once you've measured real message delivery latency at
  scale, and you might resync the clock offset periodically (phones drift,
  and people join mid-show).
- **Cue authoring**: for a music-synced show you'd generate the pattern
  from the actual track (either hand-timed cue points, or lightweight audio
  onset detection) rather than the three canned patterns here.
- **Strobe/flash safety**: rapid strobing can trigger photosensitive
  epilepsy in a small percentage of people — real deployments include a
  warning before the strobe pattern and usually cap flash frequency below
  3 Hz, per the flashing-image guidance broadcasters use (e.g. Ofcom/ITC
  and W3C's own guidance for web content). This is why `show-start` (the
  sustained, whole-song mode) only offers "solid" or "pulse" — continuous
  strobe is only available as the short, bounded one-off cue, capped at a
  couple of seconds.
- **"Synchronized with the music" in this MVP** means the admin starts a
  continuous solid/pulse pattern at the same moment the track starts over
  the PA — everyone's phones turn on/pulse together for the duration of the
  song, then admin hits Stop. It is not beat-matched flicker synced to the
  actual audio waveform; true beat-matching would need either a
  pre-authored cue sheet timed against the specific track, or real-time
  audio analysis, both bigger scope than this MVP asked for.
- **Testing path**: run locally first (`npm start`, two browser tabs), then
  a small real-phone test over ngrok/local Wi-Fi with a handful of people —
  use `reset-giveaway` in the admin panel afterward so test entries don't
  carry into the real draw — then move to `scripts/load-test.js` against
  the actual venue network before a full arena run. Don't skip straight
  from "works on my laptop" to "works with 5,000 phones."
