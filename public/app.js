// Stagio console UI. Live state arrives over Server-Sent Events; actions are POSTs.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const isPC = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);

// ---------------- remote sign-in ----------------
// Phones get the access key from the QR code (?key=...) or by entering the PIN. It is kept in
// this browser and sent with every request, so it works even where cookies are blocked.
const store = {
  get() { try { return localStorage.getItem('onedesk.key'); } catch { return null; } },
  set(v) { try { localStorage.setItem('onedesk.key', v); } catch { /* private mode: the cookie still works */ } },
  clear() { try { localStorage.removeItem('onedesk.key'); } catch { /* ignore */ } },
};
(() => {
  const k = new URLSearchParams(location.search).get('key');
  if (k) { store.set(k); history.replaceState(null, '', location.pathname); }
})();
let KEY = isPC ? null : (new URLSearchParams(location.search).get('key') || store.get());
/** Adds the access key to URLs the browser loads by itself (images, live stream). */
const authUrl = (u) => (KEY && u && u.startsWith('/') ? `${u}${u.includes('?') ? '&' : '?'}key=${encodeURIComponent(KEY)}` : u);
const authHeaders = () => (KEY ? { 'X-Stagio-Key': KEY } : {});

let S = null;          // latest server state
let stepTypes = {};

const ICON = {
  prev: '<svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM14 2v12L6 8z"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM2 2v12l8-6z"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M4 2v12l10-6z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>',
  shuffle: '<svg viewBox="0 0 16 16"><path d="M11 2l3 2.5L11 7V5H9.6L5.9 11H2V9.5h3.1l3.7-6H11zM2 4.5h3.1l1.2 2-.9 1.4L4.3 6H2zm7.6 5L8.7 8.1l.9-1.4.8 1.3H11V6l3 2.5-3 2.5V9.5z"/></svg>',
  repeat: '<svg viewBox="0 0 16 16"><path d="M3 5h8V3l3 3-3 3V7H4v3H2V6a1 1 0 0 1 1-1zm10 6H5v2l-3-3 3-3v2h7V6h2v4a1 1 0 0 1-1 1z"/></svg>',
};

// ---------------- helpers ----------------

let toastTimer;
function toast(msg, kind = 'error') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind === 'info' ? 'info' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'info' ? 2500 : 5000);
}

