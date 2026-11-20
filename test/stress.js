// Stagio stress test. Needs the server running (npm run dev) and a deck to load.
// Usage: node test/stress.js <deck.pptx> [test letters, e.g. ABCD] [soakSeconds]
const { spawn, execSync } = require('child_process');

const BASE = 'http://127.0.0.1:7300';
const DECK = process.argv[2];
const ONLY = (process.argv[3] || 'ABCNMDEFGHIJLK').toUpperCase();
const SOAK_S = Number(process.argv[4] || 180);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function post(path, body = {}) {
  const t = performance.now();
  try {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    return { ms: performance.now() - t, ...j };
  } catch (e) {
    return { ms: performance.now() - t, ok: false, error: e.message };
  }
}
const state = () => fetch(BASE + '/api/state').then((r) => r.json());
const debug = () => fetch(BASE + '/api/debug').then((r) => r.json());
const slide = async () => (await state()).ppt.show?.slide;
// Slide commands answer as soon as PowerPoint has acted; the state refresh follows a moment
// later, so checks wait (briefly) for the state to settle on the expected value.
async function settleSlide(expected, timeoutMs = 4000) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeoutMs) { s = await slide(); if (s === expected) return s; await sleep(100); }
  return s;
}
async function settleState(expected, timeoutMs = 4000) {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeoutMs) { st = (await state()).ppt.show?.state; if (st === expected) return st; await sleep(100); }
  return st;
}

function stats(ms) {
  const a = [...ms].sort((x, y) => x - y);
  const q = (p) => Math.round(a[Math.min(a.length - 1, Math.floor(p * a.length))]);
  return { n: a.length, p50: q(0.5), p95: q(0.95), max: Math.round(a.at(-1) || 0) };
}

async function waitFor(pred, timeoutMs, everyMs = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await state();
    if (pred(s)) return Date.now() - t0;
    await sleep(everyMs);
  }
  return null;
}

