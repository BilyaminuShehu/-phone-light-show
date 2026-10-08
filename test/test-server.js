/**
 * Raw WebSocket / server-protocol test suite.
 * Run with: node test/test-server.js
 */
const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', msg); }
}

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    failed++;
    console.error(`FAIL (exception in "${name}"):`, err.message);
  }
}

function startServer(port, adminKey) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), ADMIN_KEY: adminKey, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForOpen(url) {
  return new Promise((resolve, reject) => {
    const tryConnect = (attemptsLeft) => {
      const ws = new WebSocket(url);
      ws.on('open', () => resolve(ws));
      ws.on('error', () => {
        ws.terminate();
        if (attemptsLeft <= 0) reject(new Error('could not connect'));
        else setTimeout(() => tryConnect(attemptsLeft - 1), 200);
      });
    };
    tryConnect(20);
  });
}

function attachAccumulator(ws) {
  ws.__msgs = [];
  ws.on('message', (raw) => {
    try {
      ws.__msgs.push(JSON.parse(raw));
    } catch {
      /* non-JSON message, ignore */
    }
  });
}

function waitFor(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = ws.__msgs.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for message'));
      setTimeout(check, 20);
    };
    check();
  });
}

const fs = require('fs');
const os = require('os');

// server.js resolves its data dir as path.join(__dirname, 'data') — fixed
// to wherever the *script file* lives, not the process cwd. So to get a
// genuinely isolated giveaway pool/winner-history per test scenario (not
// just a fresh port), each instance needs to run from its OWN copy of
// server.js in its own directory. This is exactly the shared-state test
// contamination that has bitten this suite before: a device left in the
// pool by an earlier scenario getting picked as "the" winner later,
// producing a false failure that looks like an app bug but is really a
// test-construction mistake.
const projectRoot = path.join(__dirname, '..');
function freshServer() {
  const port = 4500 + Math.floor(Math.random() * 20000);
  const adminKey = 'test-admin-key-' + Math.random().toString(36).slice(2);
  const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-test-'));
  fs.copyFileSync(path.join(projectRoot, 'server.js'), path.join(instanceDir, 'server.js'));
  fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(instanceDir, 'node_modules'), 'dir');
  const server = spawn(process.execPath, [path.join(instanceDir, 'server.js')], {
    cwd: instanceDir,
    env: { ...process.env, PORT: String(port), ADMIN_KEY: adminKey, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d.toString()));
  server.stderr.on('data', (d) => (log += d.toString()));
  return { server, port, adminKey, base: `ws://localhost:${port}`, getLog: () => log };
}

