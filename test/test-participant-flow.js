/**
 * Browser-side regression tests for participant-facing behavior that
 * isn't specific to the torch fix: Turkish text completeness, the
 * winner-popup vs thank-you-popup priority rule, and reconnect behavior.
 *
 * Run with: node test/test-participant-flow.js
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ok -', msg); }
  else { failed++; console.error('  FAIL -', msg); }
}

function waitForHttp(url, attempts = 40) {
  return new Promise((resolve, reject) => {
    const tryOnce = (left) => {
      http.get(url, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (left <= 0) reject(new Error('server never came up'));
          else setTimeout(() => tryOnce(left - 1), 200);
        });
    };
    tryOnce(attempts);
  });
}

async function installNoTorchRig(page) {
  // Simplest rig: no torch anywhere, so the join flow completes without
  // needing real camera hardware, and tests focus on UI/text behavior.
  await page.addInitScript(() => {
    const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const realStream = await realGUM({ video: true });
      const track = realStream.getVideoTracks()[0];
      track.getCapabilities = () => ({ torch: false });
      return realStream;
    };
  });
}

function freshServer() {
  const port = 6300 + Math.floor(Math.random() * 20000);
  const adminKey = 'flow-test-key-' + Math.random().toString(36).slice(2);
  const fs = require('fs');
  const os = require('os');
  const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'light-flow-test-'));
  fs.copyFileSync(path.join(__dirname, '..', 'server.js'), path.join(instanceDir, 'server.js'));
  fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(instanceDir, 'node_modules'), 'dir');
  fs.symlinkSync(path.join(__dirname, '..', 'public'), path.join(instanceDir, 'public'), 'dir');
  const server = spawn(process.execPath, [path.join(instanceDir, 'server.js')], {
    cwd: instanceDir,
    env: { ...process.env, PORT: String(port), ADMIN_KEY: adminKey, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  return { server, port, adminKey, base: `http://localhost:${port}` };
}

async function main() {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });

  try {
    console.log('\nScenario: all participant-facing join text is Turkish, no English leftovers');
    const inst1 = freshServer();
    await waitForHttp(`${inst1.base}/`);
    const page = await browser.newPage();
    await installNoTorchRig(page);
    await page.goto(`${inst1.base}/`);
    await page.waitForTimeout(300);
    const heading = await page.evaluate(() => document.getElementById('joinHeading').textContent);
    const sub = await page.evaluate(() => document.getElementById('joinSub').textContent);
    assert(heading.includes('Telefonunuzu Açık Tutun'), `join heading is the Turkish "keep phone on" text (got: "${heading}")`);
    assert(sub.includes('kilitlemeyin') && sub.includes('ayrılmayın'), `join subtitle is the full Turkish instruction (got: "${sub}")`);
    await page.close();
    inst1.server.kill();

    console.log('\nScenario: winner popup takes priority over thank-you popup and is never overridden by it');
    const inst2 = freshServer();
    await waitForHttp(`${inst2.base}/`);
    const PORT = inst2.port;
    const winCtx = await browser.newContext();
    const pageWin = await winCtx.newPage();
    await installNoTorchRig(pageWin);
    await pageWin.goto(`${inst2.base}/`);
    await pageWin.waitForTimeout(1800); // let join + clock sync complete

    // Connect a real admin over a raw WS to drive pick-winner + show-stop against this same server.
    const admin = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise((resolve) => admin.on('open', resolve));
    admin.send(JSON.stringify({ type: 'admin-auth', key: inst2.adminKey }));
    await new Promise((resolve) => {
      admin.on('message', function handler(raw) {
        const m = JSON.parse(raw);
        if (m.type === 'admin-auth-ok') { admin.removeListener('message', handler); resolve(); }
      });
    });

    admin.send(JSON.stringify({ type: 'pick-winner', message: 'You won!' }));
    await pageWin.waitForTimeout(500);
    const winnerVisible1 = await pageWin.evaluate(() => document.getElementById('winnerOverlay').style.display === 'flex');
    assert(winnerVisible1, 'winner overlay actually appears after pick-winner');

    // Now simulate show-stop arriving (which would normally trigger the thank-you popup).
    admin.send(JSON.stringify({ type: 'show-stop' }));
    await pageWin.waitForTimeout(500);
    const winnerStillVisible = await pageWin.evaluate(() => document.getElementById('winnerOverlay').style.display === 'flex');
    const thankYouVisible = await pageWin.evaluate(() => document.getElementById('thankYouOverlay').style.display === 'flex');
    assert(winnerStillVisible, 'winner overlay remains visible after show-stop fires');
    assert(!thankYouVisible, 'thank-you overlay does NOT override an active winner celebration');

    admin.close();
    await pageWin.close();
    await winCtx.close();
    inst2.server.kill();

    console.log('\nScenario: thank-you popup DOES appear on show-stop for a non-winner');
    const inst3 = freshServer();
    await waitForHttp(`${inst3.base}/`);
    const loseCtx = await browser.newContext();
    const pageLose = await loseCtx.newPage();
    await installNoTorchRig(pageLose);
    await pageLose.goto(`${inst3.base}/`);
    await pageLose.waitForTimeout(1800);
    const admin2 = new WebSocket(`ws://localhost:${inst3.port}`);
    await new Promise((resolve) => admin2.on('open', resolve));
    admin2.send(JSON.stringify({ type: 'admin-auth', key: inst3.adminKey }));
    await new Promise((resolve) => {
      admin2.on('message', function handler(raw) {
        const m = JSON.parse(raw);
        if (m.type === 'admin-auth-ok') { admin2.removeListener('message', handler); resolve(); }
      });
    });
    admin2.send(JSON.stringify({ type: 'show-stop' }));
    await pageLose.waitForTimeout(500);
    const thankYouShown = await pageLose.evaluate(() => document.getElementById('thankYouOverlay').style.display === 'flex');
    assert(thankYouShown, 'thank-you overlay appears for a participant who did not win');
    admin2.close();
    await pageLose.close();
    await loseCtx.close();
    inst3.server.kill();

  } finally {
    await browser.close();
  }

  console.log(`\nParticipant-flow test results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