/** fetch with a time limit, so a request into a dead connection doesn't hang for minutes. */
function fetchT(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

const SLOW = 70000;      // opening a file or starting a show may have to launch PowerPoint first
const VERY_SLOW = 300000; // a cue may contain waits

async function api(path, body, method, timeoutMs) {
  const hasBody = body !== undefined;
  let res;
  try {
    res = await fetchT(path, {
      method: method || (hasBody ? 'POST' : 'GET'),
      headers: { ...authHeaders(), ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
      body: hasBody ? JSON.stringify(body) : undefined,
    }, timeoutMs);
  } catch (e) {
    // The command did not get through: say so, instead of leaving the operator guessing.
    const msg = e.name === 'AbortError' ? 'Stagio did not answer in time' : 'No connection to the Stagio PC';
    toast(msg);
    reconnect();
    throw new Error(msg);
  }
  let j;
  try { j = await res.json(); } catch { j = { ok: false, error: `${res.status} ${res.statusText}` }; }
  if (j.login) { showLogin(); throw new Error(j.error); }
  if (!j.ok) { toast(j.error || 'Action failed'); throw new Error(j.error); }
  return j.data;
}
const post = (p, b = {}, timeoutMs) => api(p, b, undefined, timeoutMs).catch(() => null);

/** Slider that the server state won't fight with while the user is dragging it. */
function bindSlider(input, out, onCommit) {
  input.addEventListener('pointerdown', () => { input.dataset.busy = '1'; });
  input.addEventListener('input', () => { out.textContent = input.value; input.dataset.busy = '1'; });
  input.addEventListener('change', async () => {
    await onCommit(Number(input.value));
    setTimeout(() => { delete input.dataset.busy; }, 1500);
  });
}
function syncSlider(input, out, value) {
  if (input.dataset.busy) return;
  if (value === null || value === undefined) { input.disabled = true; out.textContent = '–'; return; }
  input.disabled = false;
  input.value = value;
  out.textContent = value;
}

/** Header status readout: square indicator + short text. */
function setSt(id, cls, text) {
  const el = $(id);
  for (const c of ['ok', 'live', 'warn', 'bad']) el.classList.toggle(c, c === cls); // keeps needs-*
  $('em', el).textContent = text;
}

/**
 * Two-step button for actions that hurt when hit by accident (ending the show, switching the
 * display mode mid-show). The first press arms it for 3 s; returns true on the second press.
 */
const armed = new WeakMap();
function confirmTap(btn, label) {
  const a = armed.get(btn);
  const disarm = (html) => { btn.innerHTML = html; btn.classList.remove('armed'); armed.delete(btn); };
  if (a) { clearTimeout(a.timer); disarm(a.html); return true; }
  const html = btn.innerHTML;
  btn.textContent = label;
  btn.classList.add('armed');
  armed.set(btn, { html, timer: setTimeout(() => disarm(html), 3000) });
  return false;
}

// ---------------- sign-in ----------------

function showLogin(msg) {
  $('#login').classList.remove('hidden');
  $('#loginMsg').textContent = msg || '';
  setTimeout(() => $('#loginPin').focus(), 50);
}

async function submitLogin() {
  const pin = $('#loginPin').value.trim();
  if (!pin) return;
  $('#btnLogin').disabled = true;
  try {
    const r = await fetchT('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) }, 10000);
    const j = await r.json();
    if (!j.ok) { $('#loginMsg').textContent = j.error || 'Sign-in failed'; return; }
    KEY = j.data.key;
    store.set(KEY);
    location.reload();
  } catch {
    $('#loginMsg').textContent = 'Cannot reach the Stagio PC. Check that it is running and on the same Wi-Fi.';
  } finally {
    $('#btnLogin').disabled = false;
  }
}
$('#btnLogin').onclick = submitLogin;
$('#loginPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });

// ---------------- live connection ----------------
// The server sends the whole state once, then only the parts that change, and an empty message
// every few seconds when nothing does. Hearing nothing for a while therefore means the link is
// dead, even if the browser hasn't noticed (phone changed Wi-Fi, PC went to sleep).

let es = null;
let lastMsgAt = 0;
let clockOffset = 0;    // the Stagio PC's clock minus this device's (ms)
let linkUp = null;      // null = not known yet
let connecting = false;

function setLink(up) {
  if (linkUp === up) return;
  linkUp = up;
  setSt('#stLink', up ? 'ok' : 'bad', up ? 'OK' : 'LOST');
  document.body.classList.toggle('link-lost', !up);
}

/** Checks access first (the live stream itself can't report "not signed in"), then connects. */
async function start() {
  if (connecting) return;
  connecting = true;
  try {
    const t0 = Date.now();
    const r = await fetchT('/api/ping', { headers: authHeaders() }, 6000);
    if (r.status === 401) {
      if (es) { es.close(); es = null; }
      if (KEY) { store.clear(); KEY = null; showLogin('That access link is no longer valid. Enter the PIN.'); } else showLogin();
      return;
    }
    // The show timer counts on the PC's clock; a phone's own clock may be off by a minute.
    try { const j = await r.json(); if (j.now) clockOffset = j.now - (t0 + Date.now()) / 2; } catch { /* keep the last offset */ }
  } catch { /* unreachable right now: connect anyway, the stream keeps retrying */ } finally {
    connecting = false;
  }
  connect();
}

function connect() {
  if (es) es.close();
  es = new EventSource(authUrl('/api/events'));
  lastMsgAt = Date.now(); // a fresh attempt gets the full silence allowance before it is judged dead
  es.onmessage = (e) => {
    lastMsgAt = Date.now();
    setLink(true);
    const patch = JSON.parse(e.data);
    if (patch._full || Object.keys(patch).length) applyState(patch);
  };
  es.onerror = () => {
    setLink(false);
    // After a dropped connection the browser retries by itself; after an error answer from the
    // server it gives up for good, so start over from the access check.
    if (es && es.readyState === EventSource.CLOSED) setTimeout(reconnect, 2000);
  };
}

function reconnect() {
  if (!$('#login').classList.contains('hidden')) return; // waiting for the PIN
  start();
}

setInterval(() => {
  if (es && Date.now() - lastMsgAt > 12000) { setLink(false); reconnect(); }
}, 3000);
// A phone coming back from the lock screen should be live again at once.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && es && (linkUp === false || Date.now() - lastMsgAt > 6000)) reconnect();
});
window.addEventListener('online', () => { if (es) reconnect(); });

/** Merges a full state or a patch and redraws only the panels it touches. */
function applyState(patch) {
  const full = !!patch._full || !S;
  if (full) { S = patch; delete S._full; } else Object.assign(S, patch);
  if (S.ppt) S.ppt.slides = S.slides || null; // the slide list travels as its own part
  const has = (...keys) => full || keys.some((k) => k in patch);
  if (has('edition')) applyEdition();
  if (has('ppt', 'localMusic', 'features')) renderStatus();
  if (has('ppt', 'slides', 'program', 'cues', 'recent', 'fastCopy')) renderSlides();
  if (has('localMusic', 'features')) renderMusic();
  if (has('audio', 'displays', 'displayMode', 'platform', 'ppt', 'settings')) renderOutput();
  if (has('cues', 'cueRunning', 'slides', 'settings')) renderCues();
  if (has('recent')) renderRecent();
  if (has('fastCopy', 'ppt')) renderFastCopy(patch.fastCopy && !full ? patch.fastCopy : null);
  if (has('cueAuto')) announceAutoCue(S.cueAuto, full);
  if (has('timer', 'ppt')) renderTimers();
  if (has('run', 'cues', 'recent', 'ppt', 'edition', 'displays')) renderRun();
  if (has('stage', 'edition')) renderStage();
  if (has('links') && $('#dlgRemote').open) renderLinks();
  if (has('settings')) renderKeysDialog();
  renderCheck(); // every part feeds the pre-event check; it only redraws what changed
}

const fileName = (p) => String(p || '').split(/[\\/]/).pop();
const sameDeck = (a, b) => fileName(a).toLowerCase() === fileName(b).toLowerCase();

/** Lite / Standard / Extra: name, version, and which panels this edition has. */
// The run of show only when the server says so; the rest unless the server says no.
const edHas = (feature) => (['run', 'stage'].includes(feature) ? S?.edition?.features?.[feature] === true : S?.edition?.features?.[feature] !== false);
function applyEdition() {
  const e = S.edition || {};
  for (const f of ['music', 'audio', 'displayMode', 'cues', 'run', 'stage']) document.body.classList.toggle(`no-${f}`, !edHas(f));
  $('#brandName').textContent = e.name || 'Stagio';
  document.title = e.name || 'Stagio';
  $('#betaTag').textContent = e.label || '';
  $('#betaTag').classList.toggle('hidden', !/beta|alpha/i.test(e.label || ''));
  const os = { windows: 'Windows', mac: 'Mac' }[S.platform?.os] || '';
  $('#aboutText').textContent = [e.name, e.label, os].filter(Boolean).join(' · ');
  // A tab this edition doesn't have (left from another edition on this phone): back to Slides.
  const tab = document.body.dataset.tab;
  if ((tab === 'music' && !edHas('music')) || (tab === 'cues' && !edHas('cues'))) $('.mnav [data-tab="slides"]')?.click();
}

/** Says when a cue ran by itself (and if a step failed), since nobody pressed a button for it. */
let autoCueSeen = '';
function announceAutoCue(a, quiet) {
  if (!a) return;
  const key = `${a.at}:${a.errors.length}`;
  if (key === autoCueSeen) return;
  autoCueSeen = key;
  if (quiet) return; // just connected: that cue ran a while ago
  if (a.errors.length) toast(`Auto cue “${a.name}”:\n${a.errors.join('\n')}`);
  else toast(`Auto cue · ${a.name} · slide ${a.slide}`, 'info');
}

function renderStatus() {
  const p = S.ppt;
  const show = p.show;
  if (!p.running) setSt('#stPpt', 'bad', 'OFF');
  else if (p.busy) setSt('#stPpt', 'warn', 'BUSY');
  else if (!show) setSt('#stPpt', 'warn', 'READY');
  else if (!show.slide) setSt('#stPpt', 'live', 'END');
  // PowerPoint reports "paused" when the show window loses focus; it is still on screen.
  else setSt('#stPpt', 'live', `${['running', 'paused'].includes(show.state) ? 'LIVE' : show.state.toUpperCase()} ${show.slide}/${show.total}`);

  const mode = musicMode();
  if (mode === 'off') setSt('#stMusic', '', 'OFF');
  else {
    const lm = S.localMusic || {};
    if (!lm.running) setSt('#stMusic', 'bad', 'NO PLAYER');
    else if (!lm.session) setSt('#stMusic', 'warn', 'IDLE');
    else setSt('#stMusic', lm.isPlaying ? 'ok' : 'warn', lm.fading ? 'FADING' : lm.isPlaying ? 'PLAYING' : 'PAUSED');
  }
}

// ---------------- slides ----------------

const presSelect = $('#presSelect');

/** URL of a slide's image (small = strip size), or null while it is still being rendered. */
function thumbUrl(path, s, small) {
  if (!s?.thumb) return null;
  return authUrl(`/api/ppt/thumb?path=${encodeURIComponent(path)}&id=${s.id}&v=${s.v}${small ? '&s=1' : ''}`);
}

/**
 * Shows slide `s` in a monitor image. While a newer render of the same slide is pending the old
 * image stays up; a different slide without a render yet blanks it. Returns true if an image shows.
 */
function showSlide(img, path, s) {
  const url = thumbUrl(path, s);
  if (url) { swapImg(img, url); img.dataset.sid = String(s.id); return true; }
  if (s && img.dataset.sid === String(s.id) && img.getAttribute('src')) return true;
  swapImg(img, null);
  img.dataset.sid = '';
  return false;
}

/** Swap an image only after the new version has loaded, so live updates don't flash blank. */
function swapImg(img, src) {
  if (!src) { img.removeAttribute('src'); delete img.dataset.want; return; }
  if (img.dataset.want === src) return;
  img.dataset.want = src;
  if (!img.getAttribute('src')) { img.src = src; return; }
  const pre = new Image();
  pre.onload = () => { if (img.dataset.want === src) img.src = src; };
  pre.src = src;
}

function renderCoedit(p) {
  const el = $('#coedit');
  const cur = (p.presentations || []).find((x) => x.path === p.focus);
  el.className = 'tag';
  if (!cur) { el.textContent = ''; return; }
  if (cur.cloud && cur.autoSave !== false) {
    el.classList.add('ok');
    el.textContent = 'Co-edit on';
    el.title = 'Stored in OneDrive/SharePoint. Edits made on other computers sync here.';
  } else {
    el.classList.add('warn');
    el.textContent = cur.cloud ? 'AutoSave off' : 'Local file';
    el.title = cur.cloud
      ? 'Turn on AutoSave in PowerPoint so edits from other computers sync here.'
      : 'Only edits made on this PC show up. For co-editing, store the file in OneDrive/SharePoint and open it from there.';
  }
}

/** What to say when no presentation is usable, including the Protected View case. */
function renderEmpty(p, has) {
  const el = $('#pptEmpty');
  el.classList.toggle('hidden', has);
  // With other decks open, a file stuck in Protected View still gets a reminder next to the picker.
  const pv = $('#pvTag');
  pv.classList.toggle('hidden', !(has && p.protectedView));
  pv.title = p.protectedView ? `“${p.protectedView}” is read-only until editing is enabled. Click to enable it.` : '';
  if (has) return;
  const recent = p.protectedView ? '' : recentRows(5);
  const key = `${p.protectedView || ''}|${recent}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = p.protectedView
    ? `<p>“${esc(p.protectedView)}” is open in Protected View</p>
       <p class="dim">PowerPoint opens downloaded and e-mailed files read-only, so Stagio can't use them yet.</p>
       <button class="btn" data-enable-editing>Enable editing</button>`
    : `<p>No presentation open</p>
       <p class="dim">${APP ? 'Drop a presentation on this window, or choose one:' : 'Open one in PowerPoint, or choose one:'}</p>
       <button class="btn" data-open-dialog>Open…</button>
       ${recent ? `<div class="label gap">Recent</div><div class="list">${recent}</div>` : ''}`;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-enable-editing]')) pptSend('/api/ppt/enableEditing', {}, 30000);
  if (e.target.closest('[data-open-dialog]')) showOpenDialog();
  const r = e.target.closest('[data-recent]');
  if (r) openDeck(r.dataset.recent);
});

function nextVisible(slides, from) {
  for (const s of slides) if (s.index > from && !s.hidden) return s.index;
  return null;
}

function renderSlides() {
  const p = S.ppt;
  const pres = p.presentations || [];
  const has = p.running && pres.length > 0;
  for (const sel of ['.stage', '.transport', '.strip-h', '#strip']) $(sel).classList.toggle('hidden', !has);
  renderEmpty(p, has);

  const opts = pres.map((x) => `<option value="${esc(x.path)}">${esc(x.name)} · ${x.slides}</option>`).join('');
  if (presSelect.dataset.opts !== opts) {
    presSelect.innerHTML = opts || '<option value="">No presentation</option>';
    presSelect.dataset.opts = opts;
  }
  // Leave the picker alone while it is open.
  if (document.activeElement !== presSelect && p.focus && presSelect.value !== p.focus) presSelect.value = p.focus;
  presSelect.disabled = !!p.show || pres.length < 2;
  renderSaveDeck();

  renderCoedit(p);

  const show = p.show;
  const list = p.slides?.path === p.focus ? p.slides.slides : [];
  const byIndex = (n) => list[n - 1];
  // The projected slide, matched by ID: if slides were just added or removed, slide numbers in
  // the list can be a moment behind PowerPoint's, IDs never are.
  const curSlide = show?.slideId ? list.find((s) => s.id === show.slideId) : (show?.slide ? byIndex(show.slide) : null);
  document.body.classList.toggle('live', !!show);

  const start = $('#btnStartShow');
  start.disabled = !has || !!show;
  start.classList.toggle('live', !!show);
  const startLabel = show ? 'Live' : 'Start <span class="k">F5</span>';
  if (start.dataset.label !== startLabel) { start.innerHTML = startLabel; start.dataset.label = startLabel; }
  $('#btnEndShow').disabled = !show;
  for (const id of ['#btnPrev', '#btnNext', '#btnBlack', '#btnWhite']) $(id).disabled = !show;
  $('#btnBlack').classList.toggle('on', show?.state === 'black');
  $('#btnWhite').classList.toggle('on', show?.state === 'white');

  // Animation steps ("builds") on the projected slide: how many clicks it has, how many are done.
  // While some are left, Next plays the next one instead of changing the slide.
  const builds = show?.clicks > 0 && show.slide ? show.clicks : 0;
  const buildsLeft = builds ? Math.max(0, builds - show.click) : 0;
  const buildTag = builds ? `<span class="build${buildsLeft ? '' : ' done'}">Build ${show.click}/${builds}</span>` : '';
  // A draft (quick image of a deck with embedded fonts, made during the show) says so.
  const edited = (s) => (s?.changed ? '<span class="edited">Edited</span>' : '')
    + (s?.draft ? '<span class="edited" title="Quick image: the fonts may look slightly different from the projector. It is replaced by the exact image as soon as that is ready.">Draft</span>' : '');
  const nextBtn = `${buildsLeft ? 'Next build' : 'Next'} <span class="k">→</span>`;
  if ($('#btnNext').dataset.label !== nextBtn) { $('#btnNext').innerHTML = nextBtn; $('#btnNext').dataset.label = nextBtn; }

  // Program = exactly what the projector shows.
  const nowOverlay = $('#nowOverlay');
  nowOverlay.className = 'overlay';
  nowOverlay.textContent = '';
  const feed = S.program?.live ? authUrl(S.program.url) : null;
  // Without the live capture, PROGRAM shows the slide's image instead, which has every animation
  // already played: say so plainly, and why, so it isn't taken for what the audience sees.
  const why = { covered: 'Another window is in front of the slide show (on a single screen, Stagio itself).',
    hidden: 'The slide show window is minimized.', none: 'The slide show window was not found.',
    geometry: 'The slide show window\'s position on the screens did not add up, so it is not copied (rather no picture than a cut-off one).',
    permission: 'macOS has not allowed Stagio to record the screen yet: System Settings → Privacy & Security → Screen & System Audio Recording → turn on Stagio, then quit and reopen Stagio.',
    unsupported: 'The live picture needs macOS 14 (Sonoma) or later.',
    error: 'The slide show window could not be copied.' }[S.program?.status] || 'The slide show window could not be copied.';
  $('#feedTag').textContent = p.busy ? 'PowerPoint is not responding' : show ? (feed ? 'Live capture' : 'Image · not live') : '';
  $('#feedTag').title = show && !feed && !p.busy ? `${why} With a projector set to Extend, this shows the live screen.` : '';
  $('#feedTag').classList.toggle('alert', !!p.busy || (!!show && !feed));
  const note = $('#nowNote');
  const pending = show && !feed && show.state !== 'black' && show.state !== 'white' && show.clicks > 0 && show.click < show.clicks;
  note.classList.toggle('hidden', !pending);
  if (pending) note.textContent = `On the projector: ${show.click} of ${show.clicks} animation steps shown`;
  if (show && feed) {
    // Screen capture of the show window: exactly what the audience sees, animations included.
    swapImg($('#nowImg'), feed);
    $('#nowImg').dataset.sid = 'feed';
    $('#nowLabel').innerHTML = `${edited(curSlide)}${buildTag}${show.slide ? `${show.slide} / ${show.total}` : 'End'}`;
    if (show.state === 'black') { nowOverlay.classList.add('black'); nowOverlay.textContent = 'Black'; }
    else if (show.state === 'white') { nowOverlay.classList.add('white'); nowOverlay.textContent = 'White'; }
  } else if (show && show.slide) {
    const shown = showSlide($('#nowImg'), show.path, curSlide);
    $('#nowLabel').innerHTML = `${edited(curSlide)}${buildTag}${show.slide} / ${show.total}`;
    if (show.state === 'black') { nowOverlay.classList.add('black'); nowOverlay.textContent = 'Black'; }
    else if (show.state === 'white') { nowOverlay.classList.add('white'); nowOverlay.textContent = 'White'; }
    else if (!shown) { nowOverlay.classList.add('msg'); nowOverlay.textContent = `${waitText(p.slides)} · slide ${show.slide}`; }
  } else {
    showSlide($('#nowImg'), show?.path, null);
    $('#nowLabel').textContent = '';
    nowOverlay.classList.add('msg');
    nowOverlay.textContent = show ? 'End of show' : 'Not live · F5 to start';
  }

  const nextN = show ? (curSlide ? nextVisible(list, curSlide.index) : null) : (list.find((s) => !s.hidden)?.index ?? null);
  const nextOverlay = $('#nextOverlay');
  nextOverlay.className = 'overlay';
  nextOverlay.textContent = '';
  if (nextN && p.focus) {
    const s = byIndex(nextN);
    if (!showSlide($('#nextImg'), p.focus, s)) { nextOverlay.classList.add('msg'); nextOverlay.textContent = waitText(p.slides); }
    const after = buildsLeft ? `<span class="build">after ${buildsLeft} build${buildsLeft === 1 ? '' : 's'}</span>` : '';
    $('#nextLabel').innerHTML = `${edited(s)}${after}${show ? (show.slide && curSlide ? show.slide + (nextN - curSlide.index) : nextN) : `starts at ${nextN}`}`;
  } else {
    showSlide($('#nextImg'), p.focus, null);
    $('#nextLabel').textContent = '';
    if (has) {
      nextOverlay.classList.add('msg');
      // No slide list yet is not "last slide": say what it is waiting for.
      nextOverlay.textContent = list.length ? 'Last slide' : S.fastCopy?.job?.state === 'running' ? 'PowerPoint busy · faster copy' : 'Reading slides…';
    }
  }
  $('#notes').textContent = show?.notes?.trim() || '';

  renderStrip(p, list, curSlide?.index);
}

/**
 * What a slide without its image is waiting for. A slide's image is only ever shown once it is
 * the right one (the content it has now, the fonts it really uses); until then the slide says so.
 */
function waitText(sl) {
  if (sl?.waitShow) return 'Image after the show';
  if (sl?.paused) return 'Waiting · PowerPoint in use';
  return 'Preparing image';
}
const fmtEta = (sec) => (sec < 60 ? 'under a minute' : `about ${Math.ceil(sec / 60)} min`);

/**
 * Slide strip: one tile per slide. This is the costly part of the panel (hundreds of tiles on a
 * long deck), so it only runs when the slide list or the projected slide actually changed —
 * not every second while a live capture or the music position ticks.
 */
let stripSeen = null;
function renderStrip(p, list, cur) {
  const fast = S.fastCopy?.job?.state;
  if (stripSeen && stripSeen.slides === S.slides && stripSeen.focus === p.focus && stripSeen.cur === cur && stripSeen.cues === S.cues && stripSeen.fast === fast) return;
  stripSeen = { slides: S.slides, focus: p.focus, cur, cues: S.cues, fast };

  const strip = $('#strip');
  // Tiles are rebuilt when slides are added, removed or reordered; otherwise updated in place.
  const key = `${p.focus}|${list.map((s) => s.id).join(',')}`;
  if (strip.dataset.key !== key) {
    strip.dataset.key = key;
    strip.dataset.cur = '';
    strip.innerHTML = list.map((s) => `
      <button class="thumb" data-n="${s.index}" data-id="${s.id}">
        <img loading="lazy" alt="" draggable="false">
        <span class="n">${s.index}</span>
        <span class="c"></span>
        <span class="h">Hidden</span>
        <span class="t"></span>
      </button>`).join('');
    for (const b of strip.children) b.draggable = canReorder();
  }
  // The slide's own shape for the tiles and for PROGRAM / PREVIEW (4:3 decks get 4:3 frames), so
  // a slide always shows whole and as big as it fits, whatever screen the projector is.
  document.documentElement.style.setProperty('--ratio', String(p.slides?.ratio || 16 / 9));
  const byId = new Map(list.map((s) => [String(s.id), s]));
  // Slides where a cue runs by itself get a marker in that cue's colour.
  const autoAt = new Map();
  (S.cues || []).forEach((c, i) => {
    if (c.auto && sameDeck(c.auto.deck, p.focus) && !autoAt.has(String(c.auto.slideId))) autoAt.set(String(c.auto.slideId), { c, n: i + 1 });
  });
  let edited = 0;
  for (const b of strip.children) {
    const s = byId.get(b.dataset.id);
    if (!s) continue;
    const mark = autoAt.get(b.dataset.id);
    const badge = b.children[2];
    const badgeText = mark ? `Cue ${mark.n}` : '';
    if (badge.textContent !== badgeText) {
      badge.textContent = badgeText;
      badge.dataset.color = mark?.c.color || '';
      badge.title = mark ? `Runs “${mark.c.name}” when the show gets here` : '';
    }
    const url = thumbUrl(p.focus, s, true);
    if (url) swapImg(b.firstElementChild, url); // until rendered, keep the previous image (or none)
    b.classList.toggle('rendering', !url);
    if (!url) b.dataset.wait = p.slides?.waitShow ? 'After show' : p.slides?.paused ? 'Waiting' : 'Preparing';
    const t = b.lastElementChild;
    if (t.textContent !== (s.title || ' ')) { t.textContent = s.title || ' '; b.title = s.title; }
    b.classList.toggle('hidden-slide', s.hidden);
    if (s.hidden) b.title = `Hidden in PowerPoint: the show skips it${s.title ? ` · ${s.title}` : ''}`;
    b.classList.toggle('changed', !!s.changed);
    b.classList.toggle('draft', !!s.draft && !s.changed);
    b.classList.toggle('current', s.index === cur);
    if (s.changed) edited++;
  }
  const total = list.length;
  const pending = p.slides?.pending || 0;
  // Decks with their own fonts (Canva exports) are drawn through PowerPoint's PDF export so the
  // images match the projector; that is slower, so say why the images take longer.
  const fonts = p.slides?.fonts;
  const fontNote = !fonts ? '' : fonts.pdf ? ' · embedded fonts' : ' · fonts may differ';
  const sl = p.slides || {};
  let progress = '';
  if (pending && sl.waitShow) progress = ` · ${pending} image${pending === 1 ? '' : 's'} after the show`;
  else if (pending && sl.paused) progress = ` · images ${total - pending}/${total}, paused while PowerPoint is in use`;
  else if (pending) progress = ` · preparing images ${total - pending}/${total}${sl.etaSec ? ` · ${fmtEta(sl.etaSec)}` : ''}`;
  const draftNote = sl.drafts ? ` · ${sl.drafts} draft image${sl.drafts === 1 ? '' : 's'} (exact ones follow)` : '';
  const hiddenN = list.filter((x) => x.hidden).length;
  $('#stripTitle').textContent = total ? `${total} slides${hiddenN ? ` · ${hiddenN} hidden` : ''}${edited ? ` · ${edited} edited` : ''}${progress}${draftNote}${fontNote}`
    : S.fastCopy?.job?.state === 'running' ? 'Slides · listed once PowerPoint has made the faster copy' : 'Slides';
  $('#stripTitle').classList.toggle('busy', !!pending);
  $('#stripTitle').title = !fonts ? ''
    : fonts.pdf
      ? `This file brings its own fonts (${fonts.embedded.join(', ')}). The slide images are made the way PowerPoint prints, so they match the projector; each one takes a little longer.`
      : `This file brings its own fonts (${fonts.embedded.join(', ')}), and the images could not be made the way PowerPoint prints, so text in the images may show in another font. The projector is not affected. "Reload all" tries again.`;
  if (cur && strip.dataset.cur !== String(cur)) {
    strip.dataset.cur = String(cur);
    $(`.thumb[data-n="${cur}"]`, strip)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

presSelect.addEventListener('change', () => post('/api/ppt/focus', { path: presSelect.value }));

// ---- reorder: drag a tile to another place (on the PC's desk, with a mouse) ----
// PowerPoint moves the slide (also during a show); the file is then changed but not saved, so a
// "Save file" button stays up for that file until it is saved from here.
const canReorder = () => isPC && !matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('can-reorder', canReorder());
$('#strip').classList.toggle('reorder', canReorder());
let dragFrom = null;   // { id, n }
let unsavedDeck = null;
const clearDrop = () => $$('.thumb.drop-before, .thumb.drop-after', $('#strip')).forEach((t) => t.classList.remove('drop-before', 'drop-after'));
$('#strip').addEventListener('dragstart', (e) => {
  const b = e.target.closest('.thumb');
  if (!b || !canReorder()) return;
  dragFrom = { id: Number(b.dataset.id), n: Number(b.dataset.n) };
  b.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom.id));
});
$('#strip').addEventListener('dragend', () => { dragFrom = null; clearDrop(); $$('.thumb.dragging').forEach((t) => t.classList.remove('dragging')); });
const dropSide = (b, e) => { const r = b.getBoundingClientRect(); return e.clientX < r.left + r.width / 2 ? 'before' : 'after'; };
$('#strip').addEventListener('dragover', (e) => {
  const b = e.target.closest('.thumb');
  if (!dragFrom || !b) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const side = dropSide(b, e);
  if (!b.classList.contains(`drop-${side}`)) { clearDrop(); b.classList.add(`drop-${side}`); }
});
$('#strip').addEventListener('drop', async (e) => {
  const b = e.target.closest('.thumb');
  const from = dragFrom;
  clearDrop();
  if (!from || !b) return;
  e.preventDefault();
  const t = Number(b.dataset.n);
  const side = dropSide(b, e);
  // the position the slide ends up at, counted in the new order
  const to = side === 'before' ? (from.n > t ? t : t - 1) : (from.n > t ? t + 1 : t);
  if (to === from.n) return;
  const deck = S.ppt.focus;
  try {
    await api('/api/ppt/move', { path: deck, id: from.id, to });
    unsavedDeck = deck;
    renderSaveDeck();
    toast(`Slide ${from.n} moved to ${to}. Not saved yet: "Save file" keeps the new order.`, 'info');
  } catch { /* toast shown */ }
});
function renderSaveDeck() {
  $('#btnSaveDeck').classList.toggle('hidden', !unsavedDeck || unsavedDeck !== S.ppt?.focus);
}
$('#btnSaveDeck').addEventListener('click', async () => {
  try {
    await api('/api/ppt/save', { path: unsavedDeck });
    toast('Saved', 'info');
    unsavedDeck = null;
    renderSaveDeck();
  } catch { /* toast shown */ }
});
$('#strip').addEventListener('click', (e) => {
  const b = e.target.closest('.thumb');
  // Clicking a tile while no show runs starts one at that slide, which can take a while.
  if (b) pptSend('/api/ppt/goto', { slide: Number(b.dataset.n), id: Number(b.dataset.id), path: S.ppt.focus }, S.ppt.show ? undefined : SLOW);
});

// PowerPoint can take a few seconds to draw a heavy slide; show that a command is on its way.
let pptPending = 0;
async function pptSend(path, body, timeoutMs) {
  pptPending++;
  document.body.classList.add('ppt-busy');
  try { return await post(path, body, timeoutMs); } finally {
    if (--pptPending === 0) document.body.classList.remove('ppt-busy');
  }
}
const pptNext = () => pptSend('/api/ppt/next');
const pptPrev = () => pptSend('/api/ppt/prev');
const pptState = (state) => pptSend('/api/ppt/state', { state });
const pptStart = () => pptSend('/api/ppt/start', { path: S?.ppt.focus, slide: 1 }, SLOW);

$('#btnNext').onclick = pptNext;
$('#btnPrev').onclick = pptPrev;
$('#btnBlack').onclick = () => pptState('black');
$('#btnWhite').onclick = () => pptState('white');
$('#btnStartShow').onclick = pptStart;
// Ending the show puts PowerPoint's editing window on the projector: ask twice.
$('#btnEndShow').onclick = (e) => { if (confirmTap(e.currentTarget, 'Confirm end')) pptSend('/api/ppt/end'); };
// Every slide image is made again: minutes on a heavy deck, with PowerPoint busy. Press twice.
$('#btnRefreshThumbs').onclick = (e) => { if (confirmTap(e.currentTarget, 'Press again to remake all images')) post('/api/ppt/refreshThumbs'); };
$('#pvTag').onclick = () => pptSend('/api/ppt/enableEditing', {}, 30000);

// ---------------- faster presentations ----------------
// A deck whose decorative text makes PowerPoint for Windows slow (Canva exports with Hebrew in a
// font that has no Hebrew letters) gets a tag. The dialog explains it and offers two ways to turn
// that text into pictures of itself: in the file itself (stays one shared file; a backup is kept
// on this PC first), or in a copy (the file stays as it is). The work runs on the PC; progress
// arrives through the live state, so a phone sees it too.
const fileOf = (p) => String(p || '').split(/[\\/]/).pop();
const secs = (ms) => (ms == null ? '?' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
let fastSeen = '';

function jobLabel(job) {
  if (job.waitingForShow) return 'waiting for the show to end';
  if (job.phase === 'backup') return 'saving a backup';
  if (job.phase === 'applying') return 'changing and saving the file';
  return `${job.done}/${job.total || '…'}`;
}

function renderFastCopy(changed) {
  const fc = S.fastCopy || {};
  const job = fc.job;
  const running = job?.state === 'running';
  const tag = $('#slowTag');
  const slowHere = !!fc.slow && fc.slow.path === S.ppt.focus;
  const versions = (fc.backups || []).length;
  const showTag = fc.available && (running || slowHere || versions > 0 || !!fc.restoring);
  tag.classList.toggle('hidden', !showTag);
  tag.classList.toggle('warn', running || slowHere || !!fc.restoring);
  tag.textContent = fc.restoring ? 'Putting earlier version back…'
    : running ? `${job.mode === 'inplace' ? 'Speeding up' : 'Making faster copy'} · ${jobLabel(job)}`
    : slowHere ? 'Slow in PowerPoint · speed up'
    : 'Earlier versions';
  tag.title = slowHere ? 'This file is slow in PowerPoint for Windows. Click to speed it up.'
    : !running && versions ? 'Versions of this file from before a speed-up, kept on this PC. Click to see or restore them.' : '';
  // Say once when a job finishes or fails, wherever the operator is.
  const key = job ? `${job.out}|${job.state}` : '';
  if (changed?.job && key !== fastSeen && job && !running) {
    if (job.state === 'done' && job.mode === 'inplace') {
      const sk = job.result?.skipped?.length || 0;
      toast(`${fileOf(job.path)} is now fast${sk ? ` (${sk} slide${sk === 1 ? '' : 's'} left as they were, see Speed up)` : ''}.`, sk ? 'error' : 'info');
    } else if (job.state === 'done') toast(`Faster copy ready: ${fileOf(job.out)} is open in PowerPoint and selected here.`, 'info');
    else if (job.state === 'failed') toast(`Not done: ${job.error}`);
  }
  fastSeen = key;
  if ($('#dlgFast').open) renderFastDialog();
}

function renderFastDialog() {
  const fc = S.fastCopy || {};
  const job = fc.job;
  const slow = fc.slow;
  const running = job?.state === 'running';
  const inplace = job?.mode === 'inplace';
  const body = $('#fastBody');
  const backups = fc.backups || [];
  let html;
  if (fc.restoring) {
    html = `<p>Putting an earlier version of <b>${esc(fileOf(S.ppt.focus))}</b> back…</p>
      <p class="dim">PowerPoint closes the file, puts the earlier version in its place and opens it again. This takes a few seconds.</p>`;
  } else if (running) {
    const what = inplace ? `Speeding up <b>${esc(fileOf(job.path))}</b>` : `Making <b>${esc(fileOf(job.out))}</b>`;
    const step = job.phase === 'backup' ? 'saving a backup of the current version'
      : job.phase === 'applying' ? 'putting the pictures into the file and saving it'
      : job.total ? `slide ${job.done} of ${job.total}` : 'reading the slides';
    html = `<p>${what}: ${step}</p>
      <p class="dim">${job.waitingForShow ? 'Paused while the slide show runs; it continues when the show ends.'
        : inplace ? 'PowerPoint is busy until this is finished. The file itself is only changed in the last step, in about half a minute.'
        : 'PowerPoint is busy until this is finished. Your file is not changed.'}</p>`;
  } else if (job?.state === 'done' && inplace) {
    const r = job.result || {};
    const sk = r.skipped || [];
    html = `<p><b>${esc(fileOf(job.path))}</b> is now fast: ${r.slides} slides changed${r.saved ? ' and saved' : ''}.${
      S.fastCopy?.slow ? '' : ''}</p>
      <ul>
        ${sk.length ? `<li class="warn-text">Slide${sk.length === 1 ? '' : 's'} ${sk.join(', ')} ${sk.length === 1 ? 'was' : 'were'} left as ${sk.length === 1 ? 'it was' : 'they were'}: someone changed that text while the pictures were being made. Run it again for ${sk.length === 1 ? 'it' : 'them'}.</li>` : ''}
        <li>If the file is on OneDrive or SharePoint with AutoSave on, everyone sharing it gets the change.</li>
        <li>The version before is kept on this PC: <span class="mono">${esc(r.backup)}</span></li>
        <li>The decorative text is now a picture and can't be edited as text.</li>
      </ul>`;
  } else if (job?.state === 'done') {
    const r = job.result || {};
    html = `<p><b>${esc(fileOf(job.out))}</b> is ready, open in PowerPoint and selected here.</p>
      <ul><li>The slowest slide is now drawn in <span class="figure">${secs(r.afterMs)}</span> instead of <span class="figure">${secs(r.beforeMs)}</span>.</li>
      <li>${r.slides} slides changed; the copy is ${r.sizeMB} MB. Present from the copy.</li>
      <li>Your original file is unchanged. If it is edited later, make a new copy.</li></ul>`;
  } else if (job?.state === 'failed' || job?.state === 'cancelled') {
    html = `<p>${job.state === 'cancelled' ? 'Stopped. Nothing was changed or left behind.' : `Not done: ${esc(job.error)}`}</p>
      <p class="dim">${inplace && job.state === 'failed' && job.backup
        ? `If the file was changed before this stopped, the version before is kept on this PC: <span class="mono">${esc(job.backup)}</span>`
        : 'Your file is unchanged.'}</p>`;
  } else if (slow) {
    const script = slow.scripts?.[0] || 'non-Latin';
    const minutes = Math.max(1, Math.round((slow.slides * 8) / 60)); // measured: ~8 s per slide on a heavy deck
    html = `<p>${slow.slides} of ${slow.total} slides have decorative ${esc(script)} text (${slow.chars.toLocaleString()} letters) set in
        <b>${esc((slow.fonts || []).join(', '))}</b>, a font with no ${esc(script)} letters. PowerPoint for Windows looks for a substitute
        font every time it draws them, so each slide change takes seconds. PowerPoint on a Mac doesn't have this problem.</p>
      <p>Stagio can turn that text into a picture of itself: it looks exactly the same, and slides change in a fraction of a second.
        Takes about ${minutes} min; PowerPoint is busy meanwhile. Do it before the event, not during a show.</p>
      <div class="label gap">Speed up this file</div>
      <ul>
        <li>Changes this file itself, so it stays one file${slow.shared ? ': everyone sharing it on OneDrive / SharePoint gets the change' : ''}. Use this when others edit it with you.</li>
        <li>A backup of the current version is saved on this PC first (${esc(slow.backupDir)}).</li>
        <li>The pictures are made and checked on a copy; the file itself is changed only at the end. A slide someone edits meanwhile is left as it is.</li>
        <li>That text can no longer be edited as text.</li>
      </ul>
      <div class="label gap">Make a faster copy</div>
      <ul>
        <li>This file stays as it is. A copy is saved next to it as <b>${esc(slow.out)}</b> and opened.</li>
        <li>Later edits to this file don't reach the copy.</li>
      </ul>`;
  } else {
    html = '<p>The presentation in view has no text that slows PowerPoint down.</p>';
  }
  // Earlier versions of this file (from before a speed-up or a restore), to put back.
  if (!running && !fc.restoring && backups.length) {
    const when = (ms) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    html += `<div class="label gap">Earlier versions kept on this PC</div>
      <div class="list">${backups.map((b) => `<div class="row">
        <span class="txt"><span class="t1">${when(b.at)}</span><span class="t2">${b.kind === 'restore' ? 'As it was before an earlier version was put back' : 'As it was before the speed-up'} · ${b.sizeMB || '< 0.1'} MB</span></span>
        ${isPC ? `<button class="btn sm" data-restore="${esc(b.file)}"${S.ppt.show ? ' disabled title="Not during a slide show"' : ''}>Restore</button>` : ''}
      </div>`).join('')}</div>
      <p class="hint">Restore puts that version back in place of this file${fc.shared ? ', for everyone sharing it' : ''}. Changes made since then${fc.shared ? ', also by others,' : ''} are replaced. The version it replaces is kept here first, so you can go back.</p>`;
  }
  // It changes files and keeps PowerPoint busy for minutes: started from the PC only.
  if (!isPC && slow && !running && job?.state !== 'done') html += '<p class="warn-text">Start this on the Stagio PC.</p>';
  else if (!isPC && backups.length && !running) html += '<p class="warn-text">Restoring is done on the Stagio PC.</p>';
  if (body.dataset.html !== html) { body.innerHTML = html; body.dataset.html = html; }
  $('#dlgFast h3').textContent = slow || running || job || fc.restoring ? 'Speed up in PowerPoint' : 'Earlier versions';
  $('#fastMeter').classList.toggle('hidden', !running);
  $('#fastBar').style.width = running && job.total ? `${Math.round((job.done / job.total) * 100)}%` : '0';
  const offer = isPC && !running && !!slow && job?.state !== 'done';
  for (const id of ['#btnFastGo', '#btnFastInplace']) {
    $(id).classList.toggle('hidden', !offer);
    $(id).disabled = !!S.ppt.show;
    $(id).title = S.ppt.show ? 'Not during a slide show' : '';
  }
  $('#btnFastCancel').classList.toggle('hidden', !running || job.phase === 'applying');
}

$('#slowTag').onclick = () => { renderFastDialog(); $('#dlgFast').showModal(); };
$('#btnFastClose').onclick = () => {
  $('#dlgFast').close();
  if (S.fastCopy?.job && S.fastCopy.job.state !== 'running') post('/api/ppt/fastCopy/dismiss');
};
async function startSpeedUp(mode) {
  try { await api('/api/ppt/fastCopy', { path: S.fastCopy?.slow?.path, mode }); } catch { /* toast shown */ }
  renderFastDialog();
}
$('#btnFastGo').onclick = () => startSpeedUp('copy');
// Changing the file itself (and, when shared, everyone's copy of it): press twice.
$('#btnFastInplace').onclick = (e) => { if (confirmTap(e.currentTarget, 'Confirm: change this file')) startSpeedUp('inplace'); };
$('#btnFastCancel').onclick = () => post('/api/ppt/fastCopy/cancel');
// Putting an earlier version back replaces the file (for everyone, if shared): press twice.
$('#fastBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-restore]');
  if (!b || b.disabled) return;
  if (!confirmTap(b, 'Confirm restore')) return;
  b.disabled = true;
  try {
    const r = await api('/api/ppt/restoreBackup', { file: b.dataset.restore }, undefined, VERY_SLOW);
    toast(`Earlier version put back. ${fileOf(r.path)} is open again; the version it replaced is listed under Earlier versions.`, 'info');
  } catch { /* toast shown */ }
  delete $('#fastBody').dataset.html;
  renderFastDialog();
});

// ---------------- opening a presentation ----------------
// Three ways: the normal file window (desktop app only), the recent list, or a pasted path. In
// the desktop app a file can also be dropped anywhere on the window.

const APP = window.stagioApp || null; // set by the desktop app (electron/preload.js)
const DECK_FILE = /\.(pptx?|pptm|ppsx?|ppsm|potx?|potm|odp)$/i;

/** Rows for the recent list (newest first); '' when there are none. */
function recentRows(max) {
  return (S?.recent || []).slice(0, max).map((r) => {
    let folder = r.path.slice(0, Math.max(0, r.path.length - fileName(r.path).length - 1));
    // A long folder path is cut at the front: the last folders say more than "C:\Users\…".
    if (folder.length > 46) folder = `…${folder.slice(-44).replace(/^[^\\/]*/, '')}`;
    // A file moved or deleted since is shown, greyed out, so its name can still be recognised.
    if (r.missing) {
      return `<div class="row missing" title="${esc(r.path)}">
      <span class="txt"><span class="t1">${esc(r.name || fileName(r.path))}</span><span class="t2">Not found: moved, renamed or deleted · ${esc(folder)}</span></span></div>`;
    }
    return `<div class="row" data-recent="${esc(r.path)}" role="button" tabindex="0" title="${esc(r.path)}">
      <span class="txt"><span class="t1">${esc(r.name || fileName(r.path))}</span><span class="t2">${esc(folder)}</span></span></div>`;
  }).join('');
}
function renderRecent() {
  const rows = recentRows(8);
  $('#recentBox').classList.toggle('hidden', !rows);
  if ($('#recentList').dataset.html !== rows) { $('#recentList').innerHTML = rows; $('#recentList').dataset.html = rows; }
}

let opening = false;
/** Opens the file in PowerPoint on the PC (which may first have to start PowerPoint). */
async function openDeck(path) {
  path = String(path || '').trim().replace(/^"|"$/g, '');
  if (!path) return toast('Enter a file path');
  if (!DECK_FILE.test(path)) return toast(`“${fileName(path)}” is not a PowerPoint file`);
  if (opening) return;
  opening = true;
  $('#btnConfirmOpen').disabled = true;
  toast(`Opening ${fileName(path)}…`, 'info');
  pptPending++;
  document.body.classList.add('ppt-busy');
  try {
    await api('/api/ppt/open', { path }, undefined, SLOW);
    if ($('#dlgOpen').open) $('#dlgOpen').close();
  } catch { /* toast shown */ } finally {
    opening = false;
    $('#btnConfirmOpen').disabled = false;
    if (--pptPending === 0) document.body.classList.remove('ppt-busy');
  }
}

function showOpenDialog() {
  $('#btnBrowse').classList.toggle('hidden', !APP);
  $('#openHint').textContent = APP
    ? 'Or paste the full path of the file. You can also drop the file anywhere on this window.'
    : isPC
      ? 'In File Explorer, Shift + right-click the file → Copy as path, then paste it here.'
      : 'Full path of the file on the Stagio PC.';
  renderRecent();
  $('#dlgOpen').showModal();
  if (!APP) $('#openPath').focus();
}
$('#btnOpenFile').onclick = showOpenDialog;
$('#btnCancelOpen').onclick = () => $('#dlgOpen').close();
$('#btnConfirmOpen').onclick = () => openDeck($('#openPath').value);
$('#openPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') openDeck($('#openPath').value); });
$('#btnBrowse').onclick = async () => {
  const picked = await APP.pickDeck().catch(() => null);
  if (picked) openDeck(picked);
};

// Dropping a file. A browser's own reaction to a dropped file is to leave the page and show the
// file, which would take the console away mid-show, so the drop is always taken over here.
let dragDepth = 0;
const dragHasFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const setDropping = (on) => document.body.classList.toggle('dropping', on);
window.addEventListener('dragenter', (e) => { if (dragHasFile(e)) { dragDepth++; if (APP) setDropping(true); } });
window.addEventListener('dragleave', (e) => { if (dragHasFile(e) && --dragDepth <= 0) { dragDepth = 0; setDropping(false); } });
window.addEventListener('dragover', (e) => {
  if (!dragHasFile(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = APP ? 'copy' : 'none';
});
window.addEventListener('drop', (e) => {
  if (!dragHasFile(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDropping(false);
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!APP) return toast('Dropping a file works in the Stagio app on the PC. Here, use Open… and pick a recent file or paste its path.');
  const path = APP.pathForFile(file);
  if (!path) return toast('That file is not stored on this PC. Save it to a folder first, then drop it again.');
  openDeck(path);
});

// ---------------- music ----------------

let prog = { pos: 0, dur: 0, at: 0, playing: false, seek: false };

$('#btnPrevTrack').innerHTML = ICON.prev;
$('#btnNextTrack').innerHTML = ICON.next;
$('#btnPlay').innerHTML = ICON.play;

const musicMode = () => (edHas('music') ? (S?.features?.music === 'off' ? 'off' : 'local') : 'off');

/** Notice when no app plays music yet. Returns true if shown. */
function renderLocalHint(lm) {
  const box = $('#localHint');
  let html = '';
  const want = lm?.pinned ? (lm.app?.name || 'The chosen app') : '';
  const open = lm?.lastApp ? `<button class="btn sm" id="btnLaunchMusic">Open ${esc(lm.lastApp.name)}</button>` : '';
  if (lm?.error) html = `<p>${esc(lm.error)}</p>`;
  else if (lm && !lm.running && want) html = `<p>${esc(want)} is not open on this PC.</p>${open}`;
  else if (lm && !lm.running) html = `<p>No app is playing music on this PC. Start the music in any player (a music app, a media player or a browser): Stagio follows it.</p>${open}`;
  else if (lm && !lm.session) html = `<p>${esc(want || 'The music app')} is open. Start the music once (pausing afterwards is fine) so Stagio can take control.</p>`;
  box.classList.toggle('hidden', !html);
  if (box.dataset.html !== html) {
    box.dataset.html = html;
    box.innerHTML = html;
    $('#btnLaunchMusic')?.addEventListener('click', () => post('/api/music/launch'));
  }
  return !!html;
}

/** The app picker: Automatic, every app in the media controls, and the chosen one if it is gone. */
function renderSource(lm) {
  const sel = $('#musicSource');
  const list = [...(lm?.sources || [])];
  if (lm?.pinned && !list.some((x) => x.id === lm.pinned)) list.push({ id: lm.pinned, name: lm.app?.name || lm.lastApp?.name || 'Chosen app', gone: true });
  const auto = !lm?.pinned && lm?.app ? `Automatic · ${lm.app.name}` : 'Automatic';
  const opts = [`<option value="">${esc(auto)}</option>`]
    .concat(list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}${x.gone ? ' (not open)' : x.playing ? ' · playing' : ''}</option>`)).join('');
  if (sel.dataset.opts !== opts) { sel.innerHTML = opts; sel.dataset.opts = opts; }
  if (document.activeElement !== sel) sel.value = lm?.pinned || '';
}
$('#musicSource').addEventListener('change', (e) => post('/api/music/source', { id: e.target.value }));

