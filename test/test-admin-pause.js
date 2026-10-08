/**
 * Browser-side test for admin.html's play/pause/stop state machine —
 * regression coverage for the previously-fixed bug where clicking Play
 * fired the audio-unlock trick's synthetic pause event and that was
 * misread as a genuine pause, instantly triggering the full stop +
 * thank-you flow instead of actually starting the show.
 *
 * Run with: node test/test-admin-pause.js
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

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

// A short, real, silent WAV so playAndSync()'s `if (!player.src) return`
// guard is satisfied with a genuinely loadable/playable audio source —
// using player.src (not srcObject) matches exactly how the real
// file-upload handler loads audio, which matters because playAndSync()
// checks player.src specifically.
function makeSilentWavDataUrl(durationSec = 2) {
  const sampleRate = 8000;
  const numSamples = sampleRate * durationSec;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  // samples already zeroed = silence
  return 'data:audio/wav;base64,' + buffer.toString('base64');
}

async function main() {
  const PORT = 6900 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: 'admin-pause-test-key', NODE_ENV: 'test' },
    stdio: 'ignore',
    cwd: path.join(__dirname, '..'),
  });
  await waitForHttp(`http://localhost:${PORT}/`);

  const browser = await chromium.launch();

  try {
    console.log('\nScenario: clicking Play must NOT trigger the thank-you/stop flow (regression test)');
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    // The real magic-link flow: ?key=... auto-authenticates on load.
    await page.goto(`http://localhost:${PORT}/admin.html?key=admin-pause-test-key`);
    await page.waitForTimeout(800);
    const authedOk = await page.evaluate(() => document.getElementById('panel').style.display === 'block');
    assert(authedOk, 'admin page auto-authenticates via the ?key= magic link');

    // Load a real, playable audio source exactly the way the file-input handler does.
    const dataUrl = makeSilentWavDataUrl(2);
    await page.evaluate((src) => {
      const player = document.getElementById('player');
      player.src = src;
      generatedPattern = null; generatedBpm = null; generatedDurationMs = null;
    }, dataUrl);
    await page.waitForTimeout(200);

    // Track every WS message type the admin's own socket sends, by wrapping sendToServer.
    await page.evaluate(() => {
      window.__sentTypes = [];
      const origSend = sendToServer;
      window.sendToServer = (obj) => { window.__sentTypes.push(obj.type); return origSend(obj); };
    });

    await page.evaluate(() => playAndSync());
    await page.waitForTimeout(1000); // let the unlock trick's play().then(pause()) and any 'playing' event settle

    const sentTypes = await page.evaluate(() => window.__sentTypes);
    assert(!sentTypes.includes('show-stop'), `clicking Play never sends show-stop (sent: ${JSON.stringify(sentTypes)})`);
    assert(!sentTypes.includes('show-pause'), `clicking Play never sends show-pause from the unlock trick (sent: ${JSON.stringify(sentTypes)})`);
    assert(sentTypes.includes('show-start') || sentTypes.includes('song-cue'), `clicking Play actually starts the show (sent: ${JSON.stringify(sentTypes)})`);

    console.log('\nScenario: a genuine pause mid-song DOES send show-pause, not show-stop');
    await page.evaluate(() => { window.__sentTypes = []; });
    await page.evaluate(() => document.getElementById('player').play());
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('player').pause());
    await page.waitForTimeout(300);
    const pauseSent = await page.evaluate(() => window.__sentTypes);
    assert(pauseSent.includes('show-pause'), `a genuine pause sends show-pause (sent: ${JSON.stringify(pauseSent)})`);
    assert(!pauseSent.includes('show-stop'), `a genuine pause never sends show-stop (sent: ${JSON.stringify(pauseSent)})`);

    console.log('\nScenario: resuming after a genuine pause restarts the pattern in sync, not a duplicate "fresh start"');
    await page.evaluate(() => { window.__sentTypes = []; });
    await page.evaluate(() => document.getElementById('player').play());
    await page.waitForTimeout(400);
    const resumeSent = await page.evaluate(() => window.__sentTypes);
    assert(resumeSent.includes('show-start') || resumeSent.includes('song-cue'), `resuming re-sends a start/cue message to restart lights (sent: ${JSON.stringify(resumeSent)})`);

    console.log('\nScenario: explicit Stop button sends show-stop exactly once, no stray show-pause');
    await page.evaluate(() => { window.__sentTypes = []; });
    await page.evaluate(() => stopSong());
    await page.waitForTimeout(300);
    const stopSent = await page.evaluate(() => window.__sentTypes);
    assert(stopSent.filter((t) => t === 'show-stop').length === 1, `Stop button sends show-stop exactly once (sent: ${JSON.stringify(stopSent)})`);
    assert(!stopSent.includes('show-pause'), `Stop button never triggers a stray show-pause (sent: ${JSON.stringify(stopSent)})`);

    assert(consoleErrors.length === 0, `no uncaught page errors during the whole flow (${JSON.stringify(consoleErrors)})`);

    await page.close();
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\nAdmin pause/resume test results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
