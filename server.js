// Stagio: one operator controls PowerPoint, the music and the outputs from one console.
const express = require('express');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const QRCode = require('qrcode');

const config = require('./lib/config');
const { CueRunner, STEP_TYPES } = require('./lib/cues');
const { AutoCues } = require('./lib/autocues');
const { RunOfShow } = require('./lib/runofshow');
const platform = require('./lib/platform').create(); // Windows, or Mac (beta)
// Lite, Standard or Extra (lib/edition.js): what this Stagio shows and does.
const edition = require('./lib/edition').current();
const ed = edition.features;

const cfg = config.load();
const saveCfg = () => config.save(cfg);

const { ppt, program, localMusic, output } = platform;
// Lite has no music: nothing is polled or controlled, whatever the shared settings say.
const music = () => (ed.music && cfg.features.music === 'local' ? localMusic : null);
// The music app chosen in Stagio ('' = whatever plays), and the one followed last (for "Open").
localMusic.sourceFn = () => cfg.music.source;
localMusic.lastAppFn = () => cfg.music.lastApp;
const cues = new CueRunner({ ppt, output, music });

// Every "start show" (button, key, cue) applies the display chosen under Output. Once Stagio has
// changed PowerPoint's own setting, going back to "Automatic" has to be written back as well.
// It also says whether PowerPoint's Presenter View should come up on the operator's screen.
ppt.startOptions = () => {
  const o = cfg.pptMonitor ? { monitor: cfg.pptMonitor } : cfg.pptMonitorManaged ? { monitorAuto: true } : {};
  if (platform.features.presenterView) o.presenterView = cfg.hidePresenterView ? 'off' : 'on';
  return o;
};
ppt.startDone = (used) => {
  if (used.monitorAuto) { cfg.pptMonitorManaged = false; saveCfg(); }
};

// Recently used presentations (newest first), offered in the Open window.
const isFilePath = (p) => /[\\/]/.test(String(p || ''));
const recentGone = new Set(); // recent files no longer where they were (see the loop below)
function addRecent(p, name) {
  if (!isFilePath(p)) return; // a new, never saved presentation has no file to reopen
  if (cfg.recent[0]?.path === p) return;
  const key = p.toLowerCase();
  cfg.recent = [{ path: p, name: name || p.split(/[\\/]/).pop() }, ...cfg.recent.filter((r) => r.path.toLowerCase() !== key)].slice(0, 8);
  saveCfg();
}
function dropRecent(p) {
  const key = String(p).toLowerCase();
  const kept = cfg.recent.filter((r) => r.path.toLowerCase() !== key);
  if (kept.length !== cfg.recent.length) { cfg.recent = kept; saveCfg(); }
}

// Show timer, kept here so every console shows the same times: how long the show has been
// running, how long the current slide has been up, and a segment that restarts when the show
// starts, whenever a cue runs (by hand or by itself) and when the operator restarts it.
// Times are this PC's clock (ms); consoles correct for their own clock (see /api/ping).
const timer = { showAt: null, showApprox: false, slideAt: null, segAt: null, segBy: null };
function startSegment(by) { timer.segAt = Date.now(); timer.segBy = by; }

// Cues bound to a slide run by themselves when the show gets there (lib/autocues.js).
const autoCues = new AutoCues({
  cues: () => cfg.cues,
  enabled: () => ed.cues && cfg.autoCues,
  current: () => ppt.state.show || null,
  isRunning: (id) => cues.running?.id === id,
  run: async (cue) => {
    startSegment(cue.name);
    const errors = await cues.run(cue);
    await ppt.poll().catch(() => {});
    return errors;
  },
  onFire: () => broadcast(),
});
// Run of show (Extra only; the other editions leave the saved runs alone): see lib/runofshow.js.
const runOfShow = ed.run ? new RunOfShow({
  cfg, save: saveCfg, ppt, music, cues,
  cueList: () => cfg.cues,
  onChange: () => broadcast(),
  segment: (name) => startSegment(name),
}) : null;

ppt.onSlideChange = (before, after, first) => {
  if (after && after.path !== before?.path) addRecent(after.path, after.name);
  const now = Date.now();
  if (after && (!before || before.path !== after.path)) {
    timer.showAt = now;
    timer.showApprox = first; // already running when Stagio started: the real start is unknown
    // A cue that starts the show ("Opening") has just begun the segment; keep its name.
    if (!(timer.segAt && now - timer.segAt < 15000)) startSegment('');
  }
  if (after) timer.slideAt = now;
  else { timer.showAt = null; timer.slideAt = null; }
  autoCues.onSlideChange(before, after, first);
};

// ---------------- network / access ----------------

/** This PC's IPv4 addresses, the most likely Wi-Fi/LAN one first. */
function lanAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|VMware|VirtualBox|Hyper-V|WSL|Loopback|Bluetooth/i.test(name);
      found.push({ address: a.address, score: (virtual ? 0 : 2) + (/^192\.168\./.test(a.address) ? 1 : 0) });
    }
  }
  return found.sort((a, b) => b.score - a.score).map((x) => x.address);
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ ok: false, error: 'The request could not be read' });
  }
  next(err);
});

// The page itself (HTML/JS/CSS) is public: it holds no secrets, and phones must be able to load
// it to show the sign-in screen. Everything that controls or reads the show needs the access key.
app.use(express.static(path.join(__dirname, 'public')));

// Requests made by this PC are trusted without a key, so they must really come from the Stagio
// console and not from some web page open in a browser on this PC:
//   - a page on another site that posts here sends its own Origin (or Sec-Fetch-Site: cross-site);
//   - a page that points its own domain name at 127.0.0.1 ("DNS rebinding") still sends that
//     name as Host, while the console is only ever opened by IP address or this PC's name.
const ownNames = new Set(['localhost', os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`]);
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '');
  const hostOk = net.isIP(name) !== 0 || ownNames.has(name);
  const origin = req.headers.origin;
  const foreignOrigin = origin !== undefined && origin !== `http://${host}`;
  const crossSiteFetch = req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate';
  if (!hostOk || foreignOrigin || crossSiteFetch) {
    return res.status(403).json({ ok: false, error: 'Request refused: it did not come from the Stagio console' });
  }
  next();
});

// ---------------- remote access ----------------
// The PC itself is always trusted. Phones/tablets present the access key, which they get from the
// QR code or by entering the PIN. The key is sent as a header (or ?key= for images and the live
// stream), with a cookie as a fallback, so in-app browsers that drop cookies still work.

// X-OneDesk-Key: the same header from before the rename (Stagio was called OneDesk).
const headerKey = (req) => req.get('x-stagio-key') || req.get('x-onedesk-key');
const authorized = (req) => isLoopback(req)
  || [headerKey(req), req.query.key, readCookie(req, 'od_key')].includes(cfg.accessKey);