function renderMusic() {
  const mode = musicMode();
  document.body.classList.toggle('no-music', mode === 'off');
  $$('#musicMode button').forEach((b) => b.classList.toggle('on', b.dataset.music === mode));
  $('#musicOff').classList.toggle('hidden', mode !== 'off');
  $('#musicSource').classList.toggle('hidden', mode === 'off');
  if (mode === 'off') { $('#localHint').classList.add('hidden'); $('#musicMain').classList.add('hidden'); return; }

  const lm = S.localMusic || {};
  renderSource(lm);
  const blocked = renderLocalHint(S.localMusic);
  $('#musicMain').classList.toggle('hidden', blocked && !lm.session);
  const np = {
    isPlaying: !!lm.isPlaying, title: lm.title, artist: lm.artist, image: lm.art,
    device: lm.session && lm.app ? `${lm.app.name} · this PC` : '',
    volume: lm.volume >= 0 ? lm.volume : null,
    pos: lm.positionMs || 0, dur: lm.durationMs || 0, fading: lm.fading,
    idle: 'Start the music in the app',
  };

  $('#trackName').textContent = np.title || 'Nothing playing';
  $('#trackArtist').textContent = np.title ? (np.artist || '') : np.idle;
  $('#trackDevice').textContent = np.device;
  const art = $('#art');
  const bg = np.image ? `url("${authUrl(np.image)}")` : '';
  if (art.dataset.bg !== bg) { art.style.backgroundImage = bg; art.dataset.bg = bg; }
  const icon = np.isPlaying ? ICON.pause : ICON.play;
  if ($('#btnPlay').dataset.icon !== icon) { $('#btnPlay').innerHTML = icon; $('#btnPlay').dataset.icon = icon; }
  syncSlider($('#musicVol'), $('#musicVolOut'), np.volume);
  prog = { pos: np.pos, dur: np.dur, at: performance.now(), playing: np.isPlaying, seek: !!lm.canSeek };
  $('#progress').classList.toggle('seekable', prog.seek && prog.dur > 0);
  $('#progress').title = prog.seek && prog.dur > 0 ? 'Click to jump to that point in the track' : '';
  $('#fadingLabel').textContent = np.fading === 'out' ? 'Fading out' : np.fading === 'in' ? 'Fading in' : '';
}

