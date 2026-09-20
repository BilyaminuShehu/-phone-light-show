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
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.set('trust proxy', true); // so req.protocol is correct behind ngrok/nginx (https)
app.use(express.static(path.join(__dirname, 'public')));

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

wss.on('connection', (ws) => {
  ws.role = null; // 'participant' | 'admin' | 'viewer', set on first message

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
      return;
    }

    // --- everything below requires admin auth ---
    if (msg.type === 'admin-auth') {
      if (msg.key === ADMIN_KEY) {
        ws.role = 'admin';
        adminSockets.add(ws);
        send(ws, { type: 'admin-auth-ok' });
        send(ws, currentStats());
      } else {
        send(ws, { type: 'admin-auth-fail' });
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

      send(ws, {
        type: 'winner-picked',
        shortId: deviceId.slice(0, 8),
        online,
        message,
      });
      console.log(`[admin] winner picked: ${deviceId.slice(0, 8)} (online=${online})`);
      return;
    }

    if (msg.type === 'reset-giveaway') {
      pool.clear();
      broadcastStats();
      send(ws, { type: 'giveaway-reset-ok' });
      console.log('[admin] giveaway pool reset');
      return;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