const loginFails = new Map(); // ip -> { n, until }
/** Checks a PIN against `expected`; 8 wrong ones from one address lock it out for 5 minutes. */
function pinLogin(req, res, expected) {
  const ip = req.socket.remoteAddress;
  const f = loginFails.get(ip) || { n: 0, until: 0 };
  if (Date.now() < f.until) { res.status(429).json({ ok: false, error: 'Too many wrong PINs. Try again in a few minutes.' }); return false; }
  if (String(req.body?.pin || '').trim() !== expected) {
    f.n++;
    if (f.n >= 8) { f.n = 0; f.until = Date.now() + 5 * 60000; }
    loginFails.set(ip, f);
    res.status(401).json({ ok: false, error: 'Wrong PIN' });
    return false;
  }
  loginFails.delete(ip);
  return true;
}
app.post('/api/login', (req, res) => {
  if (!pinLogin(req, res, cfg.pin)) return;
  res.setHeader('Set-Cookie', `od_key=${encodeURIComponent(cfg.accessKey)}; Path=/; Max-Age=31536000; SameSite=Lax`);
  res.json({ ok: true, data: { key: cfg.accessKey } });
});
// Stage display (Extra): its own PIN gives its own key, which only reaches the stage display.
app.post('/api/stage/login', (req, res) => {
  if (!ed.stage) return res.status(403).json({ ok: false, error: `The stage display is not part of ${edition.name}` });
  if (!pinLogin(req, res, cfg.stagePin)) return;
  res.json({ ok: true, data: { key: cfg.stageKey } });
});

// What a stage display may reach with its key: its own state, slide pictures, the live picture,
// acknowledging a message, and (when the console allows it) previous/next.
const STAGE_PATHS = [/^\/api\/ping$/, /^\/api\/stage\/(events|ack|next|prev)$/, /^\/api\/ppt\/thumb$/, /^\/api\/program$/];
const isStageKey = (req) => ed.stage && !!cfg.stageKey && [headerKey(req), req.query.key].includes(cfg.stageKey);
app.use((req, res, next) => {
  if (authorized(req)) return next();
  if (isStageKey(req)) {
    if (STAGE_PATHS.some((p) => p.test(req.path))) { req.stage = true; return next(); }
    return res.status(403).json({ ok: false, error: 'The stage display can only show; it cannot do this' });
  }
  res.status(401).json({ ok: false, error: 'Not signed in', login: true });
});

// What this edition doesn't have is refused here, whatever a page or a phone asks for.
const needs = (feature, what) => (req, res, next) => (ed[feature] ? next()
  : res.status(403).json({ ok: false, error: `${what} is not part of ${edition.name}` }));
app.use(['/api/music', '/api/features'], needs('music', 'Music'));
app.use('/api/audio', needs('audio', 'Sound control'));
app.use('/api/display', needs('displayMode', 'Display mode'));
app.use('/api/cues', needs('cues', 'Cues'));
app.use('/api/run', needs('run', 'The run of show'));
app.use('/api/stage', needs('stage', 'The stage display'));

// Cheap "am I still signed in / are you there" check for the console. It also carries this PC's
// clock, so a phone whose clock is off still shows the show timer right.
app.get('/api/ping', (req, res) => res.json({ ok: true, now: Date.now() }));

// Wi-Fi name shown in the Remote dialog, so the phone can be put on the same network.
let wifiName = null;
function readWifiName() {
  execFile('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true }, (err, out) => {
    const m = !err && String(out).match(/^\s*SSID\s*:\s*(.+)$/m);
    wifiName = m ? m[1].trim() : null;
  });
}
if (process.platform === 'win32') {
  readWifiName();
  setInterval(readWifiName, 60000);
}

// How to connect a phone: address, PIN and a QR code that carries the access key. Only the
// console on this PC may ask; a phone that is already signed in has no use for it.
app.get('/api/remote', async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ ok: false, error: 'Only available on the Stagio PC' });
  // Stagio's own Wi-Fi: a code that joins the network, then one that opens the console on it.
  let own = null;
  if (ownWifi.on && ownWifi.ip) {
    const join = `WIFI:T:WPA;S:${cfg.ownWifi.ssid};P:${cfg.ownWifi.pass};;`;
    const openUrl = `http://${ownWifi.ip}:${cfg.port}/?key=${cfg.accessKey}`;
    own = {
      ssid: cfg.ownWifi.ssid, pass: cfg.ownWifi.pass, url: `http://${ownWifi.ip}:${cfg.port}/`,
      joinQr: await QRCode.toString(join, { type: 'svg', margin: 1 }),
      openQr: await QRCode.toString(openUrl, { type: 'svg', margin: 1 }),
    };
  }
  const remotePageQr = platform.features.bluetooth ? await QRCode.toString(REMOTE_PAGE, { type: 'svg', margin: 1 }) : null;
  const [lan, ...others] = lanAddresses().filter((a) => a !== ownWifi.ip);
  // Stage display (Extra): its own code and PIN, on the venue's Wi-Fi or else Stagio's own.
  let stage = null;
  if (ed.stage) {
    const host = lan || (ownWifi.on && ownWifi.ip) || null;
    const stageUrl = host ? `http://${host}:${cfg.port}/stage.html` : null;
    stage = { url: stageUrl, pin: cfg.stagePin, qr: stageUrl ? await QRCode.toString(`${stageUrl}?key=${cfg.stageKey}`, { type: 'svg', margin: 1 }) : null };
  }
  if (!lan && !own) return res.json({ ok: true, data: { own, remotePageQr, stage, pin: cfg.pin } });
  if (!lan) return res.json({ ok: true, data: { own, remotePageQr, stage, pin: cfg.pin, url: null, others: [], qr: null, wifi: null } });
  const qrUrl = `http://${lan}:${cfg.port}/?key=${cfg.accessKey}`;
  res.json({
    ok: true,
    data: {
      own,
      remotePageQr,
      stage,
      url: `http://${lan}:${cfg.port}/`, // to type in by hand (then enter the PIN)
      others: others.map((a) => `http://${a}:${cfg.port}/`),
      qrUrl,
      qr: await QRCode.toString(qrUrl, { type: 'svg', margin: 1 }),
      pin: cfg.pin,
      wifi: wifiName,
    },
  });
});

// ---------------- state & live updates ----------------
// The state is sent in parts. A console gets everything once when it connects, then only the
// parts that changed: the slide list (the bulk of it) is not re-sent every time the music
// position ticks, and the console redraws only what a change touches.

const editionPart = { id: edition.id, name: edition.name, version: edition.version, label: edition.label, features: ed };

function buildParts() {
  return {
    edition: editionPart,
    ppt: { ...ppt.state, focus: ppt.focusPath(), monitor: cfg.pptMonitor || null },
    slides: ppt.slidesForUi(),
    program: program.summary(),
    platform: { os: platform.os, beta: !!platform.beta, ...platform.features },
    features: cfg.features,
    localMusic: ed.music && cfg.features.music === 'local' ? localMusic.summary() : null,
    audio: output.audio,
    displays: output.displays,
    displayMode: output.displayMode,
    cues: cfg.cues,
    cueRunning: cues.running,
    cueAuto: autoCues.last,
    settings: { hidePresenterView: cfg.hidePresenterView, autoCues: cfg.autoCues, cueShift: cfg.cueShift },
    recent: cfg.recent.map((r) => (recentGone.has(r.path) ? { ...r, missing: true } : r)),
    fastCopy: fastCopyState(),
    timer,
    run: runOfShow ? runOfShow.summary() : null,
    stage: ed.stage ? { screens: stageClients.size, message: stageMsg, presets: cfg.stagePresets, canFlip: !!cfg.stageCanFlip } : null,
    remotes: remoteCount(),
    // Backup connections (no password or key here: the state also goes to phones).
    links: {
      ownWifi: platform.features.ownWifi ? { ...ownWifi, ssid: cfg.ownWifi.ssid } : null,
      bluetooth: platform.features.bluetooth ? { ...bt } : null,
      remotePage: REMOTE_PAGE,
    },
  };
}
/** Phones and tablets connected right now (for the pre-event check). */
const remoteCount = () => [...clients].filter((c) => c.remote).length;