function report(name, pass, data) {
  results.push({ name, pass });
  console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${name}`);
  console.log('      ' + JSON.stringify(data));
}

function memOf(pid) {
  if (!pid) return null;
  try {
    const line = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' }).trim();
    const m = line.match(/"([\d,.\s]+) K"$/);
    return m ? Math.round(Number(m[1].replace(/[^\d]/g, '')) / 1024) : null;
  } catch { return null; }
}
async function memory() {
  const d = await debug();
  return {
    serverMB: d.memoryMB,
    controlMB: memOf(d.helpers.control.pid),
    thumbsMB: memOf(d.helpers.thumbs.pid),
    musicMB: memOf(d.helpers.music.pid),
  };
}

// ---------------------------------------------------------------- setup

async function setup() {
  const open = await post('/api/ppt/open', { path: DECK });
  if (!open.ok) throw new Error('open failed: ' + open.error);
  await post('/api/ppt/focus', { path: open.data });
  const s0 = await state();
  if (s0.ppt.show) await post('/api/ppt/end');
  await post('/api/ppt/start', { path: open.data, slide: 1 });
  const t = await waitFor((s) => s.ppt.slides?.slides?.length === 100 && s.ppt.show?.slide === 1, 60000);
  const d = await debug();
  console.log(`setup: show running, 100 slides scanned after ${t} ms, one scan takes ${d.scanMs} ms`);
  return open.data;
}

// ---------------------------------------------------------------- tests

const tests = {
  // Operator presses "next" 30 times, one after another.
  async A() {
    await post('/api/ppt/goto', { slide: 1 });
    const ms = [];
    let errors = 0;
    for (let i = 0; i < 30; i++) { const r = await post('/api/ppt/next'); ms.push(r.ms); if (!r.ok) errors++; }
    const s = await settleSlide(31);
    report('A 连续翻页 30 次', s === 31 && errors === 0, { latency: stats(ms), finalSlide: s, expected: 31, errors });
  },

  // Phone and PC press at once: 20 "next" requests fired simultaneously.
  async B() {
    await post('/api/ppt/goto', { slide: 31 });
    const t = performance.now();
    const rs = await Promise.all(Array.from({ length: 20 }, () => post('/api/ppt/next')));
    const total = Math.round(performance.now() - t);
    const s = await settleSlide(51);
    const errors = rs.filter((r) => !r.ok).length;
    report('B 20 个翻页请求同时到达', s === 51 && errors === 0, { totalMs: total, latency: stats(rs.map((r) => r.ms)), finalSlide: s, expected: 51, errors });
  },

  // Thumbnails are rendered in the background only while the operator pauses: flip 15 times,
  // then the slides around the projector must get their thumbnails shortly after.
  async C() {
    await post('/api/ppt/refreshThumbs');
    await post('/api/ppt/goto', { slide: 51 });
    const ms = [];
    for (let i = 0; i < 15; i++) { ms.push((await post('/api/ppt/next')).ms); await sleep(250); }
    const s = await slide();
    const near = [66, 67, 68, 69];
    const readyMs = await waitFor((st) => near.every((n) => st.ppt.slides.slides.find((x) => x.index === n)?.thumb), 40000);
    report('C 翻页后投影附近的缩略图自动生成', s === 66 && readyMs !== null, { nextLatency: stats(ms), finalSlide: s, nearThumbsReadyMsAfterLastFlip: readyMs });
  },
  // Thumbnails are JPEGs in two sizes: a small one for the slide strip, a large one for the monitors.
  async N() {
    const s = await state();
    const x = s.ppt.slides.slides.find((y) => y.thumb);
    if (!x) return report('N 缩略图为两种尺寸的 JPEG', false, { reason: 'no thumbnail ready' });
    const q = `path=${encodeURIComponent(s.ppt.focus)}&id=${x.id}&v=${x.v}`;
    const [big, small] = await Promise.all([fetch(`${BASE}/api/ppt/thumb?${q}`), fetch(`${BASE}/api/ppt/thumb?${q}&s=1`)]);
    const [b, sm] = [Buffer.from(await big.arrayBuffer()), Buffer.from(await small.arrayBuffer())];
    const isJpeg = (buf) => buf[0] === 0xff && buf[1] === 0xd8;
    report('N 缩略图为两种尺寸的 JPEG', big.ok && small.ok && isJpeg(b) && isJpeg(sm) && sm.length < b.length, {
      slide: x.index, largeKB: +(b.length / 1024).toFixed(1), smallKB: +(sm.length / 1024).toFixed(1), cache: big.headers.get('cache-control'),
    });
  },

  // A console that only receives patches must end up with the same state as the server.
  async M() {
    const ctrl = new AbortController();
    const res = await fetch(BASE + '/api/events', { signal: ctrl.signal });
    let live = null; let buf = ''; let patches = 0; let bytes = 0;
    (async () => {
      try {
        for await (const chunk of res.body) {
          bytes += chunk.length;
          buf += Buffer.from(chunk).toString();
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
            buf = buf.slice(i + 2);
            if (!line) continue;
            const p = JSON.parse(line.slice(6));
            if (p._full) { live = p; delete live._full; } else if (live) { Object.assign(live, p); if (Object.keys(p).length) patches++; }
          }
        }
      } catch { /* aborted */ }
    })();
    await sleep(600);
    const snapshotBytes = bytes;
    await post('/api/ppt/goto', { slide: 40 });
    for (let i = 0; i < 10; i++) { await post('/api/ppt/next'); await sleep(300); }
    await post('/api/ppt/state', { state: 'black' });
    await post('/api/ppt/state', { state: 'running' });
    await settleSlide(50);
    await sleep(1200);
    const now = await state();
    ctrl.abort();
    const ids = (list) => JSON.stringify(list.map((s) => s.id));
    const same = !!live && live.ppt.show.slide === now.ppt.show.slide && live.ppt.show.state === now.ppt.show.state
      && ids(live.slides.slides) === ids(now.ppt.slides.slides);
    report('M 只收增量的遥控端，状态与服务器一致', same && now.ppt.show.slide === 50, {
      consoleSlide: live?.ppt.show.slide, serverSlide: now.ppt.show.slide, patches,
      snapshotKB: +(snapshotBytes / 1024).toFixed(1), bytesPerPatch: patches ? Math.round((bytes - snapshotBytes) / patches) : null,
    });
  },

  // 30 random jumps (clicking thumbnails).
  async D() {
    const ms = [];
    let wrong = 0;
    for (let i = 0; i < 30; i++) {
      const target = 1 + Math.floor(Math.random() * 100);
      const r = await post('/api/ppt/goto', { slide: target });
      ms.push(r.ms);
      if ((await slide()) !== target) wrong++;
    }
    report('D 随机跳页 30 次', wrong === 0, { latency: stats(ms), wrongSlide: wrong });
  },

  // Black/white toggled 20 times fast; must end in a predictable state.
  async E() {
    await post('/api/ppt/state', { state: 'running' });
    const ms = [];
    for (let i = 0; i < 10; i++) {
      ms.push((await post('/api/ppt/state', { state: 'black' })).ms);
      ms.push((await post('/api/ppt/state', { state: 'white' })).ms);
    }
    const st = await settleState('white');
    await post('/api/ppt/state', { state: 'running' });
    const back = await settleState('running');
    report('E 黑屏/白屏快速切换 20 次', st === 'white' && back === 'running', { latency: stats(ms), endState: st, afterRestore: back });
  },

  // Someone edits the projected slide and the next three while the show runs; once the operator
  // pauses, every edit must reach the console. (Slides further away are re-checked in a slow
  // rotation during a show to keep PowerPoint free for the show.)
  async F() {
    await post('/api/ppt/goto', { slide: 20 });
    await sleep(1000);
    const targets = [20, 21, 22, 23];
    // Edits are recognised against a baseline; wait until the slides have one.
    const baselineMs = await waitFor((s) => targets.every((n) => s.ppt.slides.slides.find((x) => x.index === n)?.v), 40000);
    const before = new Map((await state()).ppt.slides.slides.map((s) => [s.index, s.v]));
    const script = `
      $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
      $p = $app.SlideShowWindows.Item(1).Presentation
      foreach ($n in @(${targets.join(',')})) {
        $t = $p.Slides.Item($n).Shapes.Item(1).TextFrame.TextRange
        $t.Text = $t.Text + ' *'
        Start-Sleep -Milliseconds 300
      }`;
    const editor = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
    await new Promise((r) => editor.on('exit', r));
    const detectMs = await waitFor((s) => targets.every((n) => {
      const x = s.ppt.slides.slides.find((y) => y.index === n);
      return x && x.v && x.v !== before.get(n) && x.changed;
    }), 30000);
    const s = await state();
    const missed = targets.filter((n) => s.ppt.slides.slides.find((y) => y.index === n)?.v === before.get(n));
    report('F 放映中有人改投影附近 ' + targets.length + ' 页', baselineMs !== null && detectMs !== null && missed.length === 0, { baselineReadyMs: baselineMs, allDetectedMsAfterLastEdit: detectMs, missed });
  },
  // Music fades while flipping slides: slide control must stay fast.
  async G() {
    const m0 = (await state()).localMusic;
    if (!m0?.session) return report('G 音乐淡出时翻页', false, { skipped: 'Spotify 没有在播放' });
    if (!m0.isPlaying) { await post('/api/music/toggle'); await sleep(1000); }
    await post('/api/music/volume', { volume: 100 });
    await post('/api/ppt/goto', { slide: 10 });
    await post('/api/music/fadeOut', { seconds: 4 });
    const ms = [];
    for (let i = 0; i < 10; i++) { ms.push((await post('/api/ppt/next')).ms); await sleep(300); }
    await waitFor((s) => !s.localMusic.fading, 8000);
    await sleep(1500);
    const afterOut = (await state()).localMusic;
    await post('/api/music/fadeIn', { seconds: 3 });
    await waitFor((s) => !s.localMusic.fading, 8000);
    await sleep(1500);
    const afterIn = (await state()).localMusic;
    const s = await slide();
    report('G 音乐淡出时翻页', s === 20 && !afterOut.isPlaying && afterIn.isPlaying && afterIn.volume === 100, {
      nextLatency: stats(ms), finalSlide: s, afterFadeOut: { playing: afterOut.isPlaying, volume: afterOut.volume },
      afterFadeIn: { playing: afterIn.isPlaying, volume: afterIn.volume },
    });
  },

  // Fade buttons mashed: must never end stuck silent or half-way.
  async H() {
    const m0 = (await state()).localMusic;
    if (!m0?.session) return report('H 狂按淡入/淡出', false, { skipped: 'Spotify 没有在播放' });
    await post('/api/music/volume', { volume: 100 });
    for (let i = 0; i < 12; i++) {
      await post(i % 2 ? '/api/music/fadeIn' : '/api/music/fadeOut', { seconds: 2 });
      await sleep(250);
    }
    await waitFor((s) => !s.localMusic.fading, 8000);
    await sleep(1500);
    const m = (await state()).localMusic;
    report('H 狂按淡入/淡出 12 次（最后一下是淡入）', m.isPlaying && m.volume === 100 && !m.fading, { playing: m.isPlaying, volume: m.volume, fading: m.fading });
    await post('/api/music/volume', { volume: 100 });
  },

  // 30 consoles (phones/tablets) connected at once.
  async I() {
    const N = 30;
    const ctrl = new AbortController();
    const counts = Array(N).fill(0);
    const bytes = Array(N).fill(0);
    await Promise.all(Array.from({ length: N }, async (_, i) => {
      const r = await fetch(BASE + '/api/events', { signal: ctrl.signal });
      (async () => {
        try {
          for await (const chunk of r.body) { bytes[i] += chunk.length; counts[i] += (Buffer.from(chunk).toString().match(/^data:/gm) || []).length; }
        } catch { /* aborted */ }
      })();
    }));
    const d = await debug();
    const ms = [];
    for (let i = 0; i < 10; i++) { ms.push((await post('/api/ppt/next')).ms); await sleep(1000); }
    ctrl.abort();
    await sleep(500);
    const min = Math.min(...counts);
    report(`I ${N} 个遥控端同时连线 10 秒`, d.clients >= N && min >= 10, {
      connected: d.clients, updatesPerClientMin: min, updatesPerClientMax: Math.max(...counts),
      kBperClientPerSec: Math.round(bytes[0] / 1024 / 10), stateKB: Math.round(d.stateBytes / 1024), nextLatency: stats(ms),
    });
  },

  // Background processes crash mid-show; everything must come back on its own.
  async J() {
    const musicWasUp = !!(await state()).localMusic?.session;
    const before = await debug();
    const pids = Object.values(before.helpers).map((h) => h.pid).filter(Boolean);
    const slideBefore = await slide();
    for (const pid of pids) { try { process.kill(pid); } catch { /* gone */ } }
    const t0 = Date.now();
    let recoveredMs = null;
    while (Date.now() - t0 < 30000) {
      const r = await post('/api/ppt/next');
      if (r.ok) { recoveredMs = Date.now() - t0; break; }
      await sleep(200);
    }
    const musicBack = musicWasUp ? await waitFor((s) => s.localMusic?.session, 20000) : 'skipped (Spotify not playing)';
    const after = await debug();
    const s = await settleSlide(slideBefore + 1);
    report('J 所有后台进程全部被杀掉', recoveredMs !== null && s === slideBefore + 1 && musicBack !== null, {
      killed: pids.length, slideControlBackAfterMs: recoveredMs, musicBackAfterMs: musicBack, slideBefore, slideAfter: s,
      restarts: Object.fromEntries(Object.entries(after.helpers).map(([k, v]) => [k, v.restarts])),
    });
  },

  // Operator keeps pressing "next" at the end: the show must not exit to the desktop.
  async L() {
    await post('/api/ppt/goto', { slide: 100 });
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await post('/api/ppt/next'));
    const s = await state();
    const back = await post('/api/ppt/prev');
    const s2 = await settleSlide(100);
    report('L 最后一页后再按 5 次下一页', !!s.ppt.show && rs.every((r) => r.ok) && s2 === 100, {
      showStillRunning: !!s.ppt.show, showState: s.ppt.show?.state, prevGoesBackTo: s2, backOk: back.ok,
    });
  },

  // Long run of random operator actions; watch errors and memory.
  async K() {
    const memStart = await memory();
    const ops = [
      () => post('/api/ppt/next'), () => post('/api/ppt/next'), () => post('/api/ppt/prev'),
      () => post('/api/ppt/goto', { slide: 1 + Math.floor(Math.random() * 100) }),
      () => post('/api/ppt/state', { state: 'black' }), () => post('/api/ppt/state', { state: 'running' }),
      () => state().then(() => ({ ok: true, ms: 0 })),
      () => post('/api/music/volume', { volume: 90 + Math.floor(Math.random() * 11) }),
    ];
    if (!(await state()).localMusic?.session) ops.pop(); // no music to control
    const ms = [];
    const errors = {};
    let count = 0;
    const samples = [];
    const t0 = Date.now();
    let lastSample = t0;
    while (Date.now() - t0 < SOAK_S * 1000) {
      const r = await ops[Math.floor(Math.random() * ops.length)]();
      count++;
      if (r.ms) ms.push(r.ms);
      if (!r.ok) errors[r.error] = (errors[r.error] || 0) + 1;
      if (Date.now() - lastSample > 30000) { lastSample = Date.now(); samples.push(await memory()); }
      await sleep(150 + Math.random() * 150);
    }
    await post('/api/ppt/state', { state: 'running' });
    await post('/api/music/volume', { volume: 100 });
    const memEnd = await memory();
    const errorCount = Object.values(errors).reduce((a, b) => a + b, 0);
    report(`K 连续随机操作 ${SOAK_S} 秒`, errorCount === 0, { operations: count, latency: stats(ms), errors, memStart, memEnd, samples });
  },
};

(async () => {
  if (!DECK) { console.error('usage: node test/stress.js <deck.pptx> [tests] [soakSeconds]'); process.exit(2); }
  await setup();
  for (const k of ONLY) {
    if (!tests[k]) continue;
    try { await tests[k](); } catch (e) { report(k, false, { exception: e.stack }); }
  }
  await post('/api/ppt/end');
  await post('/api/music/volume', { volume: 100 });
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
