/**
 * Synchronized phone-flashlight light show + giveaway server.
 *
 * Fan journey: scan QR -> open page -> tap Join (no seat/section picker) ->
 * wait -> admin starts the show -> torches/screens sync to the music.
 * Every successful join also enters a giveaway pool, deduped by a
 * per-device id (see public/index.html), with admin-triggered random
 * winner selection and a direct message to the winning device.
 *
 * Run:   npm install
 *        ADMIN_KEY=your-secret node server.js
 * Open:  http://localhost:3000/            -> participant page (QR target)
 *        http://localhost:3000/admin.html  -> control panel (needs ADMIN_KEY)
 *
 * NOTE: getUserMedia (real torch control on Android) requires a secure
 * context — HTTPS in production, http://localhost only for local testing.
 *
 * Also: GET /health (uptime + connection count), giveaway state persisted
 * to data/giveaway-state.json (crash-restart safety net, see comment
 * below), a winner history log sent to admins, and exponential backoff on
 * repeated failed admin-auth attempts from the same IP.
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.set('trust proxy', true); // so req.protocol is correct behind ngrok/nginx (https)
app.use(express.static(path.join(__dirname, 'public')));

// Simple health endpoint — lets a host (Render, a load balancer, an
// uptime monitor) confirm the process is actually up, separate from just
// "did the port accept a TCP connection." Useful once you're on a paid
// Render plan that does zero-downtime deploys: it uses this to know the
// new instance is ready before killing the old one.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), connected: currentStats().connected });
});

// Renders a QR code pointing at this server's OWN participant page, using
// whatever host/protocol the request actually arrived on — so the same
// route works unmodified on localhost, a LAN IP, or a public ngrok/HTTPS
// domain. public/qr.html just does <img src="/qr.png">.
app.get('/qr.png', async (req, res) => {
  try {
    const targetUrl = `${req.protocol}://${req.get('host')}/`;
    const png = await QRCode.toBuffer(targetUrl, { width: 480, margin: 2 });
    res.type('png').send(png);
  } catch (err) {
    res.status(500).send('QR generation failed');
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const LEAD_TIME_MS = 2500; // buffer so a cue reaches every phone before it must fire
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';
if (ADMIN_KEY === 'change-me') {
  console.warn(
    '⚠️  ADMIN_KEY not set — using the default "change-me". ' +
    'Anyone who finds /admin.html can control the show and the giveaway. ' +
    'Set a real ADMIN_KEY env var before a real event.'
  );
}

// deviceId -> { ws, connectedAt, hasWon, pendingWinMessage }
const pool = new Map();
const adminSockets = new Set();
const viewerSockets = new Set(); // the QR/"connected screen" display — public, no auth, count only
const adminAuthAttempts = new Map(); // ip -> { attempts, lockedUntil } — brute-force backoff for admin-auth

// --- giveaway persistence ---
// Protects against the process crashing and restarting mid-event (an
// unhandled exception, an OOM kill) wiping every joined fan and past
// winner. This is a safety net for a crash-restart on the SAME running
// instance/disk — it does NOT survive a fresh deploy or a host whose
// filesystem is wiped between runs (e.g. Render's free tier without an
// attached persistent Disk). For that level of durability you'd need a
// real external store (a database, or a paid Render Disk).
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'giveaway-state.json');
const winnerHistory = []; // { shortId, message, timestamp, online }

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    for (const [deviceId, entry] of Object.entries(saved.pool || {})) {
      // ws is null until this device actually reconnects — it re-enters
      // the live pool (with its hasWon/pendingWinMessage intact) the next
      // time it sends a 'join', same as any other reconnect.
      pool.set(deviceId, { ws: null, connectedAt: entry.connectedAt, hasWon: entry.hasWon, pendingWinMessage: entry.pendingWinMessage || null });
    }
    if (Array.isArray(saved.winnerHistory)) winnerHistory.push(...saved.winnerHistory);
    console.log(`[state] restored ${pool.size} pool entries and ${winnerHistory.length} winner history entries from ${STATE_FILE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[state] failed to load ${STATE_FILE}: ${err.message}`);
    // ENOENT (no file yet) is the normal first-run case — nothing to do.
  }
}

let stateDirty = false;
function markStateDirty() { stateDirty = true; }

async function flushState() {
  if (!stateDirty) return;
  stateDirty = false;
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const poolOut = {};
    for (const [deviceId, entry] of pool.entries()) {
      poolOut[deviceId] = { connectedAt: entry.connectedAt, hasWon: entry.hasWon, pendingWinMessage: entry.pendingWinMessage };
    }
    const tmp = STATE_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify({ pool: poolOut, winnerHistory }));
    await fs.promises.rename(tmp, STATE_FILE); // atomic swap — avoids a half-written file if the process dies mid-write
  } catch (err) {
    console.warn(`[state] failed to save: ${err.message}`);
    stateDirty = true; // retry on the next interval tick instead of silently losing the update
  }
}

// A join wave marks state dirty on every join but only flushes on a fixed
// interval, never per-join. An earlier version called a blocking
// fs.writeFileSync after every mutation, debounced only to the next
// setImmediate tick — under a 500-client burst test that measured 129
// separate synchronous disk writes, each stalling Node's single event
// loop thread right in the path of the cue broadcast fan-out. Interval
// flushing bounds this to at most one async (non-blocking) write per
// interval, however many joins happen in between.
const STATE_FLUSH_INTERVAL_MS = 2000;
setInterval(() => { flushState(); }, STATE_FLUSH_INTERVAL_MS);

loadState();

// Flush state on a graceful shutdown (Render sends SIGTERM before killing
// the old instance on a redeploy) so a crash-restart on the same disk
// doesn't lose the last few seconds of activity.
function gracefulShutdown(signal) {
  console.log(`[state] ${signal} received, saving state before exit...`);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const poolOut = {};
    for (const [deviceId, entry] of pool.entries()) {
      poolOut[deviceId] = { connectedAt: entry.connectedAt, hasWon: entry.hasWon, pendingWinMessage: entry.pendingWinMessage };
    }
    const tmp = STATE_FILE + '.tmp';
    // Same atomic tmp-file + rename pattern as flushState() — a plain
    // direct write here could leave a truncated/corrupted state file if
    // the process is killed (e.g. SIGKILL after the SIGTERM grace period
    // expires) mid-write, which loadState() would then have to silently
    // discard on the next boot.
    fs.writeFileSync(tmp, JSON.stringify({ pool: poolOut, winnerHistory }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.warn(`[state] failed to save on shutdown: ${err.message}`);
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

function send(ws, obj) {
  if (ws && ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj));
}

function broadcastToParticipants(obj) {
  const msg = JSON.stringify(obj);
  for (const { ws } of pool.values()) {
    if (ws && ws.readyState === 1) ws.send(msg);
  }
}

function currentStats() {
  let connected = 0;
  for (const { ws } of pool.values()) {
    if (ws && ws.readyState === 1) connected++;
  }
  return { type: 'stats', connected, entries: pool.size };
}

function broadcastStats() {
  const stats = currentStats();
  for (const ws of adminSockets) send(ws, stats);
  // Viewers (the public QR/display screen) get connected count only — not
  // the giveaway entry total, which stays admin-only.
  const publicStats = { type: 'public-stats', connected: stats.connected };
  for (const ws of viewerSockets) send(ws, publicStats);
}

// --- one-off short cues (quick visual effects) ---
function buildPattern(type) {
  switch (type) {
    case 'flash':
      return [{ t: 0, on: true }, { t: 400, on: false }];
    case 'strobe': {
      const steps = [];
      const interval = 150;
      const count = 12;
      for (let i = 0; i < count; i++) steps.push({ t: i * interval, on: i % 2 === 0 });
      steps.push({ t: count * interval, on: false });
      return steps;
    }
    case 'pulse-slow': {
      const steps = [];
      for (let i = 0; i < 4; i++) {
        steps.push({ t: i * 1000, on: true });
        steps.push({ t: i * 1000 + 600, on: false });
      }
      return steps;
    }
    default:
      return [{ t: 0, on: true }, { t: 300, on: false }];
  }
}

wss.on('connection', (ws, req) => {
  ws.role = null; // 'participant' | 'admin' | 'viewer', set on first message

  // Real client IP for the admin-auth rate limiter below. Behind a proxy
  // (Render's own edge, or deploy/nginx.conf on a VPS), ws._socket.
  // remoteAddress is the PROXY's address for every connection, not the
  // visitor's — keying the rate limiter on that would bucket every admin
  // login attempt from every device as "the same client," so a few wrong
  // guesses from anyone locks out the real admin too. X-Forwarded-For is
  // set by both Render's edge and nginx.conf's proxy_set_header; take the
  // first (left-most, i.e. original client) address in that list, and
  // fall back to the raw socket address for direct/local connections
  // (e.g. running this locally with no proxy in front).
  const forwardedFor = req.headers['x-forwarded-for'];
  ws._clientIp = (forwardedFor ? forwardedFor.split(',')[0].trim() : null)
    || (req.socket && req.socket.remoteAddress)
    || 'unknown';

  ws.on('close', () => {
    adminSockets.delete(ws);
    viewerSockets.delete(ws);
    broadcastStats();
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- shared: clock sync (used by both participants and admin) ---
    if (msg.type === 'ping') {
      send(ws, { type: 'pong', clientSendTime: msg.clientSendTime, serverTime: Date.now() });
      return;
    }

    // --- the public "connected screen" (qr.html) — no auth, count only ---
    if (msg.type === 'viewer') {
      ws.role = 'viewer';
      viewerSockets.add(ws);
      send(ws, { type: 'public-stats', connected: currentStats().connected });
      return;
    }

    // --- participant joins: no seat/section info, just a device id ---
    if (msg.type === 'join') {
      const deviceId = typeof msg.deviceId === 'string' && msg.deviceId.length >= 8
        ? msg.deviceId
        : crypto.randomUUID();

      ws.role = 'participant';
      ws.deviceId = deviceId;

      let entry = pool.get(deviceId);
      if (!entry) {
        entry = { ws, connectedAt: Date.now(), hasWon: false, pendingWinMessage: null };
        pool.set(deviceId, entry);
      } else {
        entry.ws = ws; // reconnect — same person, same pool slot, no double entry
      }

      send(ws, { type: 'joined', deviceId, giveawayEntered: true });

      // Deliver a win message that arrived while this device was offline.
      if (entry.pendingWinMessage) {
        send(ws, { type: 'winner', message: entry.pendingWinMessage });
        entry.pendingWinMessage = null;
      }

      broadcastStats();
      markStateDirty();
      return;
    }

    // --- everything below requires admin auth ---
    if (msg.type === 'admin-auth') {
      const ip = ws._clientIp;
      const lock = adminAuthAttempts.get(ip);
      if (lock && lock.lockedUntil > Date.now()) {
        send(ws, { type: 'admin-auth-fail', retryAfterMs: lock.lockedUntil - Date.now() });
        return;
      }
      if (msg.key === ADMIN_KEY) {
        adminAuthAttempts.delete(ip); // successful login clears any prior failed-attempt count
        ws.role = 'admin';
        adminSockets.add(ws);
        send(ws, { type: 'admin-auth-ok' });
        send(ws, currentStats());
        send(ws, { type: 'winner-history', history: winnerHistory });
      } else {
        const attempts = (lock ? lock.attempts : 0) + 1;
        // Exponential backoff after repeated failures from the same IP:
        // no delay for the first few honest typos, then 2s/4s/8s/...
        // capped at 60s. Slows brute-forcing a short key without locking
        // out someone who just fat-fingered it once or twice.
        const lockMs = attempts > 3 ? Math.min(60000, 2 ** (attempts - 3) * 1000) : 0;
        adminAuthAttempts.set(ip, { attempts, lockedUntil: Date.now() + lockMs });
        send(ws, { type: 'admin-auth-fail', retryAfterMs: lockMs });
      }
      return;
    }

    if (ws.role !== 'admin') return; // silently ignore unauthenticated admin actions

    if (msg.type === 'trigger') {
      const pattern = buildPattern(msg.pattern);
      const startAt = Date.now() + LEAD_TIME_MS;
      broadcastToParticipants({ type: 'cue', startAt, pattern });
      console.log(`[admin] one-off cue "${msg.pattern}" at ${new Date(startAt).toISOString()}`);
      return;
    }

    if (msg.type === 'show-start') {
      // Continuous mode until show-stop. Only "solid" and "pulse" are
      // offered for sustained duration — no continuous strobe, to avoid
      // extended rapid flashing (photosensitive-seizure risk). Strobe stays
      // available only as the short, bounded one-off cue above.
      const mode = msg.mode === 'pulse' ? 'pulse' : 'solid';
      const intervalMs = Math.max(400, Math.min(1200, Number(msg.intervalMs) || 700));
      const startAt = Date.now() + LEAD_TIME_MS;
      broadcastToParticipants({ type: 'show-start', startAt, mode, intervalMs });
      for (const v of viewerSockets) send(v, { type: 'show-status', live: true });
      // Echo the resolved startAt back to the admin that triggered this, so
      // if they're playing a song locally (see public/admin.html "Sync to a
      // song"), they can schedule audio.play() against the exact same
      // synced clock the phones use — same trick as the phones themselves.
      send(ws, { type: 'show-start-ack', startAt, mode, intervalMs });
      console.log(`[admin] show-start mode=${mode} interval=${intervalMs}ms at ${new Date(startAt).toISOString()}`);
      return;
    }

    if (msg.type === 'show-stop') {
      broadcastToParticipants({ type: 'show-stop' });
      for (const v of viewerSockets) send(v, { type: 'show-status', live: false });
      console.log('[admin] show-stop');
      return;
    }

    if (msg.type === 'pick-winner') {
      const eligible = [...pool.entries()].filter(([, e]) => !e.hasWon);
      if (eligible.length === 0) {
        send(ws, { type: 'winner-picked', error: 'No eligible entries left.' });
        return;
      }
      const [deviceId, entry] = eligible[Math.floor(Math.random() * eligible.length)];
      entry.hasWon = true;
      const message = typeof msg.message === 'string' && msg.message.trim()
        ? msg.message.trim()
        : '🎉 Congratulations! You\'ve won a prize — head to the fan zone to collect it.';

      const online = entry.ws && entry.ws.readyState === 1;
      if (online) {
        send(entry.ws, { type: 'winner', message });
      } else {
        entry.pendingWinMessage = message; // delivered next time this device reconnects
      }

      const historyEntry = { shortId: deviceId.slice(0, 8), message, timestamp: Date.now(), online };
      winnerHistory.push(historyEntry);
      for (const a of adminSockets) send(a, { type: 'winner-history', history: winnerHistory });

      send(ws, {
        type: 'winner-picked',
        shortId: deviceId.slice(0, 8),
        online,
        message,
      });
      console.log(`[admin] winner picked: ${deviceId.slice(0, 8)} (online=${online})`);
      markStateDirty();
      flushState(); // rare, high-value event — don't wait for the periodic interval
      return;
    }

    if (msg.type === 'reset-giveaway') {
      // Reset giveaway ELIGIBILITY only — do not drop currently-connected
      // devices from the pool. pool doubles as both "who gets cues" and
      // "who's in the giveaway," so clearing it outright used to silently
      // stop already-joined fans from receiving any further light cues
      // until they manually refreshed and rejoined — a real problem if
      // this is used mid-event (the README documents it as exactly that:
      // "between your small-group test and the full arena test").
      for (const entry of pool.values()) {
        entry.hasWon = false;
        entry.pendingWinMessage = null;
      }
      broadcastStats();
      send(ws, { type: 'giveaway-reset-ok' });
      console.log('[admin] giveaway pool reset (eligibility only — connected devices stay in the pool and keep receiving cues)');
      markStateDirty();
      flushState(); // same — flush immediately rather than waiting up to 2s
      return;
    }

    if (msg.type === 'disconnect-all') {
      // Force-closes every connected participant socket. This is
      // DIFFERENT from reset-giveaway: it doesn't touch anyone's
      // giveaway eligibility or entry, it just kicks the live
      // connection. Each phone's own client-side reconnect logic (see
      // public/index.html, the ws 'close' handler) picks this up within
      // 1-2.5s (jittered) and automatically reconnects + rejoins with
      // the same deviceId — no giveaway impact, and the person doesn't
      // need to rescan the QR code or grant camera permission again,
      // since that's all still held in their open browser tab. Useful
      // for clearing out stale/ghost connections before a real show,
      // or forcing everyone onto a fresh socket.
      let count = 0;
      for (const entry of pool.values()) {
        if (entry.ws && entry.ws.readyState === 1) {
          entry.ws.close();
          count++;
        }
      }
      // Each closed socket's own 'close' handler already calls
      // broadcastStats(), so no need to call it again here.
      send(ws, { type: 'disconnect-all-ok', count });
      console.log(`[admin] force-disconnected ${count} connected phone(s) — they'll auto-reconnect within a couple seconds`);
      return;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