/** Current music level (for the ↑/↓ keys). */
function musicVolume() {
  return S.localMusic?.volume >= 0 ? S.localMusic.volume : null;
}

setInterval(() => {
  const pos = prog.playing ? Math.min(prog.dur, prog.pos + performance.now() - prog.at) : prog.pos;
  $('#progressBar').style.width = prog.dur ? `${(pos / prog.dur) * 100}%` : '0';
  $('#tPos').textContent = fmt(pos);
  $('#tDur').textContent = prog.dur ? `-${fmt(prog.dur - pos)}` : '0:00';
}, 250);

$('#progress').addEventListener('click', (e) => {
  if (!prog.dur || !prog.seek || musicMode() === 'off') return;
  const r = e.currentTarget.getBoundingClientRect();
  post('/api/music/seek', { ms: ((e.clientX - r.left) / r.width) * prog.dur });
});

const musicToggle = () => post('/api/music/toggle');
const musicNext = () => post('/api/music/next');
const fadeSecs = () => Number($('#fadeSecs').value) || 4;
const fadeOut = () => post('/api/music/fadeOut', { seconds: fadeSecs() });
const fadeIn = () => post('/api/music/fadeIn', { seconds: fadeSecs() });
const nudgeVolume = (d) => {
  const v = musicVolume();
  if (v === null) return;
  const nv = Math.max(0, Math.min(100, v + d));
  $('#musicVol').value = nv; $('#musicVolOut').textContent = nv;
  post('/api/music/volume', { volume: nv });
};

$('#btnPlay').onclick = musicToggle;
$('#btnNextTrack').onclick = musicNext;
$('#btnPrevTrack').onclick = () => post('/api/music/previous');
$('#btnFadeOut').onclick = fadeOut;
$('#btnFadeIn').onclick = fadeIn;
// Fade between two chosen levels; the fields are kept on this device for next time.
for (const id of ['fadeFrom', 'fadeTo']) {
  let saved = null;
  try { saved = localStorage.getItem(`onedesk.${id}`); } catch { /* private mode */ }
  if (saved !== null) $(`#${id}`).value = saved;
  $(`#${id}`).addEventListener('change', (e) => { try { localStorage.setItem(`onedesk.${id}`, e.target.value); } catch { /* not kept */ } });
}
$('#btnFadeTo').onclick = () => {
  const to = $('#fadeTo').value.trim();
  const from = $('#fadeFrom').value.trim();
  if (to === '' || Number(to) < 0 || Number(to) > 100) return toast('Enter the level to fade to (0-100)');
  if (from !== '' && (Number(from) < 0 || Number(from) > 100)) return toast('"From" is a level from 0 to 100, or empty for the level it has now');
  post('/api/music/fadeTo', { from: from === '' ? null : Number(from), to: Number(to), seconds: fadeSecs() });
};
bindSlider($('#musicVol'), $('#musicVolOut'), (v) => post('/api/music/volume', { volume: v }));
$('#musicMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-music]');
  if (b && b.dataset.music !== musicMode()) post('/api/features', { music: b.dataset.music });
});

// ---------------- output ----------------

function renderOutput() {
  const a = S.audio;
  const devs = a?.devices || [];
  const key = devs.map((d) => d.id + d.isDefault).join('|');
  const el = $('#audioDevices');
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = devs.length
      ? devs.map((d) => `<div class="row ${d.isDefault ? 'selected' : ''}" data-audio="${esc(d.id)}" role="button" tabindex="0">
          <span class="radio"></span><span class="txt"><span class="t1">${esc(d.name)}</span></span></div>`).join('')
      : `<p class="dim">${esc(a?.error || 'No output devices found')}</p>`;
  }
  syncSlider($('#sysVol'), $('#sysVolOut'), a?.volume ?? null);
  $('#btnMute').classList.toggle('on', !!a?.mute);
  $('#btnMute').textContent = a?.mute ? 'Muted · click to unmute' : 'Mute';

  // Hide what this platform can't do (the Mac beta has no display-mode or show-monitor control).
  const pf = S.platform || {};
  $('#betaTag').classList.toggle('hidden', !pf.beta);
  $('#displayGroup').classList.toggle('hidden', pf.displayMode === false);
  $('#monitorGroup').classList.toggle('hidden', pf.showMonitor === false);
  $('#audioDevices').classList.toggle('readonly', pf.audioDeviceSwitch === false);
  $('#audioSwitchHint').textContent = pf.audioDeviceSwitch === false
    ? 'Switching devices on Mac needs SwitchAudioSource (brew install switchaudio-osx). Volume and mute work.'
    : '';

  $$('#displayModes button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === S.displayMode);
    // A Mac can only duplicate or extend (it can't switch one screen off).
    b.classList.toggle('hidden', !!pf.displayModes && !pf.displayModes.includes(b.dataset.mode));
  });
  $('#presenterGroup').classList.toggle('hidden', !pf.presenterView);
  const pv = S.settings?.hidePresenterView ? 'hide' : 'show';
  $$('#presenterModes button').forEach((b) => b.classList.toggle('on', b.dataset.pv === pv));

  const screens = S.displays?.screens || [];
  const mOpts = '<option value="">Automatic (PowerPoint default)</option>' + screens.map((s, i) =>
    `<option value="${esc(s.device)}">Display ${i + 1} · ${s.width}×${s.height}${s.scale ? ` · ${s.scale}%` : ''}${s.primary ? ' · main' : ''}</option>`).join('');
  const ms = $('#monitorSelect');
  if (ms.dataset.opts !== mOpts) { ms.innerHTML = mOpts; ms.dataset.opts = mOpts; }
  if (document.activeElement !== ms) ms.value = S.ppt.monitor || ''; // not while the list is open
  $('#screensHint').textContent = pf.showMonitor === false ? '' : screens.length < 2
    ? `${screens.length} display detected. Connect the projector and choose Extend to keep this console on the PC screen.`
    : `${screens.length} displays detected. Applies the next time a show starts.`;
}

$('#audioDevices').addEventListener('click', (e) => {
  const r = e.target.closest('[data-audio]');
  if (r && !$('#audioDevices').classList.contains('readonly')) post('/api/audio/device', { id: r.dataset.audio });
});
bindSlider($('#sysVol'), $('#sysVolOut'), (v) => post('/api/audio/volume', { value: v }));
$('#btnMute').onclick = () => post('/api/audio/mute', { mute: !S.audio?.mute });
$('#displayModes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  // Switching the display mode re-arranges every screen (and "PC only" blanks the projector):
  // during a show that has to be deliberate.
  if (S?.ppt.show && !confirmTap(b, 'Confirm')) return;
  post('/api/display/mode', { mode: b.dataset.mode });
});
$('#monitorSelect').addEventListener('change', (e) => post('/api/ppt/monitor', { monitor: e.target.value }));
$('#presenterModes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pv]');
  if (b) post('/api/settings', { hidePresenterView: b.dataset.pv === 'hide' });
});

// ---------------- cues ----------------

/** Where a cue runs by itself, for its button: "auto @ 12", or why it won't right now. */
function autoLabel(c) {
  if (!c.auto) return '';
  if (!S.settings?.autoCues) return ' · auto off';
  const sl = S.slides;
  if (!sl || !sameDeck(sl.path, c.auto.deck)) return ` · auto in ${c.auto.deck}`;
  const s = sl.slides.find((x) => x.id === c.auto.slideId);
  return s ? ` · auto @ ${s.index}` : ' · auto slide deleted';
}

