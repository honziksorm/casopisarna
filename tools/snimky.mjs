// Snímky čtečky pro náhledy (nahled/) přes Chrome bez okna a DevTools protokol, bez dalších knihoven.
// 1. chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<dočasný profil> about:blank
// 2. node tools/snimky.mjs 9333 <výstupní složka> <plán.json>
//    plán: {width, height, scale, steps: [{url, wait} | {js, after} | {shot: "soubor.jpg"}]}
//    js běží jako tělo async funkce, return se vypíše

import fs from 'node:fs';
import path from 'node:path';

const [port, outDir, planFile] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const n = ++id;
  pending.set(n, resolve);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) console.log('  ! chyba JS:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description);
  return r.result && r.result.result && r.result.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
const W = plan.width || 1440, H = plan.height || 900;
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: plan.scale || 2, mobile: false });

for (const step of plan.steps) {
  if (step.url) {
    await send('Page.navigate', { url: step.url });
    await sleep(step.wait || 2500);
  }
  if (step.js) {
    const v = await evaluate(`(async () => { ${step.js} })()`);
    if (v !== undefined) console.log('  ', step.name || '', JSON.stringify(v));
    await sleep(step.after || 800);
  }
  if (step.shot) {
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
    const file = path.join(outDir, step.shot);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('snímek', step.shot, Math.round(fs.statSync(file).size / 1024), 'kB');
  }
}
ws.close();