/** The whole state in the shape the console works with (slides also under ppt). */
function fullState() {
  const parts = buildParts();
  return { ...parts, ppt: { ...parts.ppt, slides: parts.slides } };
}

const clients = new Set();
const last = {};    // part name -> JSON last sent
let lastSendAt = 0;

const send = (res, payload) => res.write(`data: ${payload}\n\n`);
const joinParts = (entries) => entries.map(([k, json]) => `${JSON.stringify(k)}:${json}`).join(',');

function broadcast() {
  const changed = [];
  const parts = buildParts();
  stageBroadcast(parts);
  for (const [k, v] of Object.entries(parts)) {
    const json = JSON.stringify(v ?? null);
    if (last[k] !== json) { last[k] = json; changed.push([k, json]); }
  }
  if (!changed.length || !clients.size) return;
  const payload = `{${joinParts(changed)}}`;
  for (const res of clients) send(res, payload);
  lastSendAt = Date.now();
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  broadcast(); // bring `last` (and the consoles already connected) up to date first
  send(res, `{"_full":true,${joinParts(Object.entries(last))}}`);
  res.remote = !isLoopback(req);
  clients.add(res);
  if (res.remote) broadcast(); // the count of connected phones changed
  req.on('close', () => { clients.delete(res); if (res.remote) broadcast(); });
});

// When nothing changes, an empty patch every few seconds tells consoles the link is alive; a
// console that hears nothing for a while knows the connection is gone and reconnects.
setInterval(() => {
  // stage displays: the time on this PC, every few seconds (also tells them the link is alive)
  if (stageClients.size && Date.now() - stageSentAt >= 4000) {
    for (const res of stageClients) send(res, JSON.stringify({ now: Date.now() }));
    stageSentAt = Date.now();
  }
  if (!clients.size || Date.now() - lastSendAt < 4000) return;
  for (const res of clients) send(res, '{}');
  lastSendAt = Date.now();
}, 1000);



app.get('/api/state', (req, res) => res.json(fullState()));

// Diagnostics for testing: helper queues/restarts, scan time, memory, live clients.
app.get('/api/debug', (req, res) => {
  const h = (x) => ({ pid: x.proc?.pid || null, pending: x.pending.size, restarts: x.restarts, recycles: x.recycles, calls: x.calls });
  res.json({
    os: platform.os,
    helpers: Object.fromEntries(Object.entries(platform.helpers).map(([k, x]) => [k, h(x)])),
    program: program.status,
    timings: Object.fromEntries(Object.entries(platform.timings()).map(([k, v]) => [k, { n: v.n, avgMs: Math.round(v.totalMs / v.n), maxMs: v.maxMs, lastMs: v.lastMs }])),
    idleMs: Date.now() - ppt.lastActivity,
    scanMs: ppt.lastScanMs ?? null,
    renderMs: ppt.lastRenderMs ?? null,
    fonts: ppt.fonts || null,
    thumbsPending: ppt.slidesForUi()?.pending ?? null,
    slidesKnown: ppt.info.size,
    slidesWithSig: [...ppt.info.values()].filter((e) => e.sig).length,
    lastWatchError: ppt.lastError || null,
    clients: clients.size,
    stateBytes: Object.values(last).reduce((n, j) => n + j.length, 0),
    partBytes: Object.fromEntries(Object.entries(last).map(([k, j]) => [k, j.length])),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
  });
});

/** Runs `fn` again and again, `every` ms apart (a number, or a function returning one). */
function loop(fn, every) {
  const tick = async () => {
    try { await fn(); } catch (e) { console.error(e); }
    broadcast();
    setTimeout(tick, typeof every === 'function' ? every() : every);
  };
  tick();
}