function renderCues() {
  const autoOn = !!S.settings?.autoCues;
  const ab = $('#btnAutoCues');
  ab.textContent = autoOn ? 'Auto on' : 'Auto off';
  ab.classList.toggle('lit', autoOn);
  const labels = S.cues.map(autoLabel);
  const shift = !!S.settings?.cueShift;
  const key = JSON.stringify([S.cues, S.cueRunning?.id, labels, shift]);
  const el = $('#cues');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = S.cues.map((c, i) => `
    <button class="cue ${S.cueRunning?.id === c.id ? 'running' : ''}" data-cue="${esc(c.id)}" data-color="${esc(c.color)}"${i < 9 ? ` title="Key: ${shift ? 'Shift + ' : ''}${i + 1}"` : ''}>
      <span class="ck${shift ? ' shift' : ''}">${i < 9 ? `${shift ? '⇧' : ''}${i + 1}` : ''}</span>
      <span class="cn">${esc(c.name)}</span>
      <span class="cm">${c.steps.length} step${c.steps.length === 1 ? '' : 's'}${esc(labels[i])}</span>
    </button>`).join('') || '<span class="dim">No cues yet. Use Edit to add one.</span>';
}
$('#btnAutoCues').onclick = () => post('/api/settings', { autoCues: !S.settings?.autoCues });

function runCue(id) { return post(`/api/cues/${encodeURIComponent(id)}/run`, {}, VERY_SLOW); }
$('#cues').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cue]');
  if (b) runCue(b.dataset.cue);
});

// cue editor
let draft = [];
const COLORS = { green: 'Green', blue: 'Blue', amber: 'Amber', red: 'Red', purple: 'Purple' };
const MODES = { internal: 'PC only', clone: 'Duplicate', extend: 'Extend', external: 'Projector only' };

