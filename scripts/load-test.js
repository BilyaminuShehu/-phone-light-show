/**
 * Load test: spins up N fake "phones" against a running server.js instance,
 * runs the same clock-sync ping/pong each real client does, then triggers
 * a cue and measures how tightly all connections would have fired together.
 *
 * This exists to answer one question concretely, on the actual hardware/
 * network you'll use on the night, instead of guessing: "is a single
 * process enough for this venue, and is LEAD_TIME_MS long enough?"
 *
 * Usage:
 *   node server.js &
 *   node scripts/load-test.js --clients=5000 --url=ws://localhost:3000
 *
 * For a real venue test, point --url at the actual deployed instance
 * (e.g. wss://light-show.example.com) and run this from a separate
 * machine on the same network the phones will use, so it captures real
 * network latency instead of loopback latency.
 */

const WebSocket = require('ws');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const CLIENT_COUNT = parseInt(args.clients || '1000', 10);
const URL = args.url || 'ws://localhost:3000';
const CONNECT_STAGGER_MS = parseInt(args.stagger || '2', 10); // ms between connect attempts

console.log(`Load-testing ${URL} with ${CLIENT_COUNT} simulated clients...`);

let connected = 0;
let failed = 0;
const offsets = [];       // estimated clock offset per client
const rtts = [];          // best RTT per client
const fireDeltas = [];    // when each client actually ran setTimeout vs. the ideal target

function makeClient(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    let pingCount = 0;
    const samples = [];

    ws.on('open', () => {
      connected++;
      const tryPing = () => {
        const t0 = Date.now();
        ws.send(JSON.stringify({ type: 'ping', clientSendTime: t0 }));
        const handler = (raw) => {
          const msg = JSON.parse(raw);
          if (msg.type !== 'pong') return;
          const rtt = Date.now() - t0;
          const estServerNow = msg.serverTime + rtt / 2;
          samples.push({ rtt, offset: estServerNow - Date.now() });
          ws.removeListener('message', handler);
          pingCount++;
          if (pingCount < 5) {
            setTimeout(tryPing, 100);
          } else {
            samples.sort((a, b) => a.rtt - b.rtt);
            offsets.push(samples[0].offset);
            rtts.push(samples[0].rtt);
            // Join as a participant — cues are only broadcast to sockets in
            // the server's pool, so without this the client is invisible to
            // trigger/show-start and fireDeltas would never be populated.
            ws.send(JSON.stringify({ type: 'join', deviceId: `load-test-${i}-${Date.now()}` }));
            resolve(ws); // keep socket open for the cue broadcast
          }
        };
        ws.on('message', handler);
      };
      tryPing();
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'cue') {
        const myOffset = offsets[i] ?? 0;
        const targetLocalTime = msg.startAt - myOffset; // first pattern step is t:0
        setTimeout(() => {
          fireDeltas.push(Date.now() - targetLocalTime);
        }, Math.max(0, targetLocalTime - Date.now()));
      }
    });

    ws.on('error', () => {
      failed++;
      resolve(null);
    });
  });
}

async function main() {
  const clients = [];
  for (let i = 0; i < CLIENT_COUNT; i++) {
    clients.push(makeClient(i));
    await new Promise((r) => setTimeout(r, CONNECT_STAGGER_MS));
    if (i % 500 === 0) process.stdout.write(`  connecting... ${i}/${CLIENT_COUNT}\r`);
  }

  await Promise.all(clients);
  console.log(`\nConnected: ${connected}  Failed: ${failed}`);
  console.log(`Median RTT: ${median(rtts)}ms   Max RTT: ${Math.max(...rtts)}ms`);
  console.log(`Median clock offset: ${median(offsets).toFixed(1)}ms`);
  console.log('\nNow trigger a cue against this server (e.g. via /admin.html) to measure fire-time spread...');

  // Wait long enough to catch a manually-triggered cue, then report.
  setTimeout(() => {
    if (fireDeltas.length === 0) {
      console.log('No cue observed — trigger one from /admin.html while this is running.');
    } else {
      console.log(`\nFire-time spread across ${fireDeltas.length} clients:`);
      console.log(`  median deviation from target: ${median(fireDeltas).toFixed(1)}ms`);
      console.log(`  worst-case deviation: ${Math.max(...fireDeltas.map(Math.abs)).toFixed(1)}ms`);
      console.log('  (anything under ~30-50ms is visually imperceptible as a synchronized flash)');
    }
    process.exit(0);
  }, 30000);
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

main();
