/**
 * Browser-side test for the multi-lens torch-probing logic
 * (getRearCameraStreamWithTorch in public/index.html) — the fix for the
 * real-world Android bug where getCapabilities() reported torch:false.
 *
 * Root cause this proves out: facingMode:{exact:'environment'} only asks
 * for SOME environment-facing camera. On a multi-lens phone the browser
 * can hand back the ultra-wide/macro lens (no torch exposed) instead of
 * the main lens (which has the real LED). The fix enumerates every rear
 * camera and probes each one directly until it finds the one that
 * actually reports torch:true.
 *
 * Chromium's own fake-device flag (--use-fake-device-for-media-stream)
 * gives us a real MediaStream/MediaStreamTrack (required because
 * <video>.srcObject rejects anything that isn't a real MediaStream —
 * found the hard way earlier in this project), but that fake device has
 * no concept of multiple lenses or a real torch. So this test keeps the
 * REAL stream/track objects from the fake device (so srcObject assignment
 * and playback genuinely work) and only overrides each track's
 * getCapabilities()/applyConstraints() to simulate a specific lens's real
 * torch capability — simulating the camera hardware, not the browser
 * plumbing around it. It cannot and does not claim to prove a physical
 * LED lights up; only a real device can prove that. What it proves is
 * that the code correctly walks every rear lens and drives the one that
 * reports torch:true, instead of giving up on whichever lens
 * facingMode:'environment' happened to default to.
 *
 * Run with: node test/test-torch-lens.js
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

// Installs a fake multi-lens rig BEFORE any page script runs. `lenses` is
// an ordered list of { id, label, facingMode, torch }; `defaultLensId` is
// whichever lens the simulated browser's facingMode:{exact:'environment'}
// negotiation happens to resolve to — which, on a real multi-lens Android
// phone, is implementation-defined and NOT guaranteed to be the lens with
// torch control. Every getUserMedia call still goes through Chromium's
// real fake camera device, so the returned stream/track are genuine
// MediaStream/MediaStreamTrack objects; only capability/torch behavior is
// simulated, per virtual lens.
async function installFakeCameraRig(page, { lenses, defaultLensId }) {
  await page.addInitScript(({ lenses, defaultLensId }) => {
    window.__streamsCreated = [];
    window.__torchCallLog = [];
    const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.enumerateDevices = async () =>
      lenses.map((l) => ({ kind: 'videoinput', deviceId: l.id, label: l.label }));

    navigator.mediaDevices.getUserMedia = async (constraints) => {
      let lens;
      const video = constraints && constraints.video;
      if (video && video.deviceId && video.deviceId.exact) {
        lens = lenses.find((l) => l.id === video.deviceId.exact);
        if (!lens) throw new DOMException('Requested device not found', 'OverconstrainedError');
      } else if (video && video.facingMode && video.facingMode.exact === 'environment') {
        lens = lenses.find((l) => l.id === defaultLensId);
      } else {
        lens = lenses.find((l) => l.id === defaultLensId) || lenses[0];
      }
      const realStream = await realGUM({ video: true }); // genuine MediaStream from Chromium's fake camera device
      const track = realStream.getVideoTracks()[0];
      track.getCapabilities = () => ({ torch: lens.torch, facingMode: [lens.facingMode] });
      track.applyConstraints = async (c) => {
        window.__torchCallLog.push({ lensId: lens.id, on: c && c.advanced && c.advanced[0] && c.advanced[0].torch });
        if (!lens.torch) throw new DOMException('Overconstrained', 'OverconstrainedError');
      };
      window.__streamsCreated.push(lens.id);
      return realStream;
    };
  }, { lenses, defaultLensId });
}

async function main() {
  const PORT = 6500 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: 'torch-test-key', NODE_ENV: 'test' },
    stdio: 'ignore',
    cwd: path.join(__dirname, '..'),
  });
  await waitForHttp(`http://localhost:${PORT}/`);

  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });

  try {
    // --- Scenario 1: default "environment" lens already has torch (the common case) ---
    {
      console.log('\nScenario 1: default lens already has torch — should use it directly, no probing needed');
      const page = await browser.newPage();
      await installFakeCameraRig(page, {
        lenses: [
          { id: 'main', label: 'Back Camera', facingMode: 'environment', torch: true },
          { id: 'ultrawide', label: 'Back Ultra Wide Camera', facingMode: 'environment', torch: false },
        ],
        defaultLensId: 'main',
      });
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForTimeout(600);
      const diag = await page.evaluate(() => document.getElementById('diagInfo').textContent);
      assert(/torch:true/.test(diag), 'diagnostics report torch:true when the default lens already has it');
      assert(!/alternatif lens/.test(diag), 'no alternate-lens probing message when the default lens already worked');
      const streamsCreated = await page.evaluate(() => window.__streamsCreated.length);
      assert(streamsCreated === 1, `only one getUserMedia call made when the first lens already has torch (made ${streamsCreated})`);
      await page.close();
    }

    // --- Scenario 2 (THE REAL-WORLD BUG): default "environment" lens has NO torch,
    //     but a second rear lens on the same phone genuinely does ---
    {
      console.log('\nScenario 2: default lens has NO torch, but another rear lens does — must probe and switch to it');
      const page = await browser.newPage();
      await installFakeCameraRig(page, {
        lenses: [
          { id: 'ultrawide', label: 'Back Ultra Wide Camera', facingMode: 'environment', torch: false },
          { id: 'main', label: 'Back Camera', facingMode: 'environment', torch: true },
          { id: 'front', label: 'Front Camera', facingMode: 'user', torch: false },
        ],
        defaultLensId: 'ultrawide', // this is the exact real-world failure mode reported by the user
      });
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForTimeout(600);
      const diag = await page.evaluate(() => document.getElementById('diagInfo').textContent);
      assert(/torch:true/.test(diag), 'diagnostics report torch:true after probing finds the main lens');
      assert(/alternatif lens/.test(diag), 'diagnostics note that an alternate lens had to be found');

      const streamsCreated = await page.evaluate(() => window.__streamsCreated);
      assert(streamsCreated.includes('ultrawide') && streamsCreated.includes('main'),
        'both the failed default lens and the working alternate lens were actually requested: ' + JSON.stringify(streamsCreated));
      assert(!streamsCreated.includes('front'), 'the front-facing camera is never probed');

      // Verify the real-world consequence: setLight() now drives the lens that actually has torch.
      await page.evaluate(() => setLight(true));
      await page.waitForTimeout(100);
      const calls = await page.evaluate(() => window.__torchCallLog);
      assert(calls.length > 0 && calls[calls.length - 1].lensId === 'main', 'setLight(true) issues the real torch command to the main lens, not the ultra-wide');
      assert(calls[calls.length - 1].on === true, 'the torch command requests ON');
      await page.close();
    }

    // --- Scenario 3: NO rear lens anywhere has torch (genuine hardware/browser limitation) ---
    {
      console.log('\nScenario 3: no rear lens has torch at all — must fall back to screen-flash honestly, not claim success');
      const page = await browser.newPage();
      await installFakeCameraRig(page, {
        lenses: [
          { id: 'main', label: 'Back Camera', facingMode: 'environment', torch: false },
          { id: 'ultrawide', label: 'Back Ultra Wide Camera', facingMode: 'environment', torch: false },
        ],
        defaultLensId: 'main',
      });
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForTimeout(600);
      const diag = await page.evaluate(() => document.getElementById('diagInfo').textContent);
      assert(/torch:false/.test(diag), 'diagnostics honestly report torch:false when genuinely no lens has it');
      assert(/tüm kameralar denendi/.test(diag), 'diagnostics note that all cameras were tried before giving up');

      // When no torch exists, setLight must fall back to the full-screen flash element, not error out.
      const bgAfterOn = await page.evaluate(() => { setLight(true); return document.getElementById('flash').style.background; });
      assert(/255, ?255, ?255|#fff/i.test(bgAfterOn), 'screen-flash fallback actually whitens the flash element when no torch exists');
      await page.close();
    }

    // --- Scenario 4: join status text is IDENTICAL regardless of torch vs. screen-flash outcome ---
    {
      console.log('\nScenario 4: join status text must be identical whether real torch or screen-flash fallback is used');
      const pageTorch = await browser.newPage();
      await installFakeCameraRig(pageTorch, {
        lenses: [{ id: 'main', label: 'Back Camera', facingMode: 'environment', torch: true }],
        defaultLensId: 'main',
      });
      await pageTorch.goto(`http://localhost:${PORT}/`);
      await pageTorch.waitForTimeout(1800); // clock-sync does 5 pings ~150ms apart before join completes
      const textWithTorch = await pageTorch.evaluate(() => document.getElementById('status').textContent);

      const pageNoTorch = await browser.newPage();
      await installFakeCameraRig(pageNoTorch, {
        lenses: [{ id: 'main', label: 'Back Camera', facingMode: 'environment', torch: false }],
        defaultLensId: 'main',
      });
      await pageNoTorch.goto(`http://localhost:${PORT}/`);
      await pageNoTorch.waitForTimeout(1800);
      const textNoTorch = await pageNoTorch.evaluate(() => document.getElementById('status').textContent);

      assert(textWithTorch === textNoTorch, `status text is identical regardless of torch outcome ("${textWithTorch}" === "${textNoTorch}")`);
      assert(/hazır/i.test(textWithTorch), 'status text uses the unified Turkish "ready" wording');
      await pageTorch.close();
      await pageNoTorch.close();
    }

    // --- Scenario 5: reacquireTorchIfNeeded also benefits from multi-lens probing after a reconnect ---
    {
      console.log('\nScenario 5: re-acquiring torch after backgrounding also probes every lens, not just the default');
      const page = await browser.newPage();
      await installFakeCameraRig(page, {
        lenses: [
          { id: 'ultrawide', label: 'Back Ultra Wide Camera', facingMode: 'environment', torch: false },
          { id: 'main', label: 'Back Camera', facingMode: 'environment', torch: true },
        ],
        defaultLensId: 'ultrawide',
      });
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForTimeout(600);
      // Simulate the camera track dying (common when a phone screen locks) and reacquiring.
      await page.evaluate(() => { torchTrack.readyState = 'ended'; });
      await page.evaluate(() => reacquireTorchIfNeeded());
      await page.waitForTimeout(300);
      const caps = await page.evaluate(() => torchTrack && torchTrack.getCapabilities());
      assert(caps && caps.torch === true, 'reacquireTorchIfNeeded() also finds the real torch lens, not just the dead default one');
      await page.close();
    }

  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\nTorch-lens test results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