function paramInput(p, value, ci, si) {
  const attrs = `data-ci="${ci}" data-si="${si}" data-key="${p.key}"`;
  if (p.type === 'audioDevice') {
    const devs = S.audio?.devices || [];
    return `<select ${attrs}>${devs.map((d) => `<option value="${esc(d.id)}" ${d.id === value ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`;
  }
  if (p.type === 'displayMode') {
    return `<select ${attrs}>${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${k === value ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  }
  return `<label>${esc(p.label)} <input type="${p.type === 'number' ? 'number' : 'text'}" class="mono" ${attrs} value="${esc(value ?? p.default)}"></label>`;
}

function renderCueEditor() {
  const typeOpts = (sel) => Object.entries(stepTypes).map(([k, t]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  $('#cueEditor').innerHTML = draft.map((c, ci) => `
    <div class="cue-card">
      <div class="head">
        <span class="mono dim">${ci < 9 ? ci + 1 : ''}</span>
        <input type="text" data-ci="${ci}" data-field="name" value="${esc(c.name)}">
        <select data-ci="${ci}" data-field="color">${Object.entries(COLORS).map(([k, v]) => `<option value="${k}" ${k === c.color ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <button class="btn sm" data-del-cue="${ci}">Delete</button>
      </div>
      ${c.steps.map((s, si) => `
        <div class="step">
          <span class="num">${si + 1}</span>
          <select data-ci="${ci}" data-si="${si}" data-field="type">${typeOpts(s.type)}</select>
          ${(stepTypes[s.type]?.params || []).map((p) => paramInput(p, s[p.key], ci, si)).join('')}
          <button class="btn sm" data-del-step="${ci}:${si}" title="Remove step">Remove</button>
        </div>`).join('')}
      <button class="link" data-add-step="${ci}">Add step</button>
      ${autoRow(c, ci)}
    </div>`).join('');
}

/**
 * "Run by itself at slide N" for one cue. The slide is chosen by number in the presentation
 * that is in view, and stored by its ID so the cue stays with it when slides move.
 */
function autoRow(c, ci) {
  const sl = S.slides;
  const deck = sl ? fileName(sl.path) : '';
  const a = c.auto;
  const here = !!a && !!sl && sameDeck(a.deck, deck);
  const cur = here ? sl.slides.find((s) => s.id === a.slideId) : null;
  let tail;
  if (!a) tail = sl ? `of ${esc(deck)}` : 'Open the presentation to choose a slide';
  else if (!here) tail = `of ${esc(a.deck)} · open that presentation to change the slide`;
  else if (!cur) tail = '<span class="warn-text">That slide was deleted. Choose another.</span>';
  else tail = `of ${esc(deck)}${cur.title ? ` · ${esc(cur.title)}` : ''}`;
  return `<div class="step auto">
      <label><input type="checkbox" data-ci="${ci}" data-field="autoOn" ${a ? 'checked' : ''} ${!a && !sl ? 'disabled' : ''}> Run by itself at slide</label>
      <input type="number" class="mono" min="1" max="${sl ? sl.slides.length : 1}" data-ci="${ci}" data-field="autoSlide" value="${a ? (cur ? cur.index : a.slide) : ''}" ${here ? '' : 'disabled'}>
      <span class="dim">${tail}</span>
    </div>`;
}

/** Binds the cue to slide number `n` of the presentation in view; false if there is no such slide. */
function setAutoSlide(cue, n) {
  const sl = S.slides;
  const s = sl?.slides.find((x) => x.index === n);
  if (!s) return false;
  cue.auto = { deck: fileName(sl.path), slideId: s.id, slide: s.index };
  return true;
}

function defaultsFor(type) {
  const s = { type };
  for (const p of stepTypes[type]?.params || []) {
    s[p.key] = p.type === 'audioDevice' ? (S.audio?.devices?.[0]?.id || '') : p.default;
  }
  return s;
}

$('#btnEditCues').onclick = async () => {
  if (!Object.keys(stepTypes).length) {
    try { stepTypes = await (await fetchT('/api/cues/types', { headers: authHeaders() }, 10000)).json(); } catch { return toast('No connection to the Stagio PC'); }
  }
  draft = JSON.parse(JSON.stringify(S.cues));
  renderCueEditor();
  $('#dlgCues').showModal();
};
$('#btnCancelCues').onclick = () => $('#dlgCues').close();
$('#btnAddCue').onclick = () => {
  draft.push({ id: `cue${Date.now()}`, name: 'New cue', color: 'blue', steps: [defaultsFor('ppt.next')] });
  renderCueEditor();
};
$('#btnSaveCues').onclick = async () => {
  try { await api('/api/cues', draft, 'PUT'); $('#dlgCues').close(); toast('Cues saved', 'info'); } catch { /* toast shown */ }
};
$('#cueEditor').addEventListener('input', (e) => {
  const t = e.target;
  const ci = Number(t.dataset.ci);
  if (Number.isNaN(ci)) return;
  if (t.dataset.field === 'name' || t.dataset.field === 'color') { draft[ci][t.dataset.field] = t.value; return; }
  if (t.dataset.field === 'autoOn') {
    // Starts on the slide now on the projector (or the first one); the number can then be changed.
    const show = S.ppt.show;
    const onAir = show && S.slides && show.path === S.slides.path ? S.slides.slides.find((s) => s.id === show.slideId) : null;
    if (!t.checked) delete draft[ci].auto;
    else if (!setAutoSlide(draft[ci], onAir?.index || 1)) t.checked = false;
    renderCueEditor();
    return;
  }
  // The slide number is applied as it is typed; the row is redrawn (slide title) on leaving the box.
  if (t.dataset.field === 'autoSlide') { setAutoSlide(draft[ci], Number(t.value)); return; }
  const si = Number(t.dataset.si);
  if (t.dataset.field === 'type') { draft[ci].steps[si] = defaultsFor(t.value); renderCueEditor(); return; }
  if (t.dataset.key) draft[ci].steps[si][t.dataset.key] = t.type === 'number' ? Number(t.value) : t.value;
});
$('#cueEditor').addEventListener('change', (e) => {
  if (e.target.dataset.field === 'autoSlide') renderCueEditor();
});
$('#cueEditor').addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset.delCue !== undefined) { draft.splice(Number(t.dataset.delCue), 1); renderCueEditor(); }
  if (t.dataset.delStep) { const [ci, si] = t.dataset.delStep.split(':').map(Number); draft[ci].steps.splice(si, 1); renderCueEditor(); }
  if (t.dataset.addStep !== undefined) { draft[Number(t.dataset.addStep)].steps.push(defaultsFor('wait')); renderCueEditor(); }
});

// ---------------- keyboard ----------------

/**
 * What a key does right now: a function to run, `null` for "a Stagio key that does nothing at
 * the moment" (still swallowed), or `undefined` for a key that isn't ours.
 */
function keyAction(e) {
  const k = e.key;
  // Cue keys. Read by position (e.code): with Shift held, the top row types ! @ # and the number
  // pad turns into End, ↓, PgDn…, which would otherwise change slides.
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '')?.[1] || (/^[1-9]$/.test(k) ? k : null);
  const shiftCues = !!S.settings?.cueShift;
  if (digit && edHas('cues') && (e.shiftKey ? shiftCues : /^[1-9]$/.test(k))) {
    const cue = S.cues[Number(digit) - 1];
    if (!shiftCues || e.shiftKey) return cue ? () => runCue(cue.id) : null;
    return () => cueKeyHint(digit, cue); // a plain number while cues need Shift
  }
  // (Shift + number while plain numbers run cues falls through: Shift + number pad 3 is PgDn.)
  const show = !!S.ppt.show;
  const music = musicMode() !== 'off';
  const when = (cond, fn) => (cond ? fn : null);
  switch (k) {
    case 'ArrowRight': case 'PageDown': case ' ': case 'Enter': return when(show, pptNext);
    case 'ArrowLeft': case 'PageUp': case 'Backspace': return when(show, pptPrev);
    case 'b': case 'B': case '.': return when(show, () => pptState('black'));
    case 'w': case 'W': case ',': return when(show, () => pptState('white'));
    case 'F5': return when(!show, pptStart);
    case 'Home': return when(show, () => pptSend('/api/ppt/goto', { slide: 1 }));
    case 'End': return when(show, () => pptSend('/api/ppt/goto', { slide: S.ppt.show.total }));
    case 'p': case 'P': return music ? musicToggle : undefined;
    case 'n': case 'N': return music ? musicNext : undefined;
    case 'o': case 'O': return music ? fadeOut : undefined;
    case 'i': case 'I': return music ? fadeIn : undefined;
    case 'ArrowUp': return music ? () => nudgeVolume(5) : undefined;
    case 'ArrowDown': return music ? () => nudgeVolume(-5) : undefined;
    case 'g': case 'G': return edHas('run') && runActive() ? runNext : undefined;
    case '?': return () => { renderKeysDialog(); $('#dlgHelp').showModal(); };
    default: return undefined;
  }
}

/** A number key pressed alone while cues are set to need Shift: say so, at most every few seconds. */
let cueHintAt = 0;
function cueKeyHint(digit, cue) {
  if (Date.now() - cueHintAt < 4000) return;
  cueHintAt = Date.now();
  toast(cue ? `Cues need Shift: Shift + ${digit} runs “${cue.name}”` : `Cues need Shift. There is no cue ${digit}.`, 'info');
}

document.addEventListener('keydown', (e) => {
  if (!S || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest('input, select, textarea') || document.querySelector('dialog[open]') || !$('#login').classList.contains('hidden')) return;
  const action = keyAction(e);
  if (action === undefined) return;
  // Swallowing the key also keeps Enter/Space from "pressing" whichever button was clicked last.
  e.preventDefault();
  // A key held down (or a book resting on the keyboard) repeats; only the level keys should.
  if (e.repeat && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (action) action();
});

// A button that was clicked keeps the keyboard focus, and the next Enter would press it again
// (ending the show a second time, re-running a cue…). Hand the focus back after every click.
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.closest('dialog, .login')) b.blur();
});

// ---------------- misc ----------------

/** Keys dialog: which keys run cues (a setting of the Stagio PC). */
function renderKeysDialog() {
  const shift = !!S?.settings?.cueShift;
  $('#cueKeyText').textContent = shift ? 'Shift + 1 – 9' : '1 – 9';
  for (const b of $$('#cueKeyMode button')) b.classList.toggle('on', (b.dataset.ck === 'shift') === shift);
}
$('#cueKeyMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ck]');
  if (b) post('/api/settings', { cueShift: b.dataset.ck === 'shift' });
});
$('#btnHelp').onclick = () => { renderKeysDialog(); $('#dlgHelp').showModal(); };

// ---------------- layout (desktop) ----------------
// Each operator arranges the console their own way: the dividers between the panels can be
// dragged, panels switched off, the sides swapped. Kept in this browser only (a phone has its
// own), and applied only on wide screens: phones and narrow windows use tabs.
const LAYOUT_KEY = 'onedesk.layout';
const STANDARD_LAYOUT = { sideW: null, musicH: null, prog: null, thumbW: null, swap: false, hide: {} };
const LAYOUT_PRESETS = {
  standard: {},
  program: { sideW: '300px', prog: 3.2 },                               // the projector view as big as it gets
  slides: { hide: { music: true, output: true } },                      // only the slides
  list: { prog: 1.3, thumbW: 170 },                                     // smaller monitors, bigger slide list
};
const PARTS = ['music', 'output', 'side', 'notes', 'strip', 'cues'];
const wideScreen = window.matchMedia('(min-width: 901px)');
let layout = (() => {
  try { const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); if (v) return { ...STANDARD_LAYOUT, ...v, hide: { ...(v.hide || {}) } }; } catch { /* unreadable: standard */ }
  return { ...STANDARD_LAYOUT, hide: {} };
})();
const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* private mode: not kept */ } };

function applyLayout() {
  const css = document.documentElement.style;
  const set = (k, v) => (v == null ? css.removeProperty(k) : css.setProperty(k, v));
  set('--side-w', layout.sideW);
  set('--music-h', layout.musicH);
  set('--prog', layout.prog == null ? null : `${layout.prog}fr`);
  set('--thumb-w', layout.thumbW ? `${layout.thumbW}px` : null);
  const wide = wideScreen.matches;
  document.body.classList.toggle('lay-swap', wide && !!layout.swap);
  for (const part of PARTS) document.body.classList.toggle(`hide-${part}`, wide && !!layout.hide[part]);
  renderLayoutDialog();
}
wideScreen.addEventListener('change', applyLayout);

function renderLayoutDialog() {
  for (const box of $$('#layShow input')) box.checked = !layout.hide[box.dataset.part];
  $('#laySwap').checked = !!layout.swap;
  $('#layThumb').value = layout.thumbW || 124;
  $('#layThumbOut').textContent = `${layout.thumbW || 124}`;
  const norm = (l) => JSON.stringify({ ...STANDARD_LAYOUT, ...l, hide: Object.fromEntries(Object.entries(l.hide || {}).filter(([, v]) => v).sort()) });
  const same = (preset) => norm(preset) === norm(layout);
  for (const b of $$('#layPresets button')) b.classList.toggle('on', same(LAYOUT_PRESETS[b.dataset.preset]));
}

$('#btnLayout').onclick = () => { renderLayoutDialog(); $('#dlgLayout').showModal(); };
$('#layPresets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]');
  if (!b) return;
  const preset = LAYOUT_PRESETS[b.dataset.preset];
  layout = { ...STANDARD_LAYOUT, ...preset, hide: { ...(preset.hide || {}) } };
  // A preset that hides nothing shouldn't leave hidden false-flags around (keeps "same" exact).
  for (const k of Object.keys(layout.hide)) if (!layout.hide[k]) delete layout.hide[k];
  saveLayout(); applyLayout();
});
$('#layShow').addEventListener('change', (e) => {
  const part = e.target.dataset.part;
  if (!part) return;
  if (e.target.checked) delete layout.hide[part]; else layout.hide[part] = true;
  saveLayout(); applyLayout();
});
$('#laySwap').addEventListener('change', (e) => { layout.swap = e.target.checked; saveLayout(); applyLayout(); });
$('#layThumb').addEventListener('input', (e) => {
  layout.thumbW = Number(e.target.value) === 124 ? null : Number(e.target.value);
  applyLayout();
});
$('#layThumb').addEventListener('change', saveLayout);
$('#btnLayoutReset').onclick = () => { layout = { ...STANDARD_LAYOUT, hide: {} }; saveLayout(); applyLayout(); };

/** Drag a divider: `move(event)` gets every pointer move, `reset()` runs on double-click. */
function divider(el, dir, move, reset) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone: the moves still arrive while over the divider */ }
    el.classList.add('dragging');
    document.body.classList.add('resizing', `resizing-${dir}`);
    const onMove = (ev) => move(ev);
    const done = () => {
      el.classList.remove('dragging');
      document.body.classList.remove('resizing', `resizing-${dir}`);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', done);
      el.removeEventListener('pointercancel', done);
      saveLayout();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
  });
  el.addEventListener('dblclick', () => { reset(); saveLayout(); applyLayout(); });
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Slides | Music and Output
divider($('#splitSide'), 'v', (ev) => {
  const r = $('.desk').getBoundingClientRect();
  const w = layout.swap ? ev.clientX - r.left : r.right - ev.clientX;
  layout.sideW = `${Math.round(clamp(w, 280, r.width - 400))}px`;
  applyLayout();
}, () => { layout.sideW = null; });
// Music above Output
divider($('#splitMusic'), 'h', (ev) => {
  const r = $('.sidecol').getBoundingClientRect();
  layout.musicH = `${Math.round(clamp(ev.clientY - r.top, 110, r.height - 115))}px`;
  applyLayout();
}, () => { layout.musicH = null; });
// Program | Preview and notes
divider($('#splitStage'), 'v', (ev) => {
  const r = $('.stage').getBoundingClientRect();
  const left = clamp(ev.clientX - r.left, 220, r.width - 162);
  layout.prog = +(left / Math.max(1, r.width - left - 12)).toFixed(2);
  applyLayout();
}, () => { layout.prog = null; });
applyLayout();
/** Fills the Remote dialog: the normal Wi-Fi way, and the two backups (Stagio Wi-Fi, Bluetooth). */
async function fillRemote(open) {
  let r;
  try { r = await api('/api/remote'); } catch { return; }
  if (!r) return toast('This PC is not connected to a network');
  $('#remoteLan').classList.toggle('hidden', !r.url);
  $('#remoteNoLan').classList.toggle('hidden', !!r.url);
  if (r.url) {
    $('#remoteUrl').textContent = r.url;
    $('#remoteWifi').textContent = r.wifi || 'the same network as this PC';
    $('#remoteOthers').textContent = r.others?.length ? `This PC has more than one network address. If that one doesn't work, try ${r.others.join(' or ')}` : '';
    $('#qr').innerHTML = r.qr;
  }
  $('#remotePin').textContent = r.pin;
  const own = r.own;
  $('#ownWifiOn').classList.toggle('hidden', !own);
  if (own) {
    $('#ownWifiJoinQr').innerHTML = own.joinQr;
    $('#ownWifiOpenQr').innerHTML = own.openQr;
    $('#ownWifiSsid').textContent = own.ssid;
    $('#ownWifiPass').textContent = own.pass;
    $('#ownWifiUrl').textContent = own.url;
  }
  if (r.remotePageQr) { $('#btPageQr').innerHTML = r.remotePageQr; $('#btPageUrl').textContent = S?.links?.remotePage || ''; }
  if (r.stage) {
    $('#stageQr').innerHTML = r.stage.qr || '<p class="dim">Connect this PC to a network (or start Stagio Wi-Fi) first.</p>';
    $('#stageUrl').textContent = r.stage.url || '';
    $('#stagePin').textContent = r.stage.pin;
  }
  renderLinks();
  if (!r.url || own || S?.links?.bluetooth?.on) $('#remoteBackup').open = true;
  if (open) $('#dlgRemote').showModal();
}
$('#btnRemote').onclick = () => fillRemote(true);

/** Stagio Wi-Fi and Bluetooth: on/off state in the Remote dialog (from the live state). */
function renderLinks() {
  const l = S?.links || {};
  const w = l.ownWifi; const b = l.bluetooth;
  $('#ownWifiCard').classList.toggle('hidden', !w);
  $('#hotspotCard').classList.toggle('hidden', !S?.platform?.hotspotGuide);
  $('#btCard').classList.toggle('hidden', !b);
  if (w) {
    $('#ownWifiTag').className = `tag ${w.on ? 'ok' : w.error ? 'warn' : ''}`;
    $('#ownWifiTag').textContent = w.busy ? 'Starting…' : w.on ? 'On' : w.error ? 'Failed' : '';
    $('#ownWifiTag').title = w.error || '';
    $('#btnOwnWifi').textContent = w.on ? 'Stop' : 'Start';
    $('#btnOwnWifi').disabled = !!w.busy;
  }
  if (b) {
    $('#btTag').className = `tag ${b.on ? 'ok' : b.error ? 'warn' : ''}`;
    $('#btTag').textContent = b.busy ? 'Starting…' : b.on ? (b.phones ? `On · ${b.phones} phone${b.phones === 1 ? '' : 's'}` : 'On') : b.error ? 'Failed' : '';
    $('#btTag').title = b.error || '';
    $('#btnBluetooth').textContent = b.on ? 'Stop' : 'Start';
    $('#btnBluetooth').disabled = !!b.busy;
    $('#btOn').classList.toggle('hidden', !b.on);
  }
}
$('#btnOwnWifi').onclick = async () => {
  const on = !S?.links?.ownWifi?.on;
  try { await api('/api/ownWifi', { on }, undefined, 40000); } catch { /* toast shown */ }
  fillRemote(false);
};
$('#btnBluetooth').onclick = async () => {
  const on = !S?.links?.bluetooth?.on;
  try { await api('/api/bluetooth', { on }, undefined, 40000); } catch { /* toast shown */ }
  fillRemote(false);
};
$$('.mnav button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.body.dataset.tab = b.dataset.tab;
  window.scrollTo(0, 0);
}));

// ---------------- phone / tablet: keep the screen on, full screen ----------------
// A remote whose screen locks itself in the middle of a show is no remote. Two ways to stop that:
//   1. the browser's Wake Lock — only offered on secure pages, which a phone on plain
//      http://192.168… is not;
//   2. otherwise a tiny silent video that keeps playing, the way a video player holds the screen.
//      Phones only count a hidden video as playing if it has a sound track, so it gets a silent one.
// Neither is guaranteed on every phone, so the button only lights up when one of them is running.
const pref = {
  get(k) { try { return localStorage.getItem(`onedesk.${k}`); } catch { return null; } },
  set(k, v) { try { if (v) localStorage.setItem(`onedesk.${k}`, v); else localStorage.removeItem(`onedesk.${k}`); } catch { /* private mode */ } },
};
const awake = { want: pref.get('awake') === '1', lock: null, video: null };
const awakeActive = () => !!awake.lock || (!!awake.video && !awake.video.paused);

function renderAwake() {
  const b = $('#btnAwake');
  b.classList.toggle('lit', awakeActive());
  b.title = awakeActive() ? 'This screen stays on. Tap to turn off.' : 'Keep this screen on';
}

function silentVideo() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const g = canvas.getContext('2d');
  let n = 0;
  const draw = () => { g.fillStyle = n++ % 2 ? '#000' : '#010101'; g.fillRect(0, 0, 16, 16); };
  draw();
  setInterval(draw, 1000); // a stream only has frames while the picture changes
  const stream = canvas.captureStream(1);
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0; // a sound track with no sound in it
    const out = ac.createMediaStreamDestination();
    osc.connect(gain).connect(out);
    osc.start();
    stream.addTrack(out.stream.getAudioTracks()[0]);
    awake.audio = ac;
  } catch { /* no sound track: still worth trying */ }
  const v = document.createElement('video');
  v.setAttribute('playsinline', '');
  v.disableRemotePlayback = true;
  v.srcObject = stream;
  v.className = 'awake-video';
  v.addEventListener('pause', renderAwake);
  v.addEventListener('playing', renderAwake);
  document.body.appendChild(v);
  return v;
}

/** Tries to hold the screen on; true if something is now holding it. */
async function awakeOn() {
  if (awakeActive()) return true;
  if (navigator.wakeLock) {
    try {
      awake.lock = await navigator.wakeLock.request('screen');
      awake.lock.addEventListener('release', () => { awake.lock = null; renderAwake(); });
      return true;
    } catch { /* not allowed here: try the video */ }
  }
  try {
    awake.video ||= silentVideo();
    awake.audio?.resume?.();
    await awake.video.play();
    return true;
  } catch { return false; }
}

function awakeOff() {
  awake.lock?.release().catch(() => {});
  awake.lock = null;
  awake.video?.pause();
  awake.audio?.suspend?.();
}

$('#btnAwake').onclick = async () => {
  awake.want = !awakeActive();
  pref.set('awake', awake.want ? '1' : '');
  if (!awake.want) awakeOff();
  else if (!(await awakeOn())) {
    toast('This browser cannot keep the screen on. For the event, set the phone\'s Auto-Lock / Screen timeout to the longest setting.');
  }
  renderAwake();
};
// The hold is dropped whenever the page goes to the background, and starting the video needs a
// tap, so it is picked up again when the page comes back and on the next tap anywhere.
const awakeResume = (e) => {
  if (e?.target?.closest?.('#btnAwake')) return; // the button handles its own taps
  if (awake.want && !document.hidden && !awakeActive()) awakeOn().then(renderAwake);
};
document.addEventListener('visibilitychange', awakeResume);
document.addEventListener('pointerdown', awakeResume);
renderAwake();

// Full screen (hides the browser's bars). iPhones don't offer this to web pages; there, adding
// Stagio to the home screen does the same. Not shown when already opened from the home screen.
const fsRoot = document.documentElement;
const fsRequest = fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen;
const fsExit = document.exitFullscreen || document.webkitExitFullscreen;
const fsNow = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const standalone = window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true;
if (fsRequest && fsExit && (document.fullscreenEnabled || document.webkitFullscreenEnabled) && !standalone && !APP) {
  const b = $('#btnFull');
  b.classList.remove('hidden');
  b.onclick = () => {
    const done = fsNow() ? fsExit.call(document) : fsRequest.call(fsRoot, { navigationUI: 'hide' });
    done?.catch?.(() => toast('This browser did not allow full screen'));
  };
  const sync = () => b.classList.toggle('lit', !!fsNow());
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
}

// ---------------- before the event: one list of what is ready ----------------
// Built from the live state, so it updates while it is open (e.g. images still being prepared).
// ok = ready; warn = have a look; bad = will not work like this; info = fine either way.
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function checkItems() {
  const items = [];
  const add = (state, title, detail, action) => items.push({ state, title, detail, action });
  const p = S.ppt || {};
  const pf = S.platform || {};
  const pres = (p.presentations || []).find((x) => x.path === p.focus);
  const open = { label: 'Open…', run: showOpenDialog };

  // Presentation
  if (!p.running) add('bad', 'Presentation', 'PowerPoint is not running. Open the presentation.', open);
  else if (!pres && p.protectedView) add('bad', 'Presentation', `“${p.protectedView}” is in Protected View (read-only).`, { label: 'Enable editing', run: () => pptSend('/api/ppt/enableEditing', {}, 30000) });
  else if (!pres) add('bad', 'Presentation', 'No presentation open.', open);
  else if (p.busy) add('warn', 'Presentation', `${pres.name} · PowerPoint is not responding right now.`);
  else add('ok', 'Presentation', `${pres.name} · ${plural(pres.slides, 'slide')}${(p.presentations || []).length > 1 ? ` · ${(p.presentations || []).length} files open: check this is the right one` : ''}`);

  if (pres) {
    // Slide images
    const sl = S.slides;
    if (!sl || sl.path !== p.focus) add('warn', 'Slide images', 'Reading the slides…');
    else {
      const total = sl.slides.length;
      const pending = sl.pending || 0;
      if (pending && sl.waitShow) add('warn', 'Slide images', `${total - pending} of ${total} ready; the rest are made after the show.`);
      else if (pending) add('warn', 'Slide images', `${total - pending} of ${total} ready${sl.paused ? ', paused while PowerPoint is in use' : sl.etaSec ? `, ${fmtEta(sl.etaSec)} to go` : ''}.`);
      else if (sl.fonts && !sl.fonts.pdf) add('warn', 'Slide images', `All ${total} ready, but text in them may show in another font (the projector is fine).`);
      else add('ok', 'Slide images', `All ${total} ready.`);
    }
    // Speed in PowerPoint (decorative text that makes PowerPoint for Windows slow)
    const fc = S.fastCopy || {};
    if (fc.available) {
      const openFast = { label: 'Speed up…', run: () => { renderFastDialog(); $('#dlgFast').showModal(); } };
      if (fc.job?.state === 'running') add('warn', 'Speed in PowerPoint', `Speeding up: ${jobLabel(fc.job)}.`);
      else if (fc.slow) add('warn', 'Speed in PowerPoint', `${plural(fc.slow.slides, 'slide')} change slowly (seconds each) in PowerPoint for Windows.`, openFast);
      else if (!fc.checked) add('info', 'Speed in PowerPoint', 'Checking…');
      else add('ok', 'Speed in PowerPoint', 'Nothing in this file slows PowerPoint down.');
    }
  }

  // Run of show (Extra): every part's file there, the countdown with a screen to go to
  if (edHas('run') && S.run) {
    const rs = runShowSel();
    const plan = { label: rs ? 'Edit run…' : 'Plan the run…', run: openRunEditor };
    if (!rs) add('info', 'Run of show', 'No run of show planned for this event.', plan);
    else {
      const missing = rs.parts.filter(partMissing);
      const total = rs.parts.reduce((n, x) => n + (Number(x.minutes) || 0), 0);
      if (!rs.parts.length) add('warn', 'Run of show', `“${rs.name}” has no parts yet.`, plan);
      else if (missing.length) add('bad', 'Run of show', `“${rs.name}”: ${missing[0].file ? `the file for “${missing[0].name}” is not there` : `“${missing[0].name}” has no file chosen`}${missing.length > 1 ? ` (and ${missing.length - 1} more)` : ''}.`, plan);
      else add('ok', 'Run of show', `“${rs.name}”: ${plural(rs.parts.length, 'part')}, planned ${fmtMin(total)}.`);
      if (rs.parts.some((x) => x.kind === 'countdown') && (S.displays?.screens || []).length < 2) {
        add('warn', 'Countdown', 'Only one display: the countdown would open in a window on this screen. Connect the projector and choose Extend.');
      }
    }
  }

  // Projector
  const screens = S.displays?.screens || [];
  if (pf.displayMode !== false) {
    if (screens.length >= 2) {
      const i = screens.findIndex((s) => s.device === p.monitor);
      add('ok', 'Projector', `${screens.length} displays (Extend). Slides go to ${i >= 0 ? `Display ${i + 1}` : 'the display PowerPoint picks'}.`);
    } else {
      add('warn', 'Projector', 'Only one display. Connect the projector and choose Extend, so the slides go there and Stagio stays on this screen. (Duplicate also shows as one display.)',
        p.show || !edHas('displayMode') ? null : { label: 'Extend', run: () => post('/api/display/mode', { mode: 'extend' }) });
    }
    if (pf.presenterView && screens.length >= 2) {
      if (S.settings?.hidePresenterView) add('ok', 'Presenter View', 'PowerPoint\'s Presenter View stays away from this screen.');
      else add('warn', 'Presenter View', 'PowerPoint\'s Presenter View will cover Stagio when the show starts.', { label: 'Hide it', run: () => post('/api/settings', { hidePresenterView: true }) });
    }
  }

  // Sound (not in Lite)
  const a = S.audio || {};
  const dev = (a.devices || []).find((d) => d.isDefault);
  if (!edHas('audio')) { /* Lite: sound is left to the computer */ }
  else if (a.error || !dev) add('bad', 'Sound', a.error || 'No sound device found.');
  else if (a.mute) add('warn', 'Sound', `${dev.name} · muted`, { label: 'Unmute', run: () => post('/api/audio/mute', { mute: false }) });
  else if (a.volume != null && a.volume < 15) add('warn', 'Sound', `${dev.name} · level ${a.volume}, very low`);
  else add('ok', 'Sound', `${dev.name}${a.volume != null ? ` · level ${a.volume}` : ''}`);

  // Music (not in Lite)
  const mode = musicMode();
  if (!edHas('music')) { /* Lite */ }
  else if (mode === 'off') add('info', 'Music', 'Music control is off.');
  else {
    const lm = S.localMusic || {};
    const name = lm.app?.name || lm.lastApp?.name || 'the music app';
    const open = lm.lastApp ? { label: `Open ${lm.lastApp.name}`, run: () => post('/api/music/launch') } : undefined;
    if (!lm.running) add('warn', 'Music', lm.pinned ? `${name} is not open.` : 'No app is playing music on this PC. Start the music in your player once (pausing afterwards is fine).', open);
    else if (!lm.session) add('warn', 'Music', `${name} is open, but Stagio can't control it yet: start the music once (pausing afterwards is fine).`);
    else add('ok', 'Music', `${lm.title || name}${lm.artist ? ` · ${lm.artist}` : ''} · ${lm.app?.name ? `${lm.app.name} · ` : ''}${lm.isPlaying ? 'playing' : 'paused'}`);
  }

  // Cues that run by themselves in this presentation
  const mine = (S.cues || []).filter((c) => c.auto && pres && sameDeck(c.auto.deck, p.focus));
  const sl = S.slides;
  const lost = mine.filter((c) => sl && sameDeck(sl.path, p.focus) && !sl.slides.some((s) => s.id === c.auto.slideId));
  if (!edHas('cues')) { /* Lite */ }
  else if (!mine.length) add('info', 'Cues', `${plural((S.cues || []).length, 'cue')}; none is set to run by itself at a slide here (cues named in speaker notes are not counted).`);
  else if (!S.settings?.autoCues) add('warn', 'Cues', `${plural(mine.length, 'cue')} should run by themselves at a slide, but Auto is off.`, { label: 'Turn Auto on', run: () => post('/api/settings', { autoCues: true }) });
  else if (lost.length) add('warn', 'Cues', `“${lost[0].name}” was bound to a slide that has been deleted.`, { label: 'Edit cues', run: () => $('#btnEditCues').click() });
  else add('ok', 'Cues', `${plural(mine.length, 'cue')} run by themselves in this presentation.`);

  // Phones (over Wi-Fi, and over Bluetooth)
  const n = S.remotes || 0;
  const btPhones = S.links?.bluetooth?.on ? S.links.bluetooth.phones || 0 : 0;
  const backups = [S.links?.ownWifi?.on ? 'Stagio Wi-Fi is on' : '', S.links?.bluetooth?.on ? 'Bluetooth is on' : ''].filter(Boolean).join(' · ');
  if (n || btPhones) add('ok', 'Remote', `${[n ? plural(n, 'phone or tablet', 'phones or tablets') : '', btPhones ? `${plural(btPhones, 'phone')} on Bluetooth` : ''].filter(Boolean).join(' and ')} connected.${backups ? ` ${backups}.` : ''}`);
  else add('info', 'Remote', `No phone connected.${backups ? ` ${backups}.` : ''}`, isPC ? { label: 'Connect…', run: () => $('#btnRemote').click() } : null);
  if (edHas('stage') && S.stage) {
    const n = S.stage.screens || 0;
    add(n ? 'ok' : 'info', 'Stage display', n ? `${plural(n, 'stage display')} connected.` : 'No stage display connected (optional: a phone or tablet on the lectern for the speaker).', isPC && !n ? { label: 'Connect…', run: () => fillRemote(true) } : null);
  }
  return items;
}

let checkActions = [];
function renderCheck() {
  if (!S) return;
  const items = checkItems();
  const attention = items.filter((x) => x.state === 'warn' || x.state === 'bad').length;
  const b = $('#btnCheck');
  b.classList.toggle('lit', !attention);
  b.classList.toggle('attn', !!attention);
  b.textContent = attention ? `Check · ${attention}` : 'Check';
  b.title = attention ? `${plural(attention, 'thing')} to look at before the event` : 'Everything Stagio can check is ready';
  if (!$('#dlgCheck').open) return;
  checkActions = items.map((x) => x.action?.run || null);
  const html = items.map((x, i) => `
    <div class="ck-row ${x.state}">
      <i></i>
      <div class="ck-txt"><b>${esc(x.title)}</b><span>${esc(x.detail)}</span></div>
      ${x.action ? `<button class="btn sm" data-check="${i}">${esc(x.action.label)}</button>` : ''}
    </div>`).join('');
  const list = $('#checkList');
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
}
$('#btnCheck').onclick = () => { $('#dlgCheck').showModal(); renderCheck(); };
$('#checkList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-check]');
  const run = b && checkActions[Number(b.dataset.check)];
  if (!run) return;
  // Actions that open another dialog close this one first (one dialog at a time).
  if (/Open|Speed up|Edit cues|Connect|run…/.test(b.textContent)) $('#dlgCheck').close();
  run();
});

