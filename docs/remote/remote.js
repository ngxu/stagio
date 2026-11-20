// Stagio Bluetooth remote: talks to the Stagio PC over Bluetooth Low Energy (Web Bluetooth,
// Chrome on Android). The PC is the peripheral (see "Bluetooth remote" in ps/helper.ps1):
//   command  (write): {"pin":"123456","c":"next"}   every command carries the PIN
//   state    (read, notify): {"s":3,"t":40,"st":"running","b":"1/3","mu":1,"f":"","a":12}
//   cues     (read): ["Opening", "Break", ...]
'use strict';
const SVC = '6f6e6564-6573-6b00-0000-000000000001';
const CMD = '6f6e6564-6573-6b00-0000-000000000002';
const STATE = '6f6e6564-6573-6b00-0000-000000000003';
const CUES = '6f6e6564-6573-6b00-0000-000000000004';

const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { return localStorage.getItem(`stagio.bt.${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`stagio.bt.${k}`, v); } catch { /* private mode */ } },
};
const dec = new TextDecoder();
const enc = new TextEncoder();

let device = null;
let cmdChar = null;
let state = {};
let wantConnected = false;
let busy = false;

function setConn(cls, text) {
  $('#conn').className = `st ${cls}`;
  $('#conn em').textContent = text;
}
function msg(el, text, bad = true) { const m = $(el); m.textContent = text || ''; m.classList.toggle('bad', !!bad); }

// ---- connecting ----

async function connect(choose) {
  if (busy) return;
  const pin = $('#pin').value.trim();
  if (!/^\d{6}$/.test(pin)) { msg('#msg', 'Enter the 6-digit PIN shown on the Stagio computer.'); return; }
  store.set('pin', pin);
  busy = true;
  msg('#msg', '');
  try {
    if (choose || !device) {
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }] });
      device.addEventListener('gattserverdisconnected', onDisconnected);
    }
    wantConnected = true;
    setConn('warn', 'Connecting…');
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    cmdChar = await svc.getCharacteristic(CMD);
    const stateChar = await svc.getCharacteristic(STATE);
    const cuesChar = await svc.getCharacteristic(CUES);
    stateChar.addEventListener('characteristicvaluechanged', (e) => render(read(e.target.value)));
    await stateChar.startNotifications();
    render(read(await stateChar.readValue()));
    renderCues(read(await cuesChar.readValue()) || []);
    setConn('ok', device.name || 'Connected');
    $('#setup').classList.add('hidden');
    $('#live').classList.remove('hidden');
    checkPin();
  } catch (e) {
    if (e.name === 'NotFoundError') msg('#msg', 'No Stagio computer chosen. On the computer, check that Bluetooth is started (Remote → No Wi-Fi…? → Bluetooth).');
    else msg('#msg', `Could not connect: ${e.message}`);
    setConn('bad', 'Not connected');
    wantConnected = false;
  } finally { busy = false; }
}

function read(view) {
  try { return JSON.parse(dec.decode(view)); } catch { return null; }
}

// Out of range, PC asleep, Stagio closed: try again every few seconds while the page is open.
function onDisconnected() {
  setConn('bad', 'Connection lost · retrying');
  cmdChar = null;
  if (!wantConnected) return;
  setTimeout(async function retry() {
    if (!wantConnected || cmdChar) return;
    try { await connect(false); } catch { /* next try */ }
    if (!cmdChar && wantConnected) setTimeout(retry, 3000);
  }, 1500);
}

// ---- commands ----

async function send(c, extra = {}) {
  if (!cmdChar) { msg('#liveMsg', 'Not connected'); return false; }
  try {
    await cmdChar.writeValueWithResponse(enc.encode(JSON.stringify({ pin: store.get('pin'), c, ...extra })));
    return true;
  } catch (e) {
    msg('#liveMsg', `Not sent: ${e.message}`);
    return false;
  }
}

// The PC ignores commands with a wrong PIN; its count of accepted commands ("a") shows whether
// ours got through.
async function checkPin() {
  const before = state.a;
  await send('hello');
  setTimeout(() => {
    if (state.a === before) {
      msg('#liveMsg', 'The computer did not accept the PIN. Check the PIN under Remote on the computer.');
      $('#setup').classList.remove('hidden');
    } else msg('#liveMsg', '');
  }, 1500);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  if (navigator.vibrate) navigator.vibrate(15);
  send(b.dataset.c, b.dataset.n ? { n: Number(b.dataset.n) } : {});
});

// ---- showing the state ----

const STATES = { running: 'Live', paused: 'Live', black: 'Black', white: 'White', end: 'End', done: 'End', ready: 'Not live', off: 'PowerPoint off' };
function render(s) {
  if (!s) return;
  state = s;
  $('#slide').textContent = s.t ? `${s.s || '–'} / ${s.t}` : '–';
  const st = $('#state');
  st.textContent = STATES[s.st] || s.st || '';
  st.className = `tag ${s.st === 'running' || s.st === 'paused' ? 'live' : s.st === 'black' || s.st === 'white' ? 'warn' : ''}`;
  const live = ['running', 'paused', 'black', 'white', 'end', 'done'].includes(s.st);
  $('#startBtn').classList.toggle('hidden', live);
  $('#endBtn').classList.toggle('hidden', !live);
  $('#build').classList.toggle('hidden', !s.b);
  $('#build').textContent = s.b ? `Build ${s.b}` : '';
  $('#music').textContent = s.mu === -1 ? '· off' : s.f ? `· fading ${s.f}` : s.mu ? '· playing' : '· paused';
}
function renderCues(names) {
  const el = $('#cues');
  el.innerHTML = '';
  if (!names.length) { el.innerHTML = '<span class="dim">No cues</span>'; return; }
  names.forEach((n, i) => {
    const b = document.createElement('button');
    b.className = 'btn cue';
    b.dataset.c = 'cue';
    b.dataset.n = String(i + 1);
    b.innerHTML = `<span class="ck mono">${i + 1}</span><span class="cn"></span>`;
    b.querySelector('.cn').textContent = n;
    el.appendChild(b);
  });
}

// ---- keep the screen on ----
let lock = null;
async function awake(on) {
  try {
    if (on && 'wakeLock' in navigator) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; $('#awake').classList.remove('lit'); }); }
    else if (lock) { await lock.release(); lock = null; }
  } catch { /* not allowed now */ }
  $('#awake').classList.toggle('lit', !!lock);
  store.set('awake', on ? '1' : '');
}
$('#awake').onclick = () => awake(!lock);
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.get('awake') === '1' && !lock) awake(true); });

// ---- start ----
$('#pin').value = store.get('pin') || '';
if (!navigator.bluetooth) {
  $('#unsupported').classList.remove('hidden');
  $('#setup').classList.add('hidden');
  setConn('bad', 'No Bluetooth');
} else {
  $('#connect').onclick = () => connect(true);
  // A PC chosen before can be reconnected without the list (where Chrome allows it).
  if (navigator.bluetooth.getDevices) {
    navigator.bluetooth.getDevices().then((list) => {
      const known = list[0];
      if (!known) return;
      device = known;
      device.addEventListener('gattserverdisconnected', onDisconnected);
      const b = $('#reconnect');
      b.textContent = `Reconnect to ${known.name || 'the Stagio computer'}`;
      b.classList.remove('hidden');
      b.onclick = () => connect(false);
    }).catch(() => {});
  }
}
if (store.get('awake') === '1') awake(true);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
