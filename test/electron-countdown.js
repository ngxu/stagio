// Desktop-app check of Stagio Extra's countdown window (needs a desktop; opens windows briefly).
//   npx electron test/electron-countdown.js
// Starts the real app (electron/main.js) on port 7301 with a temporary data folder, runs a short
// countdown, checks the countdown window opens (full screen on a second screen, or as a window on
// one screen), saves a picture of it, checks it closes when the run moves on, then quits.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'od-electron-'));
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port: 7301 }));
process.env.STAGIO_DATA = data;
process.env.STAGIO_EDITION = 'extra';
const out = path.join(os.tmpdir(), 'od-countdown-window.png');
const base = 'http://127.0.0.1:7301';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

require('../electron/main.js');

app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 60; i++) { if (await fetch(`${base}/api/ping`).then((r) => r.ok, () => false)) break; await sleep(500); }
    await call('/api/run/shows', [{ id: 't', name: 'Window test', parts: [
      { id: 'c', kind: 'countdown', name: 'Countdown', minutes: 2, title: 'Starting soon', notices: ['Welcome'], autoNext: false },
      { id: 'm', kind: 'manual', name: 'Talk', minutes: 5 },
    ] }], 'PUT');
    const r = await call('/api/run/start', { showId: 't', index: 0 });
    check('the run starts on the countdown', r.ok === true, JSON.stringify(r));
    await sleep(2500);
    const st = await fetch(`${base}/api/state`).then((x) => x.json());
    const mode = st.run?.active?.screen;
    const cd = BrowserWindow.getAllWindows().find((w) => /countdown/i.test(w.getTitle()));
    check('the countdown window is open', !!cd && cd.isVisible(), `mode ${mode}, ${BrowserWindow.getAllWindows().length} windows`);
    check('...full screen on the projector, or a window when there is one screen', mode === 'full' || mode === 'window', mode);
    if (cd) {
      const img = await cd.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      const text = await cd.webContents.executeJavaScript('document.querySelector("#time").textContent + " | " + document.querySelector("#title").textContent');
      check('...and shows the countdown and its title', /^[12]:\d\d \| Starting soon$/.test(text), text);
    }
    await call('/api/run/next');
    await sleep(800);
    const still = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /countdown/i.test(w.getTitle()));
    check('the window closes when the run goes on to the next part', !still);
    await call('/api/run/stop');
  } catch (e) {
    check('ran to the end', false, e.stack);
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed${fs.existsSync(out) ? ` · picture: ${out}` : ''}`);
  for (const w of BrowserWindow.getAllWindows()) w.destroy(); // no "a slide show is running" question
  setTimeout(() => app.exit(failed ? 1 : 0), 300);
});