// ---------------- notes text size (per device) ----------------
// Read from a lectern or across the room, notes may need to be much bigger than on the PC.
const NOTE_SIZES = [11, 12, 13, 15, 17, 20, 24, 28, 34, 40];
let noteSize = NOTE_SIZES.includes(Number(pref.get('notesSize'))) ? Number(pref.get('notesSize')) : 13;
function applyNoteSize() {
  document.documentElement.style.setProperty('--notes-size', `${noteSize}px`);
  $('#notesSmaller').disabled = noteSize <= NOTE_SIZES[0];
  $('#notesBigger').disabled = noteSize >= NOTE_SIZES[NOTE_SIZES.length - 1];
  $('#notesSmaller').title = `Smaller notes text (now ${noteSize})`;
  $('#notesBigger').title = `Bigger notes text (now ${noteSize})`;
}
function stepNoteSize(dir) {
  const i = NOTE_SIZES.indexOf(noteSize);
  noteSize = NOTE_SIZES[Math.max(0, Math.min(NOTE_SIZES.length - 1, i + dir))];
  pref.set('notesSize', noteSize === 13 ? '' : String(noteSize));
  applyNoteSize();
}
$('#notesSmaller').onclick = () => stepNoteSize(-1);
$('#notesBigger').onclick = () => stepNoteSize(1);
applyNoteSize();

// ---------------- settings (this device) ----------------
// Phones: the top bar and the four slide buttons stay on screen while scrolling (default); each
// can be switched off to give the slides more room.
const deviceSettings = {
  fixedBar: pref.get('fixedBar') !== '0',
  fixedButtons: pref.get('fixedButtons') !== '0',
};
function applyDeviceSettings() {
  document.body.classList.toggle('bar-scrolls', !deviceSettings.fixedBar);
  document.body.classList.toggle('buttons-scroll', !deviceSettings.fixedButtons);
  $('#setFixedBar').checked = deviceSettings.fixedBar;
  $('#setFixedButtons').checked = deviceSettings.fixedButtons;
  $('#setNotesSize').textContent = noteSize;
}
$('#setFixedBar').addEventListener('change', (e) => { deviceSettings.fixedBar = e.target.checked; pref.set('fixedBar', e.target.checked ? '' : '0'); applyDeviceSettings(); });
$('#setFixedButtons').addEventListener('change', (e) => { deviceSettings.fixedButtons = e.target.checked; pref.set('fixedButtons', e.target.checked ? '' : '0'); applyDeviceSettings(); });
$('#dlgSettings').addEventListener('click', (e) => {
  const b = e.target.closest('[data-notes-size]');
  if (b) { stepNoteSize(Number(b.dataset.notesSize)); applyDeviceSettings(); }
});
const openSettings = () => {
  applyDeviceSettings();
  $('#macCheckBox').classList.toggle('hidden', !(isPC && S?.platform?.macCheck));
  $('#dlgSettings').showModal();
};
$('#btnMacCheck').onclick = async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = 'Checking…';
  try {
    const text = await api('/api/mac/check', undefined, 'GET', 120000);
    $('#macCheckOut').value = text;
    $('#macCheckOut').classList.remove('hidden');
    $('#btnMacCheckCopy').classList.remove('hidden');
  } catch { /* toast shown */ } finally { b.disabled = false; b.textContent = 'Run Mac check'; }
};
$('#btnMacCheckCopy').onclick = async () => {
  const t = $('#macCheckOut');
  try { await navigator.clipboard.writeText(t.value); toast('Copied', 'info'); } catch { t.select(); document.execCommand('copy'); toast('Copied', 'info'); }
};
$('#btnSettings').onclick = openSettings;
$('.mnav [data-settings]').onclick = openSettings;
applyDeviceSettings();

// ---------------- run of show (Extra) ----------------
// The bar under the header: the parts of the event, the one on now, how long it has left, and how
// far ahead or behind the whole event is. "Next part" (or G) goes on; the server does the rest.

const RUN_KINDS = { slides: 'Slides', countdown: 'Countdown', music: 'Music', manual: 'Manual' };
let runSel = pref.get('runShow') || '';
const runShows = () => S?.run?.shows || [];
const runActive = () => S?.run?.active || null;
function runShowSel() {
  const a = runActive();
  const list = runShows();
  return list.find((s) => s.id === (a ? a.showId : runSel)) || list[0] || null;
}
const fmtMin = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`);
const partMissing = (p) => p.kind === 'slides' && (!p.file || S?.run?.files?.[p.file] === false);

function partTitle(p) {
  const bits = [RUN_KINDS[p.kind]];
  if (p.minutes) bits.push(`${p.minutes} min planned`);
  if (p.kind === 'slides') bits.push(p.file ? `${fileName(p.file)}${p.slide > 1 ? ` from slide ${p.slide}` : ''}${S.run.files?.[p.file] === false ? ' · FILE NOT FOUND' : ''}` : 'no file chosen');
  if (p.kind === 'countdown') bits.push(p.until ? `to ${p.until}` : 'countdown');
  return bits.join(' · ');
}

function renderRun() {
  if (!edHas('run') || !S.run) return;
  const a = runActive();
  const show = runShowSel();
  const sel = $('#runSelect');
  const opts = runShows().map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('') || '<option value="">No run of show yet</option>';
  if (sel.dataset.html !== opts) { sel.innerHTML = opts; sel.dataset.html = opts; }
  sel.value = show?.id || '';
  sel.disabled = !!a;
  $('#btnRunStart').classList.toggle('hidden', !!a || !show?.parts.length);
  for (const id of ['#btnRunPrev', '#btnRunNext', '#btnRunStop', '#runNow']) $(id).classList.toggle('hidden', !a);
  if (a && show) {
    const nx = show.parts[a.index + 1];
    $('#btnRunNext').disabled = !nx || a.busy;
    $('#btnRunNext').title = nx ? `Next: ${nx.name} (G)` : 'This is the last part';
    $('#btnRunPrev').disabled = a.index <= 0 || a.busy;
  }
  const open = new Set(S.run.open || []);
  const html = (show?.parts || []).map((p, i) => {
    const st = !a ? '' : i < a.index ? ' done' : i === a.index ? ' now' : '';
    return `<button class="rp${st}${partMissing(p) ? ' miss' : ''}${open.has(p.id) && (!a || i > a.index) ? ' ready' : ''}" data-part="${i}" title="${esc(partTitle(p))}${open.has(p.id) ? ' · open in PowerPoint' : ''}">
      <span class="rk">${i + 1}</span><span class="rn">${esc(p.name)}</span>${p.minutes ? `<span class="rm mono">${p.minutes}′</span>` : ''}</button>`;
  }).join('') || '<span class="dim">No parts yet. Edit… to plan the event.</span>';
  const box = $('#runParts');
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
    box.querySelector('.now')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  const cdNow = a && show?.parts[a.index]?.kind === 'countdown';
  const msg = a?.error ? ['bad', a.error]
    : a?.busy ? ['', 'Starting the part…']
      : a?.note ? ['warn', a.note]
        : cdNow && a.screen === 'window' ? ['warn', 'Only one screen: the countdown is in a window on this screen. With the projector in Extend it fills the projector.']
          : cdNow && a.screen === 'none' ? ['warn', 'The countdown screen needs the Stagio app (not a browser window).']
            : null;
  const m = $('#runMsg');
  m.classList.toggle('hidden', !msg);
  if (msg) { m.className = `run-msg ${msg[0]}`; m.textContent = msg[1]; }
  renderRunTimes();
}

/** The live part of the bar: time left in this part, ahead/behind for the whole event. */
function renderRunTimes() {
  const a = runActive();
  if (!a || !edHas('run')) return;
  const show = runShowSel();
  const part = show?.parts[a.index];
  if (!part) return;
  const now = Date.now() + clockOffset;
  const planned = a.planned[a.index] || 0;
  const elapsed = now - a.segAt;
  let left;
  let cls = '';
  if (part.kind === 'countdown' && a.countdown) left = `${fmtDur(Math.max(0, Math.ceil((a.countdown.target - now) / 1000) * 1000))} to go`;
  else if (planned) {
    const rest = planned - elapsed;
    left = rest >= 0 ? `${fmtDur(rest)} left` : `${fmtDur(-rest)} over`;
    if (rest < 0) cls = rest < -120000 ? 'late' : 'over';
  } else left = fmtDur(elapsed);
  $('#runNowName').textContent = `${a.index + 1}/${show.parts.length} ${part.name}`;
  const l = $('#runLeft');
  l.textContent = left;
  l.className = `mono ${cls}`;
  // Behind = started this part later than planned, plus whatever it has run over.
  const behind = (a.segAt - a.startedAt) - a.plannedBefore + (planned ? Math.max(0, elapsed - planned) : 0);
  const d = $('#runDelta');
  if (Math.abs(behind) < 30000) { d.textContent = 'on time'; d.className = 'mono run-delta ok'; } else {
    d.textContent = behind > 0 ? `${fmtDur(behind)} behind` : `${fmtDur(-behind)} ahead`;
    d.className = `mono run-delta ${behind > 120000 ? 'late' : behind > 0 ? 'over' : 'ok'}`;
  }
}

const runNext = () => post('/api/run/next', {}, VERY_SLOW);
$('#runSelect').addEventListener('change', (e) => { runSel = e.target.value; pref.set('runShow', runSel); renderRun(); });
$('#btnRunStart').onclick = () => { const s = runShowSel(); if (s) post('/api/run/start', { showId: s.id, index: 0 }, VERY_SLOW); };
$('#btnRunNext').onclick = runNext;
$('#btnRunPrev').onclick = (e) => { if (confirmTap(e.currentTarget, 'Back?')) post('/api/run/prev', {}, VERY_SLOW); };
$('#btnRunStop').onclick = (e) => { if (confirmTap(e.currentTarget, 'Stop run?')) post('/api/run/stop'); };
// A part clicked directly: two clicks (the first asks), so a stray click changes nothing.
$('#runParts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-part]');
  if (!b || !confirmTap(b, 'Go here?')) return;
  const i = Number(b.dataset.part);
  if (runActive()) post('/api/run/go', { index: i }, VERY_SLOW);
  else { const s = runShowSel(); if (s) post('/api/run/start', { showId: s.id, index: i }, VERY_SLOW); }
});

// ---- editor ----
let runDraft = [];
let runEdIdx = 0;
const newPartOf = (kind, name) => ({
  id: `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
  name, kind, minutes: { countdown: 10, slides: 20, music: 5, manual: 10 }[kind], cue: '',
  ...(kind === 'slides' ? { file: '', slide: 1, musicOut: { on: true, seconds: 4 } } : {}),
  ...(kind === 'countdown' ? { until: '', title: 'Starting soon', notices: [], fadeOut: 5, autoNext: true } : {}),
  ...(kind === 'countdown' || kind === 'music' ? { musicIn: { on: kind === 'music', volume: 60, seconds: 4 } } : {}),
  ...(kind === 'music' ? { black: true } : {}),
});
/** A first run to start from: the usual shape of an event, to change and fill in. */
function starterRun() {
  const welcome = newPartOf('slides', 'Welcome');
  welcome.file = S.ppt?.focus || '';
  welcome.minutes = 5;
  const cd = newPartOf('countdown', 'Countdown');
  cd.musicIn.on = true;
  return {
    id: `r${Date.now().toString(36)}`,
    name: 'My event',
    parts: [cd, welcome, newPartOf('slides', 'Speaker'), newPartOf('music', 'Break'), newPartOf('slides', 'Second speaker'), newPartOf('music', 'Closing music')],
  };
}