/** Wraps a route handler: runs the action, refreshes the affected state, reports errors as JSON. */
const act = (fn, after) => async (req, res) => {
  try {
    const data = await fn(req);
    if (after) await after().catch(() => {});
    broadcast();
    res.json({ ok: true, data: data ?? null });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
};

// ---------------- when the phone can't use the venue's Wi-Fi (Windows) ----------------
// 1. Stagio's own Wi-Fi: this PC opens a small network ("Stagio-XXXX"); phones join it by QR
//    code and open the console at the PC's address on it. Same name and password every time.
// 2. Bluetooth (Android, Chrome): the phone opens Stagio's remote page (on the download site,
//    https, so Chrome allows Bluetooth) and sends commands straight to this PC; the PIN is part of
//    every command. Runs in the "net" helper (see Bluetooth remote in helper.ps1).
const netHelper = platform.helpers?.net || null;
const ownWifi = { on: false, ip: null, error: null, busy: false };
const bt = { on: false, phones: 0, error: null, busy: false };
const REMOTE_PAGE = 'https://ngxu.github.io/stagio/remote/';

app.post('/api/ownWifi', act(async (req) => {
  if (!platform.features.ownWifi || !netHelper) throw new Error('Not available on this computer');
  if (!isLoopback(req)) throw new Error('Do this on the Stagio PC');
  if (req.body?.on === false) {
    await netHelper.call('wifi.stop').catch(() => {});
    Object.assign(ownWifi, { on: false, ip: null, error: null });
    return;
  }
  ownWifi.busy = true; ownWifi.error = null; broadcast();
  try {
    const r = await netHelper.call('wifi.start', cfg.ownWifi, { timeoutMs: 30000 });
    Object.assign(ownWifi, { on: !!r.on && !!r.ip, ip: r.ip || null });
    if (!ownWifi.on) throw new Error('The network started but has no address yet. Try again in a moment.');
  } catch (e) {
    Object.assign(ownWifi, { on: false, ip: null, error: e.message });
    throw e;
  } finally { ownWifi.busy = false; }
}));

app.post('/api/bluetooth', act(async (req) => {
  if (!platform.features.bluetooth || !netHelper) throw new Error('Not available on this computer');
  if (!isLoopback(req)) throw new Error('Do this on the Stagio PC');
  if (req.body?.on === false) {
    await netHelper.call('ble.stop').catch(() => {});
    Object.assign(bt, { on: false, phones: 0, error: null });
    return;
  }
  bt.busy = true; bt.error = null; broadcast();
  try {
    const st = await netHelper.call('ble.start', {}, { timeoutMs: 30000 });
    if (st !== 'Started') throw new Error(`Bluetooth did not start advertising (${st}). Check that Bluetooth is on.`);
    bt.on = true;
    bleSent = '';
  } catch (e) {
    Object.assign(bt, { on: false, error: e.message });
    throw e;
  } finally { bt.busy = false; }
}));

/** What a Bluetooth phone is shown: kept small (a Bluetooth message holds ~180 bytes). */
function bleState() {
  const s = ppt.state.show;
  const pres = (ppt.state.presentations || []).find((x) => x.path === ppt.focusPath());
  const m = localMusic.state;
  return JSON.stringify({
    v: 1,
    s: s?.slide || 0,
    t: s?.total || pres?.slides || 0,
    st: s ? (s.slide ? s.state : 'end') : (ppt.state.running ? 'ready' : 'off'),
    b: s?.clicks ? `${s.click}/${s.clicks}` : '',
    mu: !music() ? -1 : (m?.isPlaying ? 1 : 0),
    f: music()?.fading || '',
    k: !!cfg.cueShift,
    a: bleAccepted, // commands accepted so far: a phone sees it go up when its PIN is right
  });
}
let bleAccepted = 0;
let bleSent = '';
let bleCuesSent = '';
const bleFails = new Map(); // phone -> { n, until }

async function bleCommand(phone, text) {
  let c;
  try { c = JSON.parse(text); } catch { return; }
  const f = bleFails.get(phone) || { n: 0, until: 0 };
  if (Date.now() < f.until) return;
  if (String(c.pin || '') !== cfg.pin) {
    if (++f.n >= 8) { f.n = 0; f.until = Date.now() + 5 * 60000; }
    bleFails.set(phone, f);
    return;
  }
  bleFails.delete(phone);
  bleAccepted++;
  const show = ppt.state.show;
  try {
    switch (c.c) {
      case 'next': await ppt.cmd('ppt.next'); break;
      case 'prev': await ppt.cmd('ppt.prev'); break;
      case 'black': if (show) await ppt.cmd('ppt.setState', { state: 'black' }); break;
      case 'white': if (show) await ppt.cmd('ppt.setState', { state: 'white' }); break;
      case 'start': if (!show) await ppt.cmd('ppt.start', { path: ppt.focusPath(), slide: Number(c.n) || 1 }); break;
      case 'goto': if (show) await ppt.cmd('ppt.goto', { slide: Number(c.n) || 1 }); break;
      case 'end': if (show) await ppt.cmd('ppt.end'); break;
      case 'cue': {
        const cue = ed.cues ? cfg.cues[Number(c.n) - 1] : null;
        if (!cue) break;
        autoCues.noteRun(cue.id);
        startSegment(cue.name);
        await cues.run(cue);
        break;
      }
      case 'fadeOut': music()?.fadeOut(Number(c.sec) || 4).catch(() => {}); break;
      case 'fadeIn': music()?.fadeIn(Number(c.sec) || 4).catch(() => {}); break;
      case 'play': await music()?.togglePlay(); break;
      default: break;
    }
  } catch (e) { console.error('[bluetooth]', c.c, e.message); }
  await ppt.poll().catch(() => {});
  broadcast();
}

// Settings → Mac check: what PowerPoint and macOS allow on this Mac, as text to send back.
app.get('/api/mac/check', act(async (req) => {
  if (!isLoopback(req)) throw new Error('Run it on the Mac itself');
  if (!platform.check) throw new Error('Only on a Mac');
  return platform.check(`${edition.name} ${edition.label}`);
}));

// Tests only (this PC): a command handled exactly as if a phone had written it over Bluetooth.
app.post('/api/debug/bluetoothCommand', act(async (req) => {
  if (!isLoopback(req)) throw new Error('Only on the Stagio PC');
  await bleCommand(String(req.body?.phone || 'test'), JSON.stringify(req.body?.command || {}));
  return { accepted: bleAccepted, state: JSON.parse(bleState()) };
}));

if (netHelper) {
  // Commands from Bluetooth phones, and the state back to them.
  (async function bleLoop() {
    for (;;) {
      await new Promise((r) => setTimeout(r, bt.on ? 150 : 1000));
      if (!bt.on) continue;
      try {
        const got = await netHelper.call('ble.take');
        for (const line of Array.isArray(got) ? got : []) {
          const i = String(line).indexOf('\t');
          if (i > 0) await bleCommand(line.slice(0, i), line.slice(i + 1));
        }
        const st = bleState();
        const cueNames = JSON.stringify(ed.cues ? cfg.cues.slice(0, 9).map((x) => x.name) : []);
        if (st !== bleSent || cueNames !== bleCuesSent) {
          await netHelper.call('ble.publish', { state: st, cues: cueNames });
          bleSent = st; bleCuesSent = cueNames;
        }
      } catch (e) { bt.error = e.message; }
    }
  })();
  loop(async () => {
    if (ownWifi.on) {
      const r = await netHelper.call('wifi.state').catch(() => null);
      if (r) { ownWifi.on = !!r.on; ownWifi.ip = r.ip || null; if (!r.on) ownWifi.error = 'The network stopped (Wi-Fi switched off?)'; }
    }
    if (bt.on) {
      const s = String(await netHelper.call('ble.status').catch(() => 'off'));
      if (s === 'off') { bt.on = false; bt.phones = 0; } else bt.phones = Number(s.split('|')[1]) || 0;
    }
  }, 3000);
}

// ---------------- PowerPoint ----------------

const pptAfter = () => ppt.poll();
// For slide changes: answer as soon as PowerPoint has done it; the new state follows over the
// live connection a moment later instead of holding up the button.
const pptAfterBg = () => { ppt.poll().then(() => broadcast()); return Promise.resolve(); };
const showPath = () => ppt.state.show?.path;
const DECK_FILE = /\.(pptx?|pptm|ppsx?|ppsm|potx?|potm|odp)$/i;

app.post('/api/ppt/next', act(() => ppt.cmd('ppt.next'), pptAfterBg));
app.post('/api/ppt/prev', act(() => ppt.cmd('ppt.prev'), pptAfterBg));
app.post('/api/ppt/goto', act((req) => {
  const { slide, id, path: p } = req.body;
  if (showPath() && (!p || p === showPath())) return ppt.cmd('ppt.goto', { slide, id });
  return ppt.cmd('ppt.start', { path: p, slide, id });
}, pptAfter));
app.post('/api/ppt/start', act((req) => ppt.cmd('ppt.start', { path: req.body.path, slide: req.body.slide || 1 }), pptAfter));
app.post('/api/ppt/end', act(() => ppt.cmd('ppt.end'), pptAfter));
app.post('/api/ppt/state', act((req) => ppt.cmd('ppt.setState', { state: req.body.state }), pptAfterBg));
app.post('/api/ppt/open', act(async (req) => {
  const p = String(req.body.path || '').trim().replace(/^"|"$/g, '');
  if (!p) throw new Error('Enter a file path');
  if (!DECK_FILE.test(p)) throw new Error('That is not a PowerPoint file (.pptx, .ppt, .ppsx…)');
  let full;
  try {
    full = await ppt.cmd('ppt.open', { path: p });
  } catch (e) {
    if (/File not found/i.test(e.message)) dropRecent(p); // moved or deleted since it was last used
    throw e;
  }
  addRecent(full);
  if (!ppt.state.show) ppt.focus = full; // bring the file just opened into view
  return full;
}, pptAfter));
// A file opened from a download or e-mail waits in PowerPoint's Protected View; this is the
// same as clicking "Enable Editing" there.
app.post('/api/ppt/enableEditing', act(() => ppt.cmd('ppt.enableEditing'), pptAfter));
app.post('/api/ppt/focus', act((req) => { ppt.focus = req.body.path || null; }, pptAfter));
// Reorder from the desk: the slide with this ID goes to position "to" in that file. PowerPoint does
// the move (also during a show); the file is changed but not saved until /api/ppt/save.
app.post('/api/ppt/move', act(async (req) => {
  const p = String(req.body?.path || '');
  const id = Number(req.body?.id);
  const to = Number(req.body?.to);
  if (!p || !Number.isInteger(id) || !Number.isInteger(to) || to < 1) throw new Error('Which slide, and where to?');
  const r = await ppt.cmd('ppt.moveSlide', { path: p, id, to });
  ppt.relist();
  return r;
}, pptAfter));
app.post('/api/ppt/save', act(async (req) => {
  const p = String(req.body?.path || '');
  if (!p) throw new Error('Which file?');
  return ppt.cmd('ppt.save', { path: p });
}, pptAfter));
app.post('/api/ppt/monitor', act((req) => {
  cfg.pptMonitor = req.body.monitor || null;
  if (cfg.pptMonitor) cfg.pptMonitorManaged = true;
  saveCfg();
}));
app.post('/api/ppt/refreshThumbs', act(() => ppt.refreshThumbs(), pptAfter));

// ---------------- faster presentations ----------------
// Some decks (Canva exports with decorative Hebrew set in a font that has no Hebrew letters) are
// slow in PowerPoint for Windows itself: seconds per slide change. When a deck like that is in
// view, the console offers to turn that text into pictures of itself (see PPT-FastCopy* in
// helper.ps1), in one of two ways:
//   - "copy":    a new file next to it; the original is never changed;
//   - "inplace": the file itself, so everyone sharing it keeps working on one file. A backup of
//                the current version is saved on this PC first; the pictures are made and checked
//                on a temporary copy; only then are they put into the file, slide by slide, and
//                only where the text is still exactly what the picture was made from (a co-author
//                may have edited it meanwhile). Then the file is saved.

const slowText = new Map(); // path -> { mtime, result } (from the saved file, or read live for cloud files)
let fastJob = null;         // the job running, or the last one
let restoring = null;       // file name of the earlier version being put back
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKUP_DIR = path.join(config.DATA_DIR, 'backups');
const WORK_DIR = path.join(os.tmpdir(), 'stagio-speedup');

const nameParts = (src) => {
  const clean = String(src).split(/[?#]/)[0];
  const name = decodeURIComponent(clean.split(/[\\/]/).pop() || 'Presentation.pptx');
  const ext = path.extname(name) || '.pptx';
  return { clean, ext, base: name.slice(0, name.length - ext.length) };
};
const isLocalPath = (p) => /^[a-z]:[\\/]/i.test(p) || String(p).startsWith('\\\\');

/** "<name> (fast).pptx" next to the original (or in Documents for a cloud file), not yet taken. */
function fastCopyPath(src) {
  const { clean, ext, base } = nameParts(src);
  const dir = isLocalPath(clean) ? path.dirname(clean) : path.join(os.homedir(), 'Documents');
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base} (fast${n > 1 ? ` ${n}` : ''})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}

// ---- earlier versions (backups) ----
// Before a speed-up (and before putting an earlier version back) the file as it was is copied to
// BACKUP_DIR as "<name> (before speed-up|restore <date time>).pptx". index.json remembers which
// file each copy belongs to; copies made before it existed are matched by name. The last 5 are kept.
const BACKUP_KEEP = 5;
const BACKUP_INDEX = path.join(BACKUP_DIR, 'index.json');
let backupIndex = {};   // copy's file name -> { path, kind, at }
let backupFiles = [];   // [{ file, at, size, kind }], newest first

/** When a copy was made: from its name (an exact file copy keeps the original's modified time). */
function backupTime(file, mtime) {
  const m = file.match(/\(before (?:speed-up|restore) (\d{4})-(\d\d)-(\d\d) (\d\d)\.(\d\d)\.(\d\d)\)/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : mtime;
}

function scanBackups() {
  try { backupIndex = JSON.parse(fs.readFileSync(BACKUP_INDEX, 'utf8')) || {}; } catch { backupIndex = {}; }
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR); } catch { /* none yet */ }
  backupFiles = names.filter((n) => /\(before (speed-up|restore) /.test(n)).map((n) => {
    try {
      const st = fs.statSync(path.join(BACKUP_DIR, n));
      if (!st.isFile()) return null;
      return { file: n, at: backupIndex[n]?.at || backupTime(n, st.mtimeMs), size: st.size, kind: /\(before restore /.test(n) ? 'restore' : 'speed-up' };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.at - a.at);
}

function noteBackup(file, src, kind) {
  scanBackups();
  backupIndex[path.basename(file)] = { path: src, kind, at: Date.now() };
  try { fs.writeFileSync(BACKUP_INDEX, JSON.stringify(backupIndex, null, 1)); } catch { /* matched by name then */ }
  scanBackups();
}

/** Keeps the newest BACKUP_KEEP copies (and any named in `keep`). */
function pruneBackups(keep = new Set()) {
  scanBackups();
  let removed = false;
  for (const b of backupFiles.slice(BACKUP_KEEP)) {
    if (keep.has(b.file)) continue;
    try { fs.rmSync(path.join(BACKUP_DIR, b.file), { force: true }); delete backupIndex[b.file]; removed = true; } catch { /* in use: next time */ }
  }
  if (removed) { try { fs.writeFileSync(BACKUP_INDEX, JSON.stringify(backupIndex, null, 1)); } catch { /* ignore */ } }
  scanBackups();
}

/** Earlier versions of the presentation `deck`, newest first. */
function backupsFor(deck) {
  if (!deck) return [];
  const { base } = nameParts(deck);
  return backupFiles.filter((b) => {
    const e = backupIndex[b.file];
    return e ? e.path === deck : b.file.startsWith(`${base} (before `);
  }).map((b) => ({ file: b.file, at: b.at, kind: b.kind, sizeMB: Math.round(b.size / 104857.6) / 10 }));
}

/** Where the version before a speed-up (or a restore) is kept, on this PC only. */
function backupPath(src, kind = 'speed-up') {
  const { ext, base } = nameParts(src);
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return path.join(BACKUP_DIR, `${base} (before ${kind} ${stamp})${ext}`);
}
scanBackups();

function fastCopyState() {
  const focus = ppt.focusPath();
  const known = focus ? slowText.get(focus) : null;
  const r = known?.result || null;
  const job = fastJob && {
    mode: fastJob.mode, path: fastJob.path, out: fastJob.out, state: fastJob.state, phase: fastJob.phase,
    done: fastJob.done, total: fastJob.total, slide: fastJob.slide, waitingForShow: !!fastJob.waitingForShow,
    result: fastJob.result || null, error: fastJob.error || null, backup: fastJob.backup || null,
  };
  const pres = (ppt.state.presentations || []).find((x) => x.path === focus);
  return {
    available: !!platform.features.fastCopy,
    slow: r && r.chars >= 50 ? {
      path: focus, ...r, out: path.basename(fastCopyPath(focus)),
      shared: !!pres?.cloud, autoSave: pres?.autoSave ?? null, backupDir: BACKUP_DIR,
    } : null,
    checked: !!known && (known.done === true || known.result != null), // the slow-text check has been made
    shared: !!pres?.cloud,
    backups: backupsFor(focus),
    restoring: restoring ? { file: restoring } : null,
    job,
  };
}

// Look at each presentation brought into view once (again when its file changes). Files on this
// PC are read from disk; files opened from OneDrive/SharePoint (a web address) through PowerPoint,
// once, when nothing else needs it.
if (platform.features.fastCopy) {
  loop(async () => {
    if (fastJob?.state === 'running') return;
    const left = (ppt.state.presentations || []).filter((x) => x.path.toLowerCase().startsWith(WORK_DIR.toLowerCase()));
    for (const x of left) await platform.helpers.thumbs.call('ppt.closeQuiet', { path: x.path }, { timeoutMs: 60000 }).catch(() => {});
  }, 15000);
  loop(async () => {
    const p = ppt.focusPath();
    if (!p || fastJob?.state === 'running') return;
    if (/^https?:/i.test(p)) {
      if (slowText.has(p) || ppt.state.show) return;
      slowText.set(p, { mtime: 0, result: null });
      const result = await platform.helpers.thumbs.call('ppt.slowTextLive', { path: p }, { timeoutMs: 300000 }).catch(() => null);
      if (result) slowText.set(p, { mtime: 0, result, done: true }); else slowText.delete(p);
      return;
    }
    let mtime;
    try { mtime = fs.statSync(p).mtimeMs; } catch { return; }
    const known = slowText.get(p);
    if (known?.mtime === mtime) return;
    if (known && (ppt.state.show || Date.now() - (known.at || 0) < 60000)) return;
    slowText.set(p, { mtime, result: known?.result ?? null, at: Date.now() });
    const result = await platform.helpers.capture.call('deck.slowText', { path: p }, { timeoutMs: 120000 }).catch(() => null);
    slowText.set(p, { mtime, result, at: Date.now(), done: true });
  }, 3000);
}

/** During a show PowerPoint belongs to the show: wait for it to end (or for Stop). */
async function waitForNoShow(job) {
  while (ppt.state.show && !job.cancel) {
    if (!job.waitingForShow) { job.waitingForShow = true; broadcast(); }
    await sleepMs(1000);
  }
  if (job.waitingForShow) { job.waitingForShow = false; broadcast(); }
  if (job.cancel) throw new Error('Cancelled');
}

async function runFastCopy(job) {
  const helper = platform.helpers.thumbs;
  const inplace = job.mode === 'inplace';
  const keep = inplace ? path.join(WORK_DIR, `pictures-${Date.now()}`) : null;
  ppt.pauseBackground = true;
  try {
    if (inplace) {
      // 1. The version as it is now, kept on this PC.
      job.phase = 'backup';
      broadcast();
      fs.mkdirSync(keep, { recursive: true });
      job.backup = backupPath(job.path);
      await helper.call('ppt.backupCopy', { path: job.path, out: job.backup }, { timeoutMs: 300000 });
      noteBackup(job.backup, job.path, 'speed-up');
      pruneBackups(new Set([path.basename(job.backup)]));
    }
    // 2. Pictures made (and three slides checked) on a copy.
    job.phase = 'pictures';
    broadcast();
    const begin = await helper.call('ppt.fastCopyBegin', { path: job.path, out: job.out }, { timeoutMs: 300000 });
    job.total = begin.slides.length;
    broadcast();
    const check = new Set([0, Math.floor(begin.slides.length / 2), begin.slides.length - 1]);
    const plan = [];
    for (let k = 0; k < begin.slides.length; k++) {
      await waitForNoShow(job);
      job.slide = begin.slides[k];
      const r = await helper.call('ppt.fastCopySlide', { out: job.out, slide: begin.slides[k], verify: check.has(k), keep }, { timeoutMs: 180000 });
      if (inplace) plan.push({ id: r.id, runs: r.runs || [] });
      job.done = k + 1;
      broadcast();
    }
    if (!inplace) {
      const end = await helper.call('ppt.fastCopyEnd', { out: job.out, keep: true, probe: begin.probe }, { timeoutMs: 300000 });
      // Open it with a window, for the operator, and put it in view here.
      await ppt.cmd('ppt.open', { path: job.out });
      ppt.focus = job.out;
      addRecent(job.out);
      job.result = { beforeMs: begin.beforeMs, afterMs: end.afterMs, slides: begin.slides.length, sizeMB: Math.round(end.size / 104857.6) / 10 };
    } else {
      await helper.call('ppt.fastCopyEnd', { out: job.out, keep: false }, { timeoutMs: 120000 });
      // 3. Into the file itself, then saved. Not during a show; can't be stopped half-way.
      await waitForNoShow(job);
      job.phase = 'applying';
      broadcast();
      const r = await helper.call('ppt.speedUpApply', { path: job.path, slides: plan, save: true }, { timeoutMs: 600000 });
      slowText.delete(job.path); // look again
      job.result = { slides: r.applied, skipped: r.skipped, saved: r.saved, backup: job.backup, beforeMs: begin.beforeMs };
    }
    job.state = 'done';
  } catch (e) {
    job.state = job.cancel ? 'cancelled' : 'failed';
    job.error = job.cancel ? null : e.message;
    await helper.call('ppt.fastCopyEnd', { out: job.out, keep: false }, { timeoutMs: 120000 }).catch(() => {});
  } finally {
    if (keep) fs.rm(keep, { recursive: true, force: true }, () => {});
    ppt.pauseBackground = false;
    await ppt.poll().catch(() => {});
    broadcast();
  }
}

app.post('/api/ppt/fastCopy', act((req) => {
  if (!platform.features.fastCopy) throw new Error('Not available on this computer');
  if (!isLoopback(req)) throw new Error('Start this on the Stagio PC: it changes files and keeps PowerPoint busy for minutes.');
  if (fastJob?.state === 'running') throw new Error('Already working on a presentation');
  if (ppt.state.show) throw new Error('Not during a slide show: PowerPoint would be busy for several minutes. Do it before the event.');
  const src = String(req.body?.path || ppt.focusPath() || '');
  if (!(ppt.state.presentations || []).some((p) => p.path === src)) throw new Error('That presentation is not open in PowerPoint');
  const mode = req.body?.mode === 'inplace' ? 'inplace' : 'copy';
  // For "inplace" the copy is only a workspace, in a temporary folder.
  const out = mode === 'copy' ? fastCopyPath(src) : (() => {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const { ext, base } = nameParts(src);
    return path.join(WORK_DIR, `${base} ${Date.now()}${ext}`);
  })();
  fastJob = { mode, path: src, out, state: 'running', phase: 'start', done: 0, total: 0, slide: null, startedAt: Date.now() };
  runFastCopy(fastJob); // runs on; progress arrives through the live state
  return { mode, out };
}));
app.post('/api/ppt/fastCopy/cancel', act(() => {
  if (fastJob?.state !== 'running') throw new Error('Nothing is running');
  if (fastJob.phase === 'applying') throw new Error('Almost done: the file is being changed and saved now');
  fastJob.cancel = true; // stops after the slide in progress; nothing is changed or left behind
}));
app.post('/api/ppt/fastCopy/dismiss', act(() => { if (fastJob && fastJob.state !== 'running') fastJob = null; }));

// Puts an earlier version (one of backupsFor(deck in view)) back in place of the presentation.
// The current version is copied to the backups first, so this can be undone the same way.
app.post('/api/ppt/restoreBackup', act(async (req) => {
  if (!platform.features.fastCopy) throw new Error('Not available on this computer');
  if (!isLoopback(req)) throw new Error('Do this on the Stagio PC: it replaces the file.');
  if (fastJob?.state === 'running' || restoring) throw new Error('Busy with another presentation. Try again when it is done.');
  if (ppt.state.show) throw new Error('Not during a slide show. End the show first.');
  const target = ppt.focusPath();
  const file = path.basename(String(req.body?.file || ''));
  if (!target || !backupsFor(target).some((b) => b.file === file)) throw new Error('That earlier version was not found');
  const helper = platform.helpers.thumbs;
  restoring = file;
  ppt.pauseBackground = true;
  broadcast();
  try {
    const safety = backupPath(target, 'restore');
    await helper.call('ppt.backupCopy', { path: target, out: safety }, { timeoutMs: 300000 });
    noteBackup(safety, target, 'restore');
    const full = await helper.call('ppt.restoreFile', { path: target, from: path.join(BACKUP_DIR, file) }, { timeoutMs: 300000 });
    slowText.delete(target);
    slowText.delete(full);
    if (fastJob && fastJob.state !== 'running') fastJob = null; // its "now fast" report no longer applies
    ppt.focus = full;
    addRecent(full);
    pruneBackups(new Set([file, path.basename(safety)]));
    return { path: full, safety: path.basename(safety) };
  } finally {
    restoring = null;
    ppt.pauseBackground = false;
  }
}, pptAfter));

// Thumbnails are rendered in the background (see lib/powerpoint.js); the console only asks for
// ones the live state marks as ready, so this never makes PowerPoint render on demand.
// s=1 is the small version for the slide strip. The address changes with the slide's content,
// so the image itself can be cached for good.
app.get('/api/ppt/thumb', (req, res) => {
  const file = ppt.thumb(String(req.query.path), req.query.id, req.query.v || '', req.query.s === '1');
  if (!file) return res.status(404).end();
  res.setHeader('Cache-Control', 'max-age=604800, immutable');
  res.sendFile(file);
});

// Latest screen capture of the show window (the program view).
app.get('/api/program', (req, res) => {
  if (!program.file) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-store');
  res.type('image/jpeg').sendFile(program.file);
});

// ---------------- features ----------------

app.post('/api/settings', act((req) => {
  for (const k of ['hidePresenterView', 'autoCues', 'cueShift', 'stageCanFlip']) {
    if (typeof req.body?.[k] === 'boolean') cfg[k] = req.body[k];
  }
  saveCfg();
}));

// The operator restarts the segment timer (e.g. when the sermon begins).
app.post('/api/timer/segment', act(() => startSegment('')));

app.post('/api/features', act(async (req) => {
  // 'local' = music on (the Premium mode of earlier versions is gone: 'spotify' means on)
  if (['local', 'spotify', 'off'].includes(req.body.music)) {
    music()?.cancelFade();
    cfg.features.music = req.body.music === 'off' ? 'off' : 'local';
    saveCfg();
    if (cfg.features.music === 'local') await localMusic.poll();
  }
}));

// ---------------- music: whichever app plays it ----------------

const requireMusic = () => {
  const m = music();
  if (!m) throw new Error('Music control is off');
  return m;
};
const musicAfter = () => new Promise((r) => setTimeout(r, 300)).then(() => music()?.poll());

app.post('/api/music/toggle', act(() => requireMusic().togglePlay(), musicAfter));
app.post('/api/music/next', act(() => requireMusic().next(), musicAfter));
app.post('/api/music/previous', act(() => requireMusic().previous(), musicAfter));
app.post('/api/music/volume', act((req) => requireMusic().setVolume(req.body.volume), musicAfter));
// Fades return immediately; progress shows up through live state.
app.post('/api/music/fadeOut', act((req) => { requireMusic().fadeOut(Number(req.body.seconds) || 3).catch(() => {}); }));
app.post('/api/music/fadeIn', act((req) => { requireMusic().fadeIn(Number(req.body.seconds) || 3, req.body.volume).catch(() => {}); }));
app.post('/api/music/fadeTo', act((req) => {
  const to = Number(req.body.to);
  if (!Number.isFinite(to) || to < 0 || to > 100) throw new Error('Enter the level to fade to (0-100)');
  const from = req.body.from === '' || req.body.from === undefined || req.body.from === null ? null : Number(req.body.from);
  if (from !== null && (!Number.isFinite(from) || from < 0 || from > 100)) throw new Error('"From" must be a level from 0 to 100, or empty');
  requireMusic().fadeTo(to, Number(req.body.seconds) || 3, from).catch(() => {});
}));
app.post('/api/music/launch', act(() => localMusic.launch(), musicAfter));
app.post('/api/music/seek', act((req) => requireMusic().seek(req.body.ms), musicAfter));
// Which app to follow: '' = whatever plays (the one followed so far stays while it plays).
app.post('/api/music/source', act(async (req) => {
  const id = String(req.body?.id ?? '').slice(0, 300);
  music()?.cancelFade();
  cfg.music.source = id;
  saveCfg();
  await localMusic.poll();
}));
app.get('/api/music/art', (req, res) => {
  const file = localMusic.artFile();
  if (!file) return res.status(404).end();
  res.setHeader('Cache-Control', 'max-age=3600');
  res.type('image/png').sendFile(file); // browsers sniff JPEG vs PNG
});

// ---------------- outputs ----------------

app.post('/api/audio/device', act((req) => output.setDevice(req.body.id), () => output.pollAudio()));
app.post('/api/audio/volume', act((req) => output.setVolume(req.body.value), () => output.pollAudio()));
app.post('/api/audio/mute', act((req) => output.setMute(req.body.mute), () => output.pollAudio()));
app.post('/api/display/mode', act((req) => output.setDisplayMode(req.body.mode)));

// ---------------- cues ----------------

app.get('/api/cues/types', (req, res) => res.json(STEP_TYPES));
app.put('/api/cues', act((req) => {
  if (!Array.isArray(req.body)) throw new Error('Invalid cue list');
  cfg.cues = req.body.map((c, i) => {
    const cue = {
      id: String(c.id || `cue${Date.now()}${i}`),
      name: String(c.name || `Cue ${i + 1}`),
      color: c.color || 'blue',
      steps: (c.steps || []).filter((s) => STEP_TYPES[s.type]),
    };
    // Runs by itself at this slide (followed by its ID) of this presentation (by file name).
    const id = Math.floor(Number(c.auto?.slideId));
    if (id > 0) cue.auto = { deck: String(c.auto.deck || '').split(/[\\/]/).pop(), slideId: id, slide: Math.floor(Number(c.auto.slide)) || 0 };
    return cue;
  });
  saveCfg();
}));
app.post('/api/cues/:id/run', act(async (req) => {
  const cue = cfg.cues.find((c) => c.id === req.params.id);
  if (!cue) throw new Error('Cue not found');
  autoCues.noteRun(cue.id);
  startSegment(cue.name);
  broadcast();
  const errors = await cues.run(cue);
  if (errors.length) throw new Error(errors.join('\n'));
}, pptAfter));

// ---------------- stage display (Extra) ----------------
// A view-only screen for the speaker or host (public/stage.html): the slide on the projector and
// the next one, the notes, the time left, and messages from the console ("5 minutes left"). It
// has its own key and PIN (see STAGE_PATHS); changing slides from it only when the console allows.

const stageClients = new Set();
let stageMsg = null;   // { id, text, at, ackAt }: the message on the stage displays
let stageLast = '';
let stageSentAt = 0;

/** What a stage display shows (small: no slide list, no settings, no keys). */
function stageView(parts) {
  const show = ppt.state.show || null;
  const sl = parts.slides;
  const list = sl?.slides || [];
  let cur = null;
  let next = null;
  if (show && sl && sl.path === show.path) {
    const i = list.findIndex((x) => x.id === show.slideId);
    if (i >= 0) { cur = list[i]; next = list.slice(i + 1).find((x) => !x.hidden) || null; }
  }
  const pic = (x) => (x ? { id: x.id, v: x.thumb ? x.v : '', index: x.index, title: x.title || '' } : null);
  const r = runOfShow?.run || null;
  const part = runOfShow?.current || null;
  const active = parts.run?.active || null;
  const runShow = r ? runOfShow.show(r.showId) : null;
  return {
    edition: edition.name,
    show: show ? { name: show.name, path: show.path, slide: show.slide, total: show.total, state: show.state, clicks: show.clicks || 0, click: show.click || 0 } : null,
    current: pic(cur),
    next: pic(next),
    notes: show?.notes || '',
    timer: { showAt: timer.showAt, segAt: timer.segAt, segBy: timer.segBy },
    run: r && part && active ? {
      part: part.name, index: r.index, count: runShow?.parts.length || 0,
      planned: active.planned[r.index] || 0, segAt: active.segAt, startedAt: active.startedAt,
      plannedBefore: active.plannedBefore, countdown: active.countdown?.target || null,
      next: runShow?.parts[r.index + 1]?.name || null,
    } : null,
    message: stageMsg ? { id: stageMsg.id, text: stageMsg.text, at: stageMsg.at, acked: !!stageMsg.ackAt } : null,
    canFlip: !!cfg.stageCanFlip,
  };
}
function stageBroadcast(parts) {
  if (!ed.stage || !stageClients.size) return;
  const json = JSON.stringify(stageView(parts));
  if (json === stageLast) return;
  stageLast = json;
  const payload = JSON.stringify({ ...JSON.parse(json), now: Date.now() });
  for (const res of stageClients) send(res, payload);
  stageSentAt = Date.now();
}

app.get('/api/stage/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.write('retry: 2000' + String.fromCharCode(10, 10));
  send(res, JSON.stringify({ ...stageView(buildParts()), now: Date.now() }));
  stageClients.add(res);
  stageLast = '';
  broadcast(); // the console's count of stage displays
  req.on('close', () => { stageClients.delete(res); broadcast(); });
});
const consoleOnly = (req) => { if (req.stage) throw new Error('Only the Stagio console can do this'); };
const oneLine = (v, max) => String(v || '').split(/\s+/).join(' ').trim().slice(0, max);
app.post('/api/stage/message', act((req) => {
  consoleOnly(req);
  const text = oneLine(req.body?.text, 140);
  if (!text) throw new Error('Type the message first');
  stageMsg = { id: Date.now(), text, at: Date.now(), ackAt: null };
  return stageMsg.id;
}));
app.post('/api/stage/clear', act((req) => { consoleOnly(req); stageMsg = null; }));
app.post('/api/stage/ack', act((req) => {
  if (stageMsg && Number(req.body?.id) === stageMsg.id && !stageMsg.ackAt) stageMsg.ackAt = Date.now();
}));
app.put('/api/stage/presets', act((req) => {
  consoleOnly(req);
  if (!Array.isArray(req.body)) throw new Error('Invalid list');
  cfg.stagePresets = req.body.map((x) => oneLine(x, 80)).filter(Boolean).slice(0, 12);
  saveCfg();
}));
const stageFlip = (cmd) => act((req) => {
  if (req.stage && !cfg.stageCanFlip) throw new Error('Changing slides from the stage display is switched off on the console');
  if (!ppt.state.show) throw new Error('The slide show is not running');
  return ppt.cmd(cmd);
}, () => { ppt.poll().then(() => broadcast()); return Promise.resolve(); });
app.post('/api/stage/next', stageFlip('ppt.next'));
app.post('/api/stage/prev', stageFlip('ppt.prev'));

// ---------------- run of show (Extra) ----------------
// Answers as soon as the part has started; a part that fails (file missing…) says why.

app.put('/api/run/shows', act((req) => runOfShow.setShows(req.body)));
app.post('/api/run/start', act((req) => runOfShow.start(String(req.body?.showId || ''), Math.max(0, Math.floor(Number(req.body?.index) || 0))), pptAfter));
app.post('/api/run/next', act(() => runOfShow.next(), pptAfter));
app.post('/api/run/prev', act(() => runOfShow.prev(), pptAfter));
app.post('/api/run/go', act((req) => runOfShow.go(Math.floor(Number(req.body?.index))), pptAfter));
app.post('/api/run/stop', act(() => runOfShow.stop()));
// The countdown window on the projector asks this every second.
app.get('/api/run/countdown', (req, res) => res.json({ ok: true, data: runOfShow.countdownInfo() }));

// ---------------- start ----------------

app.use((err, req, res, next) => {
  console.error('[request]', req.method, req.path, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Something went wrong on the Stagio PC' });
});

ppt.onChange = () => broadcast();
ppt.startWatcher();
program.onChange = () => broadcast();
program.start();
// The show state is read often while a show runs (a clicker may change slides behind our back)
// and less often otherwise.
loop(() => ppt.poll(), () => (ppt.state.show ? 400 : 1000));
loop(async () => {
  if (!ed.music || cfg.features.music !== 'local') return;
  await localMusic.poll();
  // Remember the app last followed, so "Open" can start it before the next event.
  const app = localMusic.state?.app;
  if (app?.id && localMusic.state?.session) {
    const last = cfg.music.lastApp;
    const p = app.path || (last?.id === app.id ? last.path : '') || '';
    if (!last || last.id !== app.id || last.path !== p || last.name !== app.name) {
      cfg.music.lastApp = { id: app.id, name: app.name, path: p };
      saveCfg();
    }
  }
}, 1000);
loop(() => (ed.audio ? output.pollAudio() : null), 3000);
loop(() => {
  for (const r of cfg.recent) {
    if (!isFilePath(r.path) || /^https?:/i.test(r.path)) continue;
    if (fs.existsSync(r.path)) recentGone.delete(r.path); else recentGone.add(r.path);
  }
  if (!restoring && fastJob?.state !== 'running') scanBackups(); // copies deleted or added by hand
}, 5000);
loop(() => output.pollDisplays(), 5000);
if (runOfShow) {
  loop(() => runOfShow.tick(), 500);           // the countdown's fade and going on at zero
  loop(() => runOfShow.checkFiles(), 5000);    // the run's files still there?
}
// Slide images taken from the projector itself, once a slide has been shown (see ppt.captureTarget).
if (program.captureSlide && ppt.captureTarget) {
  loop(async () => {
    const target = ppt.captureTarget();
    if (target && (await program.captureSlide(target)) === 'ok') ppt.captured(target);
  }, 700);
}
// Is someone working in PowerPoint right now? Background work then waits (see userInPowerPoint).
if (platform.helpers?.capture && 'activity' in ppt) {
  loop(async () => {
    try { ppt.activity = { ...(await platform.helpers.capture.call('sys.activity', {}, { timeoutMs: 3000 })), at: Date.now() }; } catch { /* keep the last reading; it expires */ }
  }, 2000);
}

const url = `http://127.0.0.1:${cfg.port}/`;
// Resolves once the console is reachable; the desktop app (electron/main.js) waits for it.
// If another Stagio is already using the port, it rejects so the app can show that instead.
const ready = new Promise((resolve, reject) => {
  const server = app.listen(cfg.port, '0.0.0.0', () => {
    console.log(`Stagio running at ${url}`);
    const [lan] = lanAddresses();
    if (lan) console.log(`Remote (same Wi-Fi): http://${lan}:${cfg.port}/  PIN ${cfg.pin}`);
    if (process.argv.includes('--open') && process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', 'msedge', `--app=${url}`, '--window-size=1440,900'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    resolve(url);
  });
  server.on('error', reject);
});
ready.catch((e) => console.error(`Could not start on port ${cfg.port}: ${e.message}`));

// During a live event the console must keep running: log unexpected errors instead of exiting.
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

const stop = () => platform.stop();
/** For the desktop app: is anything depending on Stagio right now? */
const status = () => ({
  live: !!ppt.state.show,
  remotes: [...clients].filter((c) => c.remote).length,
  job: fastJob?.state === 'running'
    ? { mode: fastJob.mode, file: String(fastJob.path).split(/[\\/]/).pop(), done: fastJob.done, total: fastJob.total, applying: fastJob.phase === 'applying' }
    : restoring ? { mode: 'restore', file: nameParts(ppt.focusPath() || '').base, applying: true } : null,
});
if (require.main === module) {
  const shutdown = () => { stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** The desktop app hands over its countdown window (show/hide on the projector). */
const setScreenHost = (host) => runOfShow?.setScreen(host);

module.exports = { ready, stop, status, url, edition, setScreenHost };