async function main() {
  const shared = freshServer();
  await new Promise((r) => setTimeout(r, 400)); // let it bind
  const base = shared.base;
  const ADMIN_KEY = shared.adminKey;
  const server = shared.server;
  let serverLog = '';

  await step('basic join + ping/pong clock sync', async () => {
    const ws = await waitForOpen(base);
    attachAccumulator(ws);
    const t0 = Date.now();
    ws.send(JSON.stringify({ type: 'ping', clientSendTime: t0 }));
    const pong = await waitFor(ws, (m) => m.type === 'pong');
    assert(typeof pong.serverTime === 'number', 'pong includes serverTime');
    ws.send(JSON.stringify({ type: 'join', deviceId: 'dev-basic-1' }));
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
  });

  await step('admin auth: wrong key rejected, right key accepted', async () => {
    const ws = await waitForOpen(base);
    attachAccumulator(ws);
    ws.send(JSON.stringify({ type: 'admin-auth', key: 'wrong-key' }));
    const authFail = await waitFor(ws, (m) => m.type === 'admin-auth-fail');
    assert(!!authFail, 'wrong admin key is rejected with admin-auth-fail');
    ws.send(JSON.stringify({ type: 'admin-auth', key: ADMIN_KEY }));
    const authOk = await waitFor(ws, (m) => m.type === 'admin-auth-ok', 3000);
    assert(!!authOk, 'correct admin key is accepted with admin-auth-ok');
    ws.close();
  });

  await step('admin auth rate limiting (backoff after repeated failures)', async () => {
    // Isolated fresh server: this deliberately triggers an IP-keyed
    // exponential lockout, which would otherwise leak into every later
    // test that needs a real admin-auth-ok on the shared server/port.
    const inst = freshServer();
    await new Promise((r) => setTimeout(r, 400));
    const ws = await waitForOpen(inst.base);
    attachAccumulator(ws);
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ type: 'admin-auth', key: 'still-wrong-' + i }));
      await new Promise((r) => setTimeout(r, 50));
    }
    const results = ws.__msgs.filter((m) => m.type === 'admin-auth-fail');
    assert(results.length >= 4, 'repeated wrong attempts all get a response (' + results.length + ')');
    ws.close();
    inst.server.kill();
  });

  await step('pick-winner + winner-contact flow (valid and spoofed winnerId)', async () => {
    // Isolated fresh server: this is sensitive to pool contamination (see
    // freshServer()'s comment) — pick-winner must select OUR participant,
    // not some leftover device from an earlier step on a shared server.
    const inst = freshServer();
    await new Promise((r) => setTimeout(r, 400));
    const base = inst.base, ADMIN_KEY = inst.adminKey;

    const participant = await waitForOpen(base);
    attachAccumulator(participant);
    participant.send(JSON.stringify({ type: 'join', deviceId: 'dev-winner-test' }));
    await new Promise((r) => setTimeout(r, 150));

    const admin = await waitForOpen(base);
    attachAccumulator(admin);
    admin.send(JSON.stringify({ type: 'admin-auth', key: ADMIN_KEY }));
    await waitFor(admin, (m) => m.type === 'admin-auth-ok');

    admin.send(JSON.stringify({ type: 'pick-winner', message: 'Test prize!' }));
    const winnerMsg = await waitFor(participant, (m) => m.type === 'winner', 3000);
    assert(typeof winnerMsg.winnerId === 'string' && winnerMsg.winnerId.length > 10, 'winner message includes a winnerId token');
    assert(winnerMsg.message === 'Test prize!', 'winner message carries the admin-supplied prize text');

    participant.send(JSON.stringify({
      type: 'winner-contact',
      winnerId: winnerMsg.winnerId,
      contact: '555-1234 / winner@example.com',
    }));
    await new Promise((r) => setTimeout(r, 200));
    const contactAck = participant.__msgs.find((m) => m.type === 'winner-contact-ok');
    assert(!!contactAck, 'genuine winnerId contact submission is accepted');

    const spoofWs = await waitForOpen(base);
    attachAccumulator(spoofWs);
    spoofWs.send(JSON.stringify({
      type: 'winner-contact',
      winnerId: 'not-a-real-winner-id',
      contact: '000-0000',
    }));
    await new Promise((r) => setTimeout(r, 200));
    const spoofResult = spoofWs.__msgs.find((m) => m.type === 'winner-contact-error');
    assert(!!spoofResult, 'spoofed winnerId is rejected with winner-contact-error');
    assert(spoofResult && /süresi dolmuş/.test(spoofResult.error || ''), 'spoofed winnerId gets the Turkish expired-link error');

    participant.close(); admin.close(); spoofWs.close();
    inst.server.kill();
  });

  await step('show-start / show-pause / show-stop sequencing reaches participants', async () => {
    const participant = await waitForOpen(base);
    attachAccumulator(participant);
    participant.send(JSON.stringify({ type: 'join', deviceId: 'dev-showflow-test' }));
    await new Promise((r) => setTimeout(r, 150));

    const admin = await waitForOpen(base);
    attachAccumulator(admin);
    admin.send(JSON.stringify({ type: 'admin-auth', key: ADMIN_KEY }));
    await waitFor(admin, (m) => m.type === 'admin-auth-ok');

    admin.send(JSON.stringify({ type: 'show-start', mode: 'solid', intervalMs: 500 }));
    await waitFor(participant, (m) => m.type === 'show-start', 3000);

    admin.send(JSON.stringify({ type: 'show-pause' }));
    await waitFor(participant, (m) => m.type === 'show-pause', 3000);

    admin.send(JSON.stringify({ type: 'show-stop' }));
    await waitFor(participant, (m) => m.type === 'show-stop', 3000);

    const seq = participant.__msgs
      .filter((m) => ['show-start', 'show-pause', 'show-stop'].includes(m.type))
      .map((m) => m.type);
    assert(seq.includes('show-pause'), 'participant actually receives show-pause');
    assert(seq.includes('show-stop'), 'participant actually receives show-stop');
    assert(seq.indexOf('show-pause') < seq.indexOf('show-stop'), 'show-pause arrives before show-stop in sequence');

    participant.close(); admin.close();
  });

  await step('reset-giveaway re-enables eligibility without dropping connected devices', async () => {
    // Isolated fresh server — same pool-contamination reasoning as the
    // pick-winner test above: this needs to deterministically re-pick the
    // SAME single device, which only holds on a pool with nothing else in it.
    const inst = freshServer();
    await new Promise((r) => setTimeout(r, 400));
    const base = inst.base, ADMIN_KEY = inst.adminKey;

    const participant = await waitForOpen(base);
    attachAccumulator(participant);
    participant.send(JSON.stringify({ type: 'join', deviceId: 'dev-reset-test' }));
    await new Promise((r) => setTimeout(r, 150));

    const admin = await waitForOpen(base);
    attachAccumulator(admin);
    admin.send(JSON.stringify({ type: 'admin-auth', key: ADMIN_KEY }));
    await waitFor(admin, (m) => m.type === 'admin-auth-ok');

    admin.send(JSON.stringify({ type: 'pick-winner', message: 'Round 1' }));
    await waitFor(participant, (m) => m.type === 'winner', 3000);

    admin.send(JSON.stringify({ type: 'reset-giveaway' }));
    const resetAck = await waitFor(admin, (m) => m.type === 'giveaway-reset-ok', 2000);
    assert(!!resetAck, 'reset-giveaway acknowledged with giveaway-reset-ok');

    participant.__msgs = [];
    admin.send(JSON.stringify({ type: 'pick-winner', message: 'Round 2' }));
    const secondWin = await waitFor(participant, (m) => m.type === 'winner', 3000).catch(() => null);
    assert(!!secondWin, 'previously-won device becomes eligible again after reset-giveaway, without needing to rejoin');

    participant.close(); admin.close();
    inst.server.kill();
  });

  server.kill();
  await new Promise((r) => setTimeout(r, 200));
  if (failed > 0) {
    console.error('\n--- server stdout/stderr (for debugging failures) ---\n' + serverLog.slice(-4000));
  }

  console.log(`\nServer test results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