function runFileOptions() {
  const paths = [...new Set([...(S.ppt?.presentations || []).map((p) => p.path), ...(S.recent || []).map((r) => r.path)])];
  return paths.map((p) => `<option value="${esc(p)}">`).join('');
}

function partFields(p, i) {
  const f = (path) => `data-pi="${i}" data-f="${path}"`;
  const num = (path, v, min, max, w = '') => `<input type="number" class="mono${w}" ${f(path)} value="${esc(v)}" min="${min}" max="${max}">`;
  const chk = (path, v, label) => `<label class="check"><input type="checkbox" ${f(path)} ${v ? 'checked' : ''}> ${label}</label>`;
  const music = edHas('music');
  const musicIn = (p.musicIn && music) ? `<div class="pf-row">${chk('musicIn.on', p.musicIn.on, 'Bring music in to')} ${num('musicIn.volume', p.musicIn.volume, 0, 100)} <span class="dim">over</span> ${num('musicIn.seconds', p.musicIn.seconds, 1, 30)} <span class="dim">s</span></div>` : '';
  let body = '';
  if (p.kind === 'slides') {
    const missing = p.file && S.run?.files?.[p.file] === false;
    body = `<div class="pf-row">
        <span class="label">File</span>
        <input type="text" class="mono grow-in" list="runFiles" ${f('file')} value="${esc(p.file)}" placeholder="Choose from the list, or paste the file's path">
        ${APP ? `<button class="btn sm" data-browse="${i}">Browse…</button>` : ''}
        ${S.ppt?.focus ? `<button class="btn sm" data-usecur="${i}" title="${esc(S.ppt.focus)}">Use the open one</button>` : ''}
      </div>
      ${missing ? '<div class="warn-text">This file is not there (moved, renamed or on a disconnected drive).</div>' : ''}
      <div class="pf-row"><span class="label">From slide</span> ${num('slide', p.slide, 1, 9999)}
        ${music ? `${chk('musicOut.on', p.musicOut?.on, 'Fade the music out over')} ${num('musicOut.seconds', p.musicOut?.seconds ?? 4, 1, 30)} <span class="dim">s</span>` : ''}</div>`;
  } else if (p.kind === 'countdown') {
    body = `<div class="pf-row"><span class="label">Until</span> <input type="time" class="mono" ${f('until')} value="${esc(p.until)}"> <span class="dim">clock time; leave empty to count down the planned minutes</span></div>
      <div class="pf-row"><span class="label">Title</span> <input type="text" class="grow-in" ${f('title')} value="${esc(p.title)}" placeholder="Starting soon"></div>
      <div class="pf-row top"><span class="label">Notices</span> <textarea rows="2" class="grow-in" ${f('notices')} placeholder="One per line; they take turns under the countdown">${esc((p.notices || []).join('\n'))}</textarea></div>
      ${musicIn}
      <div class="pf-row">${music ? `<span class="dim">Music fades out to end at zero, over</span> ${num('fadeOut', p.fadeOut, 0, 30)} <span class="dim">s (0: no fade)</span>` : ''} ${chk('autoNext', p.autoNext, 'At zero, go on to the next part')}</div>`;
  } else if (p.kind === 'music') {
    body = `<div class="pf-row">${chk('black', p.black, 'Black screen (if a slide show is up)')}</div>${musicIn}`;
  } else {
    body = '<div class="pf-row dim">Only timed: nothing changes on screen.</div>';
  }
  const cues = edHas('cues') ? S.cues || [] : [];
  const cueSel = cues.length ? `<div class="pf-row"><span class="label">Also run cue</span> <select ${f('cue')}><option value="">None</option>${cues.map((c) => `<option value="${esc(c.id)}" ${c.id === p.cue ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>` : '';
  return body + cueSel;
}

function renderRunEditor() {
  const sel = $('#runEdSelect');
  sel.innerHTML = runDraft.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('');
  sel.value = String(runEdIdx);
  const show = runDraft[runEdIdx];
  $('#runEdName').value = show ? show.name : '';
  for (const id of ['#runEdName', '#btnRunDup', '#btnRunDel', '#btnRunAddPart', '#runEdSelect']) $(id).disabled = !show;
  $('#runFiles').innerHTML = runFileOptions();
  const kindOpts = (k) => Object.entries(RUN_KINDS).map(([v, l]) => `<option value="${v}" ${v === k ? 'selected' : ''}>${l}</option>`).join('');
  $('#runEditor').innerHTML = !show ? '<p class="dim">No run of show yet. New starts one with the usual parts of an event.</p>' : show.parts.map((p, i) => `
    <div class="cue-card part-card kind-${p.kind}">
      <div class="head">
        <span class="mono dim">${i + 1}</span>
        <input type="text" data-pi="${i}" data-f="name" value="${esc(p.name)}">
        <select data-pi="${i}" data-f="kind">${kindOpts(p.kind)}</select>
        <input type="number" class="mono" data-pi="${i}" data-f="minutes" value="${esc(p.minutes)}" min="0" max="600" title="Planned minutes"><span class="dim">min</span>
        <button class="btn sm" data-move="${i}:-1" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button class="btn sm" data-move="${i}:1" ${i === show.parts.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button class="btn sm" data-del-part="${i}">Remove</button>
      </div>
      ${partFields(p, i)}
    </div>`).join('');
  const total = show ? show.parts.reduce((n, p) => n + (Number(p.minutes) || 0), 0) : 0;
  $('#runEdTotal').textContent = show ? `${show.parts.length} parts · planned ${fmtMin(total)}` : '';
}

function openRunEditor() {
  runDraft = JSON.parse(JSON.stringify(runShows()));
  const cur = runShowSel();
  runEdIdx = Math.max(0, runDraft.findIndex((s) => s.id === cur?.id));
  renderRunEditor();
  $('#dlgRun').showModal();
}
$('#btnRunEdit').onclick = openRunEditor;
$('#btnRunCancel').onclick = () => $('#dlgRun').close();
$('#btnRunSave').onclick = async () => {
  try {
    await api('/api/run/shows', runDraft, 'PUT');
    if (runDraft[runEdIdx] && !runActive()) { runSel = runDraft[runEdIdx].id; pref.set('runShow', runSel); }
    $('#dlgRun').close();
    toast('Run of show saved', 'info');
  } catch { /* toast shown */ }
};
$('#runEdSelect').addEventListener('change', (e) => { runEdIdx = Number(e.target.value); renderRunEditor(); });
$('#runEdName').addEventListener('input', (e) => { if (runDraft[runEdIdx]) { runDraft[runEdIdx].name = e.target.value; $('#runEdSelect').options[runEdIdx].textContent = e.target.value; } });
$('#btnRunNew').onclick = () => { runDraft.push(starterRun()); runEdIdx = runDraft.length - 1; renderRunEditor(); };
$('#btnRunDup').onclick = () => {
  const s = runDraft[runEdIdx];
  if (!s) return;
  const copy = JSON.parse(JSON.stringify(s));
  copy.id = `r${Date.now().toString(36)}`;
  copy.name = `${s.name} (copy)`;
  copy.parts.forEach((p, i) => { p.id = `p${Date.now().toString(36)}${i}`; });
  runDraft.push(copy);
  runEdIdx = runDraft.length - 1;
  renderRunEditor();
};
$('#btnRunDel').onclick = (e) => {
  if (!runDraft[runEdIdx] || !confirmTap(e.currentTarget, 'Delete it?')) return;
  runDraft.splice(runEdIdx, 1);
  runEdIdx = Math.max(0, runEdIdx - 1);
  renderRunEditor();
};
$('#btnRunAddPart').onclick = () => {
  const s = runDraft[runEdIdx];
  if (!s) return;
  s.parts.push(newPartOf('slides', `Part ${s.parts.length + 1}`));
  renderRunEditor();
  $('#runEditor').lastElementChild?.scrollIntoView({ block: 'nearest' });
};
function setPartField(t) {
  const p = runDraft[runEdIdx]?.parts[Number(t.dataset.pi)];
  if (!p) return false;
  const path = t.dataset.f.split('.');
  let v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
  if (path[0] === 'notices') v = String(v).split('\n');
  if (path[0] === 'kind') {
    const fresh = newPartOf(v, p.name);
    Object.keys(p).forEach((k) => delete p[k]);
    Object.assign(p, fresh, { id: fresh.id });
    return true; // redraw: other fields
  }
  let o = p;
  for (const k of path.slice(0, -1)) o = (o[k] ||= {});
  o[path[path.length - 1]] = v;
  return false;
}
$('#runEditor').addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.f === undefined || t.dataset.f === 'kind') return;
  setPartField(t);
  if (t.dataset.f === 'minutes') {
    const s = runDraft[runEdIdx];
    $('#runEdTotal').textContent = `${s.parts.length} parts · planned ${fmtMin(s.parts.reduce((n, p) => n + (Number(p.minutes) || 0), 0))}`;
  }
});
$('#runEditor').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.f === undefined) return;
  if (setPartField(t) || t.dataset.f === 'file') renderRunEditor();
});
$('#runEditor').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const s = runDraft[runEdIdx];
  if (t.dataset.move) {
    const [i, d] = t.dataset.move.split(':').map(Number);
    const [p] = s.parts.splice(i, 1);
    s.parts.splice(i + d, 0, p);
    renderRunEditor();
  } else if (t.dataset.delPart !== undefined) {
    if (!confirmTap(t, 'Remove?')) return;
    s.parts.splice(Number(t.dataset.delPart), 1);
    renderRunEditor();
  } else if (t.dataset.browse !== undefined) {
    const picked = await APP.pickDeck().catch(() => null);
    if (picked) { s.parts[Number(t.dataset.browse)].file = picked; renderRunEditor(); }
  } else if (t.dataset.usecur !== undefined) {
    s.parts[Number(t.dataset.usecur)].file = S.ppt.focus;
    renderRunEditor();
  }
});

// ---------------- stage display (Extra) ----------------
// Messages to the speaker's screen ("5 minutes left"), and whether they have been seen.

function renderStage() {
  const st = S?.stage;
  if (!edHas('stage') || !st) return;
  const m = st.message;
  const b = $('#btnStage');
  b.textContent = st.screens ? `Stage · ${st.screens}` : 'Stage';
  b.classList.toggle('attn', !!m && !m.ackAt);
  b.classList.toggle('lit', !!m && !!m.ackAt);
  b.title = m ? `“${m.text}” · ${m.ackAt ? 'seen' : 'not seen yet'}` : `Stage display: ${st.screens ? `${st.screens} connected` : 'none connected'}`;
  if (!$('#dlgStage').open) return;
  $('#stageScreens').textContent = st.screens
    ? `${st.screens} stage display${st.screens === 1 ? '' : 's'} connected.`
    : 'No stage display connected. Use “Connect a stage display…” below, then scan the code with the speaker\'s phone or tablet.';
  $('#stageNow').classList.toggle('hidden', !m);
  if (m) {
    $('#stageMsgText').textContent = m.text;
    const t = new Date(m.at);
    const sent = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const tag = $('#stageMsgState');
    tag.textContent = m.ackAt ? `Seen · sent ${sent}` : `Not seen yet · sent ${sent}`;
    tag.className = `tag ${m.ackAt ? 'ok' : 'warn'}`;
  }
  const html = st.presets.map((p, i) => `<button class="btn" data-preset="${i}">${esc(p)}</button>`).join('');
  const box = $('#stagePresets');
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  $('#stageCanFlip').checked = !!st.canFlip;
}
const stageSend = (text) => post('/api/stage/message', { text });
$('#btnStage').onclick = () => {
  $('#stagePresetText').value = (S?.stage?.presets || []).join('\n');
  $('#dlgStage').showModal();
  renderStage();
};
$('#stagePresets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]');
  if (b) stageSend(S.stage.presets[Number(b.dataset.preset)]);
});
$('#stageForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#stageText').value.trim();
  if (!t) return;
  stageSend(t).then((r) => { if (r) $('#stageText').value = ''; });
});
$('#btnStageClear').onclick = () => post('/api/stage/clear');
$('#btnStagePresets').onclick = async () => {
  const list = $('#stagePresetText').value.split('\n').map((x) => x.trim()).filter(Boolean);
  try { await api('/api/stage/presets', list, 'PUT'); $('#stagePresetEdit').open = false; toast('Messages saved', 'info'); } catch { /* toast shown */ }
};
$('#stageCanFlip').addEventListener('change', (e) => post('/api/settings', { stageCanFlip: e.target.checked }));
$('#btnStageCode').onclick = () => { $('#dlgStage').close(); fillRemote(true).then(() => $('#stageCard').scrollIntoView({ block: 'nearest' })); };

// ---------------- show timer ----------------
// Show: since the show started. Slide: since this slide came up. Segment: since the show started,
// the last cue ran, or the operator restarted it (two clicks). Counted on the Stagio PC's clock.
const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};
function renderTimers() {
  const t = S?.timer;
  const live = !!S?.ppt?.show && !!t?.showAt;
  for (const box of $$('[data-timers]')) box.classList.toggle('hidden', !live);
  if (!live) return;
  const now = Date.now() + clockOffset;
  const name = t.segBy ? t.segBy : 'Segment';
  for (const box of $$('[data-timers]')) {
    $('[data-t=show]', box).textContent = `${t.showApprox ? '≥ ' : ''}${fmtDur(now - t.showAt)}`;
    $('[data-t=slide]', box).textContent = t.slideAt ? fmtDur(now - t.slideAt) : '–';
    $('[data-t=seg]', box).textContent = t.segAt ? fmtDur(now - t.segAt) : '–';
    const seg = $('[data-seg]', box);
    if (!seg.classList.contains('armed')) {
      $('[data-t=segName]', box).textContent = name;
      seg.title = `${t.segBy ? `Since cue “${t.segBy}”` : 'Since the show started or the last restart'}. Click twice to restart it.`;
    }
    $('[data-t=show]', box).parentElement.title = t.showApprox ? 'The show was already running when Stagio started, so it has been running at least this long.' : 'Since the show started';
  }
}
document.addEventListener('click', (e) => {
  const seg = e.target.closest('[data-seg]');
  if (!seg) return;
  if (seg.classList.contains('armed')) {
    clearTimeout(seg.disarm);
    seg.classList.remove('armed');
    post('/api/timer/segment');
    return;
  }
  seg.classList.add('armed');
  $('[data-t=segName]', seg).textContent = 'Restart?';
  seg.disarm = setTimeout(() => { seg.classList.remove('armed'); renderTimers(); }, 3000);
});

function tick() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('#clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  renderTimers();
  renderRunTimes();
}
setInterval(tick, 1000);
tick();
start();
