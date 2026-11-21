// Stagio quick checks: things that can be verified without a slide show.
//   node test/checks.js            helper + config checks only
//   node test/checks.js --server   also checks a running Stagio (npm run dev) over HTTP
// Exits with code 1 if anything fails.
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
function check(name, pass, detail = '') {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helper process

async function helperChecks() {
  const { Helper } = require('../lib/helper');
  const h = new Helper('checks', { timeoutMs: 20000 });
  try {
    const t0 = Date.now();
    check('helper starts and answers', (await h.call('ping')) === 'pong', `${Date.now() - t0} ms`);

    const st = await h.call('ppt.state');
    check('ppt.state returns a state', typeof st.running === 'boolean', `running=${st.running}`);

    const audio = await h.call('audio.state');
    check('audio.state lists output devices', Array.isArray(audio.devices) && audio.devices.length > 0, `${audio.devices.length} devices, volume ${audio.volume}`);

    const displays = await h.call('display.list');
    check('display.list lists screens', displays.screens.length > 0, `${displays.screens.length} screen(s)`);

    // A command that waited past its deadline behind a slow one must be dropped, not run late.
    const before = await h.call('debug.mark');
    const slow = h.call('debug.sleep', { ms: 1500 });
    const late = h.call('debug.mark', {}, { timeoutMs: 400 }).then(() => 'ran', (e) => e.message);
    const lateResult = await late;
    await slow;
    const after = await h.call('debug.mark');
    check('command that timed out in the queue is reported', /timed out/.test(lateResult), lateResult);
    check('...and is not executed later', after === before + 1, `marks ${before} -> ${after} (expected +1 for this read only)`);
  } finally {
    h.stop();
  }
}

// ---------------------------------------------------------------- config

function configChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagio-cfg-'));
  process.env.STAGIO_DATA = dir;
  delete require.cache[require.resolve('../lib/config')];
  const config = require('../lib/config');
  const file = path.join(dir, 'config.json');

  const a = config.load();
  check('first run creates a config with PIN and key', /^\d{6}$/.test(a.pin) && a.accessKey.length >= 10);
  check('...with presenter view hidden, auto cues on and an empty recent list', a.hidePresenterView === true && a.autoCues === true && Array.isArray(a.recent) && a.recent.length === 0);
  check('...and cues on plain 1–9 (not Shift) until changed', a.cueShift === false);
  a.cues[0].name = 'Renamed cue';
  config.save(a);
  check('settings survive a reload', config.load().cues[0].name === 'Renamed cue');

  // Simulate a half-written file (power loss, disk full).
  fs.writeFileSync(file, '{"pin":"12');
  const b = config.load();
  check('damaged config is restored from the backup', b.pin === a.pin && b.cues[0].name === 'Renamed cue', `pin kept: ${b.pin === a.pin}`);
  check('...and the damaged file is kept for inspection', fs.readdirSync(dir).some((f) => f.startsWith('config.damaged-')));
  check('no temporary files are left behind', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));

  // Settings from before 1.2 / 1.3: Spotify Premium mode, its sign-in, "spotify.*" cue steps.
  const old = config.load();
  old.features = { music: 'spotify' };
  old.spotify = { clientId: 'abc', tokens: { access: 'x', refresh: 'y' } };
  old.cues = [{ id: 'z', name: 'Old cue', steps: [{ type: 'spotify.fadeOut', seconds: 4 }, { type: 'spotify.playUri', uri: 'spotify:playlist:1' }, { type: 'ppt.start', slide: 1 }] }];
  delete old.music;
  config.save(old);
  const m = config.load();
  check('an old Premium setting becomes music on, and the stored Spotify sign-in is dropped', m.features.music === 'local' && m.spotify === undefined && !JSON.stringify(m).includes('refresh'));
  check('old "spotify.*" cue steps become music steps; the Premium-only playlist step is removed',
    m.cues[0].steps.map((x) => x.type).join(' ') === 'music.fadeOut ppt.start', m.cues[0].steps.map((x) => x.type).join(' '));
  check('music follows whatever plays until an app is chosen', m.music && m.music.source === '' && m.music.lastApp === null);
  m.features.music = 'off';
  config.save(m);
  check('music switched off stays off', config.load().features.music === 'off');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- auto cues

async function autoCueChecks() {
  const { AutoCues } = require('../lib/autocues');
  const cues = [
    { id: 'a', name: 'Opening · music out', steps: [], auto: { deck: 'Deck.pptx', slideId: 300, slide: 3 } },
    { id: 'b', name: 'Break · black', steps: [] },
    { id: 'c', name: 'Close', steps: [], auto: { deck: 'Other.pptx', slideId: 300, slide: 3 } },
  ];
  let show = null; let on = true; let ran = [];
  const ac = new AutoCues({
    cues: () => cues, enabled: () => on, current: () => show, isRunning: () => false,
    run: async (c) => { ran.push(c.id); return []; }, onFire: () => {}, dwellMs: 40, cooldownMs: 150,
  });
  const at = (slide, slideId, notes = '') => ({ path: 'C:\\decks\\Deck.pptx', name: 'Deck.pptx', slide, slideId, notes });
  const go = async (to, wait = 100, first = false) => { const before = show; show = to; ac.onSlideChange(before, to, first); await sleep(wait); };
  const fresh = async (start) => { await sleep(170); ran = []; show = start; };

  await go(at(2, 200));
  await go(at(3, 300));
  check('auto cue runs on arriving at its slide', ran.join() === 'a', `ran: ${ran.join() || 'nothing'}`);
  check('...and a cue bound to another presentation does not', !ran.includes('c'));

  await go(at(4, 400));
  await go(at(3, 300));
  check('stepping back onto the slide does not run it again', ran.join() === 'a', `ran: ${ran.join()}`);

  await fresh(at(2, 200));
  await go(at(3, 300), 5);  // passed through without stopping
  await go(at(4, 400));
  check('paging quickly past the slide runs nothing', ran.length === 0, `ran: ${ran.join() || 'nothing'}`);

  await fresh(at(2, 200));
  await go(at(9, 300));     // slides were inserted in front of it: same slide, new number
  check('the cue follows its slide when slides are inserted before it', ran.join() === 'a', `ran: ${ran.join() || 'nothing'}`);

  await fresh(null);
  await go(at(3, 300));     // show started straight on that slide
  check('starting the show on the slide runs it', ran.join() === 'a', `ran: ${ran.join() || 'nothing'}`);

  await fresh(null);
  await go(at(3, 300), 100, true);
  check('a show already running when Stagio starts runs nothing', ran.length === 0);

  await fresh(at(4, 400));
  await go(at(5, 500, 'Speaker notes\n[cue: break]'));
  check('[cue: name] in the slide notes runs that cue', ran.join() === 'b', `ran: ${ran.join() || 'nothing'}`);
  await fresh(at(5, 500));
  await go(at(6, 600, '【cue 3】'));
  check('[cue 3] in the notes runs the third cue', ran.join() === 'c', `ran: ${ran.join() || 'nothing'}`);

  await fresh(at(2, 200));
  ac.noteRun('a');          // the operator just ran it by hand
  await go(at(3, 300));
  check('a cue just run by hand is not repeated by its slide', ran.length === 0);

  await fresh(at(2, 200));
  on = false;
  await go(at(3, 300));
  check('auto cues switched off: nothing runs', ran.length === 0);
  ac.stop();
}


// ---------------------------------------------------------------- headphone preview (stand-in helper)

async function previewChecks() {
  const { Preview } = require('../lib/preview');
  const calls = [];
  let devices = [{ id: 'spk', name: 'Speakers', isDefault: true }];
  const control = { call: async (cmd, a) => {
    calls.push(a);
    // the helper reports which programs it sent somewhere
    return { available: true, changed: 0, apps: [{ name: 'chrome', label: 'Chrome', route: a.on ? 'phones' : 'default', active: true }], touched: a.on ? ['chrome'] : [] };
  } };
  const cfg = {};
  let saves = 0; let changes = 0;
  const pv = new Preview({ control, cfg, save: () => saves++, pro: false, musicApp: () => 'Spotify', devices: () => devices, onChange: () => changes++ });
  check('preview starts off, with its settings created', pv.on === false && cfg.preview && cfg.preview.phones === '' && Array.isArray(cfg.preview.touched));
  let err = null;
  try { await pv.setOn(true); } catch (e) { err = e.message; }
  check('it cannot be turned on before the headphones are chosen', /headphones/i.test(err || ''), err || 'no error');
  pv.devicesChanged();                                            // first poll: nothing happens
  devices = [...devices, { id: 'hp', name: 'USB Headset', isDefault: false }];
  pv.devicesChanged();
  check('a new sound device is offered as the headphones', pv.prompt?.kind === 'new' && pv.prompt.id === 'hp');
  await pv.configure({ phones: 'hp' });
  await pv.setOn(true);
  const last = calls[calls.length - 1];
  check('on: the music app and PowerPoint stay on the speakers, the rest goes to the headphones',
    last.on === true && last.phones === 'hp' && last.stay.includes('POWERPNT') && last.stay.includes('Spotify') && last.room === '', JSON.stringify(last.stay));
  check('programs it moved are remembered in the settings (to set them back later)', JSON.stringify(cfg.preview.touched) === '["chrome"]' && saves > 0);
  devices = devices.filter((d) => d.id !== 'hp');
  pv.devicesChanged();
  check('unplugging the headphones turns it off and says so', pv.on === false && /unplugged/i.test(pv.notice?.text || ''));
  await pv.tick();
  check('...and the next round sets the moved programs back', calls[calls.length - 1].on === false && JSON.stringify(cfg.preview.touched) === '[]');
  devices = [...devices, { id: 'hp', name: 'USB Headset', isDefault: false }];
  pv.devicesChanged();
  check('plugging the chosen headphones in again asks to turn it on', pv.prompt?.kind === 'plugged' && pv.on === false);
  err = null;
  try { await pv.setApp('chrome', 'room'); } catch (e) { err = e.message; }
  check('Standard has no per-app choices (Extra)', /Extra/.test(err || ''));
  const pro = new Preview({ control, cfg: { preview: { phones: 'hp' } }, save: () => {}, pro: true, musicApp: () => '', devices: () => devices });
  await pro.setApp('vlc', 'room');
  await pro.configure({ keep: ['Teams', 'Teams', ' obs64 '] });
  await pro.setOn(true);
  const l2 = calls[calls.length - 1];
  check('Extra: an app chosen for the speakers and the kept apps are passed on',
    l2.overrides.vlc === 'room' && l2.stay.includes('Teams') && l2.stay.includes('obs64') && l2.stay.filter((x) => x === 'Teams').length === 1, JSON.stringify(l2));
  await pro.shutdown();
  check('quitting turns it off first', calls[calls.length - 1].on === false && pro.on === false);
}

// ---------------------------------------------------------------- which slide image is shown

// ---------------------------------------------------------------- music fades (local mode)
// The order of steps around a fade, with a stand-in for the music helper (no sound is played).
// The smoothness itself was measured with a recorded test tone (README: 音乐淡入淡出).

async function fadeChecks() {
  const { LocalMusic } = require('../lib/localmusic');
  let calls = [];
  let playing = true; let vol = 80; let fadeId = 0; const fades = {};
  let stopReportedAt = 0; // after a pause, the stand-in music app still says "playing" until then
  const control = {
    async call(cmd, args = {}) {
      calls.push(cmd === 'music.do' ? `do:${args.action}` : cmd === 'music.volume' ? `volume:${args.value}${args.glideMs ? `:glide${args.glideMs}` : ''}` : cmd);
      switch (cmd) {
        case 'music.state': return { running: true, session: true, isPlaying: playing || Date.now() < stopReportedAt, volume: vol };
        case 'music.fade': { const id = ++fadeId; fades[id] = { state: 'running', to: args.to, from: args.from, until: Date.now() + args.ms }; return id; }
        case 'music.fadeStatus': {
          if (args.id !== fadeId) return { state: 'replaced', level: vol };
          const f = fades[args.id];
          if (f.state === 'running' && Date.now() >= f.until) { f.state = 'done'; vol = f.to; }
          return { state: f.state, level: vol };
        }
        case 'music.fadeStop': if (args.id === fadeId) { fades[args.id].state = 'stopped'; fadeId++; } return true;
        case 'music.volume': vol = args.value; return 1;
        case 'music.silenceWhenReady': vol = 0; return true;
        case 'music.do':
          if (args.action === 'pause') { playing = false; stopReportedAt = Date.now() + 250; }
          if (args.action === 'play') playing = true;
          return true;
        default: return null;
      }
    },
  };
  const m = new LocalMusic(control);
  await m.poll();

  // fade-out: one glide in the helper (from where it is now), pause, wait until really stopped, then the level back
  calls = [];
  const t0 = Date.now();
  await m.fadeOut(0.3);
  const seq = calls.filter((c) => c !== 'music.fadeStatus' && c !== 'music.state');
  check('fade-out runs as one glide in the helper, not as volume steps', seq[0] === 'music.fade' && !calls.some((c) => /^volume:\d+$/.test(c) && c !== 'volume:80'), seq.join(' '));
  const restoreAt = calls.indexOf('volume:80');
  check('...then pauses, and puts the level back only after the music app reports it stopped',
    seq.join(' ') === 'music.fade do:pause volume:80' && restoreAt > calls.lastIndexOf('music.state') && Date.now() - t0 >= 300 + 250 + 400, `${Date.now() - t0} ms`);

  // fade-in from paused: silent first, play, silenced the moment the audio exists, then one glide up
  calls = [];
  await m.fadeIn(0.3);
  const seq2 = calls.filter((c) => c !== 'music.fadeStatus' && c !== 'music.state');
  check('fade-in: level 0, play, silenced as soon as the audio exists, then one glide up',
    seq2.join(' ') === 'volume:0 do:play music.silenceWhenReady music.fade', seq2.join(' '));
  check('...ending at the normal level', vol === 80, `level ${vol}`);

  // a fade-out cut short by a fade-in: the first glide is stopped, by its own number only
  calls = [];
  const out = m.fadeOut(2);
  await sleep(300);
  await m.fadeIn(0.3);
  await out;
  const stops = calls.filter((c) => c === 'music.fadeStop').length;
  check('a fade cut short by another stops only the first glide', stops === 1 && vol === 80 && !calls.includes('do:pause'), `${stops} stop(s), level ${vol}, ${calls.includes('do:pause') ? 'paused (wrong)' : 'kept playing'}`);

  // the slider: a short glide, not a jump
  calls = [];
  await m.setVolume(40);
  check('a level set by hand glides over 0.3 s instead of jumping', calls.join(' ') === 'volume:40:glide300', calls.join(' '));

  // fade from a chosen level to a chosen level
  vol = 70; playing = true; await m.poll();
  calls = [];
  await m.fadeTo(30, 0.3, 50);
  const seq3 = calls.filter((c) => c !== 'music.fadeStatus' && c !== 'music.state');
  check('fade from 50 to 30 while playing: a short glide to 50, then the fade to 30, music keeps playing',
    seq3.join(' ') === 'music.fade music.fade' && vol === 30 && !calls.includes('do:pause'), `${seq3.join(' ')} · level ${vol}`);
  check('...30 becomes the level Fade in returns to', m.level === 30, `level ${m.level}`);
  calls = [];
  await m.fadeTo(0, 0.3);
  check('fade to 0: ends paused, level put back for the next play', calls.includes('do:pause') && vol === 30, `level ${vol}`);
  calls = [];
  await m.fadeTo(60, 0.3, 20);
  const seq4 = calls.filter((c) => c !== 'music.fadeStatus' && c !== 'music.state');
  check('fade from 20 to 60 while stopped: starts silent, rises to 20, then fades to 60',
    seq4.join(' ') === 'volume:0 do:play music.silenceWhenReady music.fade music.fade' && vol === 60, `${seq4.join(' ')} · level ${vol}`);
}

function imageChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagio-thumbs-'));
  const before = process.env.STAGIO_THUMBS;
  process.env.STAGIO_THUMBS = dir;
  delete require.cache[require.resolve('../lib/powerpoint')];
  const { PowerPoint } = require('../lib/powerpoint');
  const idle = { call: async () => ({}) };
  const ppt = new PowerPoint(idle, idle);
  const deck = 'C:\\decks\\Sunday.pptx';
  ppt.state = { running: true, presentations: [{ path: deck }], active: deck };
  ppt.resetDeck(deck);
  ppt.ids = [256, 257];
  ppt.info.set(256, { title: 'One', hidden: false, sig: 'aaaa' });
  ppt.info.set(257, { title: 'Two', hidden: false, sig: 'bbbb' });
  const ui = () => ppt.slidesForUi().slides;

  ppt.fonts = { pdf: true, embedded: ['Bebas Neue Bold'], missing: ['Bebas Neue Bold'], at: Date.now() };
  ppt.ready.add('256-aaaa'); // made by the normal renderer: wrong fonts for this deck
  check('embedded fonts: an image with the wrong fonts is never shown', ui()[0].thumb === false);
  ppt.ready.add('256-aaaap');
  check('...the PDF-rendered one is', ui()[0].thumb && ui()[0].v === 'aaaap');
  ppt.ready.add('256-aaaac');
  check('a projector image from before 0.7.1 (may be cut off) is not used', ui()[0].v === 'aaaap');
  ppt.ready.add('256-aaaac2');
  check('an image saved from the projector wins over a rendered one', ui()[0].v === 'aaaac2');

  ppt.state.show = { path: deck, slide: 2, slideId: 257, total: 2, state: 'running', click: 0, clicks: 0 };
  check('during a show, a slide of such a deck with no image still gets one: a quick draft (PDF is slow here)',
    ppt.needsRender(257, ppt.info.get(257), true) === true && ppt.slidesForUi().waitShow === false);
  ppt.ready.add('257-bbbbq');
  check('...shown at once, marked as a draft', ui()[1].thumb === true && ui()[1].draft === true && ui()[1].v === 'bbbbq');
  check('...not made again during the show', ppt.needsRender(257, ppt.info.get(257), true) === false);
  check('...but the exact image is still wanted after the show', ppt.needsRender(257, ppt.info.get(257), false) === true);
  ppt.msPerSlide.pdf = 900;
  check('a deck whose PDF images are quick gets exact images during the show too', ppt.needsRender(257, ppt.info.get(257), true) === true);
  ppt.msPerSlide.pdf = undefined;
  ppt.msPerSlide.export = 150;
  check('quick images: rendering waits only ~1 s after a slide change (was 8 s)', ppt.showIdleMs() <= 1500, `${ppt.showIdleMs()} ms`);
  ppt.msPerSlide.export = 3000;
  check('slow images: it waits longer, so a slide change never queues behind one', ppt.showIdleMs() >= 5000, `${ppt.showIdleMs()} ms`);
  ppt.msPerSlide.export = undefined;
  ppt.ready.delete('257-bbbbq');
  ppt.steadySince = Date.now() - 2000;
  const target = ppt.captureTarget();
  check('a slide on the projector for a moment is saved from it', target?.name === '257-bbbbc2', target?.name);
  check('...once, not again right away', ppt.captureTarget() === null);
  ppt.captureTried.clear();
  ppt.state.show = { ...ppt.state.show, click: 1, clicks: 3 };
  check('not while animations are still to come', ppt.captureTarget() === null);
  ppt.state.show = { ...ppt.state.show, click: 3, state: 'black' };
  check('not on a black screen', ppt.captureTarget() === null);
  ppt.state.show = { ...ppt.state.show, state: 'running' };
  ppt.steadySince = Date.now();
  check('not right after the slide changed', ppt.captureTarget() === null);
  ppt.steadySince = Date.now() - 2000;
  const t2 = ppt.captureTarget();
  ppt.info.get(257).sig = 'cccc'; // edited while it was being captured
  ppt.captured(t2);
  check('a capture of a slide edited meanwhile is not kept', !ppt.ready.has('257-bbbbc2') && ui()[1].thumb === false);

  ppt.activity = { app: 'POWERPNT', idleMs: 600, at: Date.now() };
  check('someone working in PowerPoint pauses background work', ppt.userInPowerPoint() === true);
  ppt.activity = { app: 'POWERPNT', idleMs: 9000, at: Date.now() };
  check('...until they stop for a few seconds', ppt.userInPowerPoint() === false);
  ppt.activity = { app: 'Stagio', idleMs: 100, at: Date.now() };
  check('...and only when it is PowerPoint they are using', ppt.userInPowerPoint() === false);

  fs.rmSync(dir, { recursive: true, force: true });
  if (before === undefined) delete process.env.STAGIO_THUMBS; else process.env.STAGIO_THUMBS = before;
}

// ---------------------------------------------------------------- running server

// ---------------------------------------------------------------- editions (Beta 1.0)

function editionChecks() {
  const { versionLabel, FEATURES, current } = require('../lib/edition');
  const labels = ['1.0.0-beta', '1.1.0-beta', '1.2.1-beta', '2.0.0-beta', '1.0.0', '1.3.2', '0.8.1'].map(versionLabel);
  check('version labels read like Beta 1.0, Beta 1.2.1, 1.0', labels.join('|') === 'Beta 1.0|Beta 1.1|Beta 1.2.1|Beta 2.0|1.0|1.3.2|0.8.1', labels.join(' | '));
  const order = ['lite', 'standard', 'extra'];
  const nested = order.every((e, i) => i === 0 || Object.keys(FEATURES[e]).every((f) => !FEATURES[order[i - 1]][f] || FEATURES[e][f]));
  check('each edition has everything the smaller one has (Lite ⊂ Standard ⊂ Extra)', nested);
  check('Lite: no music, sound, display mode, cues or run of show', Object.values(FEATURES.lite).every((v) => v === false));
  check('only Extra has the run of show', FEATURES.extra.run && !FEATURES.standard.run);
  const saved = process.env.STAGIO_EDITION;
  process.env.STAGIO_EDITION = 'extra';
  const e = current();
  process.env.STAGIO_EDITION = 'nonsense';
  const fallback = current();
  if (saved === undefined) delete process.env.STAGIO_EDITION; else process.env.STAGIO_EDITION = saved;
  check('the edition can be set for a test run, and an unknown one falls back to Standard', e.id === 'extra' && e.name === 'Stagio Extra' && fallback.id === 'standard', `${e.name} ${e.label}`);
  const eds = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'editions.json'), 'utf8'));
  check('every edition has a Windows and a Mac version number', order.every((x) => /^\d+\.\d+\.\d+/.test(eds[x]?.windows) && /^\d+\.\d+\.\d+/.test(eds[x]?.mac)));
}

// ---------------------------------------------------------------- run of show (Extra)
// The run of show with stand-ins for PowerPoint, the music, the countdown window and the clock.

async function runChecks() {
  const { RunOfShow, cleanPart } = require('../lib/runofshow');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'od-run-'));
  const fileA = path.join(tmp, 'A.pptx');
  const fileB = path.join(tmp, 'B.pptx');
  fs.writeFileSync(fileA, 'x');
  fs.writeFileSync(fileB, 'x');

  const c = cleanPart({ kind: 'weird', minutes: 9999, name: '' }, 0);
  const cd = cleanPart({ kind: 'countdown', until: '9:05', notices: 'Welcome\n\nPhones off\n', fadeOut: 99 }, 1);
  check('a part is stored cleaned up (unknown kind → manual, minutes capped, notices one per line)',
    c.kind === 'manual' && c.minutes === 600 && c.name === 'Manual 1' && cd.until === '09:05' && cd.notices.join('|') === 'Welcome|Phones off' && cd.fadeOut === 30);

  let clock = Date.parse('2026-11-20T09:00:00');
  const calls = [];
  const ppt = {
    state: { show: null, presentations: [] },
    focus: null,
    async cmd(name, a = {}) {
      calls.push(`${name}${a.path ? `:${path.basename(a.path)}` : ''}${a.background ? ':bg' : ''}`);
      if (name === 'ppt.open') {
        if (!fs.existsSync(a.path)) throw new Error(`File not found: ${a.path}`);
        if (!this.state.presentations.some((p) => p.path === a.path)) this.state.presentations.push({ path: a.path, name: path.basename(a.path) });
        return a.path;
      }
      if (name === 'ppt.start') this.state.show = { path: a.path, slide: a.slide, state: 'running' };
      if (name === 'ppt.setState') this.state.show.state = a.state;
      return true;
    },
    poll: async () => {},
  };
  const fades = [];
  const music = { fadeOut: async (s) => { fades.push(`out ${Math.round(s)}`); }, fadeIn: async (s, v) => { fades.push(`in ${s} ${v}`); } };
  const screen = { shown: 0, hidden: 0, focused: 0, show() { this.shown++; }, hide() { this.hidden++; }, focusConsole() { this.focused++; }, mode: () => 'full' };
  const cfg = {};
  const segments = [];
  const ros = new RunOfShow({
    cfg, save: () => {}, ppt, music: () => music, cues: { run: async () => [] }, cueList: () => [],
    onChange: () => {}, segment: (n) => segments.push(n), now: () => clock,
  });
  ros.setScreen(screen);
  ros.setShows([{ id: 'r1', name: 'Test', parts: [
    { id: 'c', kind: 'countdown', name: 'Countdown', minutes: 10, title: 'Soon', fadeOut: 5, autoNext: true, musicIn: { on: true, volume: 50, seconds: 3 } },
    { id: 'a', kind: 'slides', name: 'Speaker A', minutes: 20, file: fileA, slide: 1, musicOut: { on: true, seconds: 4 } },
    { id: 'm', kind: 'music', name: 'Break', minutes: 10, black: true, musicIn: { on: true, volume: 60, seconds: 4 } },
    { id: 'b', kind: 'slides', name: 'Speaker B', minutes: 20, file: fileB, slide: 3 },
    { id: 'x', kind: 'slides', name: 'Nobody', minutes: 5, file: '' },
  ] }]);

  await ros.start('r1');
  const info = ros.countdownInfo();
  check('start: the countdown goes on the projector with its music', screen.shown === 1 && info?.title === 'Soon' && info.target - clock === 600000 && fades.includes('in 3 50'), JSON.stringify(fades));
  await sleep(30);
  check('...and the first speaker\'s file is opened ahead, without a window', calls.includes(`ppt.open:A.pptx:bg`), calls.join(' '));
  clock += 600000 - 4000; ros.tick();
  check('the music fades out to end at zero (5 s before: only 4 s left, so over 4 s)', fades.includes('out 4'), JSON.stringify(fades));
  calls.length = 0;
  clock += 4000; ros.tick();
  await sleep(30);
  check('at zero the run goes on by itself to the next part', ros.run.index === 1 && segments.at(-1) === 'Speaker A');
  check('...opens the file, starts its show, then ends the others (no desktop in between)', calls.slice(0, 3).join(' ') === 'ppt.open:A.pptx:bg ppt.start:A.pptx ppt.endOthers:A.pptx', calls.join(' '));
  check('...and the countdown window goes once the show is up', screen.hidden === 1 && screen.focused === 1);

  await ros.next();
  check('a break: black screen and the music comes in', ppt.state.show.state === 'black' && fades.includes('in 4 60'));

  calls.length = 0;
  ppt.endBeforeStart = true; // PowerPoint for Mac: one show at a time
  await ros.next();
  check('on a Mac the old show ends before the next one starts', calls.slice(0, 3).join(' ') === 'ppt.open:B.pptx:bg ppt.endOthers:B.pptx ppt.start:B.pptx' && ppt.state.show.slide === 3, calls.join(' '));
  delete ppt.endBeforeStart;

  const noFile = await ros.next().then(() => 'went', (e) => e.message);
  check('a part without a file says so, and the run stays on it', /has no file/.test(noFile) && ros.run.index === 4 && /has no file/.test(ros.summary().active.error), noFile);
  const pastEnd = await ros.next().then(() => 'went', (e) => e.message);
  check('there is nothing after the last part', /last part/.test(pastEnd));

  // Planned 10 + 20 + 10 + 20 min before the last part; it started 10 min into the event.
  const sum = ros.summary().active;
  check('ahead/behind: the planned time of the parts before this one is known', sum.plannedBefore === 60 * 60000 && sum.planned.length === 5);

  let release;
  ppt.cmd = ((orig) => async function (name, a) { if (name === 'ppt.start') await new Promise((r) => { release = r; }); return orig.call(this, name, a); })(ppt.cmd);
  const first = ros.go(1);
  await sleep(10);
  const second = await ros.go(3);
  release();
  await first;
  check('a second press while a part is still starting is ignored (no skipping two parts)', second.busy === true && ros.run.index === 1);

  const again = new RunOfShow({ cfg, save: () => {}, ppt, music: () => music, cues: { run: async () => [] }, cueList: () => [], onChange: () => {}, segment: () => {}, now: () => clock });
  check('after a restart of Stagio the run carries on where it was', again.run?.index === 1 && again.current?.name === 'Speaker A');
  await ros.start('r1', 2);
  const mid = ros.summary().active;
  check('a run started part-way is on time from there (not ahead by the skipped parts)', mid.segAt - mid.startedAt === mid.plannedBefore && mid.plannedBefore === 30 * 60000);
  ros.setShows([]);
  check('deleting the run in progress stops it', ros.run === null);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function serverChecks() {
  const BASE = 'http://127.0.0.1:7300';
  const get = (p, opt) => fetch(BASE + p, opt);
  const post = (p, headers = {}, body = '{}') => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

  const ping = await get('/api/ping').then((r) => r.json()).catch((e) => ({ error: e.message }));
  if (!ping.ok) { check('server reachable on 127.0.0.1:7300', false, ping.error || 'start it with: npm run dev'); return; }
  check('server reachable on 127.0.0.1:7300', true);
  const st0 = await get('/api/state').then((r) => r.json());
  const ed = st0.edition || { id: 'standard', features: { music: true, cues: true, run: false } };
  console.log(`      (checking ${ed.name || 'Stagio'} ${ed.label || ''})`);

  // Requests from other web sites must be refused, even though they arrive from this PC.
  const cross = await post('/api/features', { Origin: 'https://example.com' });
  check('cross-site POST is refused', cross.status === 403, `status ${cross.status}`);
  // A hostile page that points its own domain at 127.0.0.1 still sends its own name as Host.
  // (fetch can't set Host, so this one is a raw request.)
  const raw = await new Promise((resolve) => {
    const req = require('http').request({ host: '127.0.0.1', port: 7300, path: '/api/state', headers: { Host: 'evil.example:7300' } }, (res) => resolve(res.statusCode));
    req.on('error', () => resolve(0));
    req.end();
  });
  check('request with a foreign Host header is refused (DNS rebinding)', raw === 403, `status ${raw}`);
  const sameOrigin = await post('/api/settings', { Origin: BASE });
  check('same-origin POST is accepted', sameOrigin.status === 200, `status ${sameOrigin.status}`);

  // Remote pairing details are for the PC console only.
  const remote = await get('/api/remote').then((r) => r.json());
  check('/api/remote works on the PC', remote.ok === true);
  const state = await get('/api/state').then((r) => r.json());
  check('live state does not carry the PIN or access key', !JSON.stringify(state).includes(remote.data?.pin || '\u0000') || !remote.data);
  if (remote.data) {
    const lan = remote.data.url.replace(/\/$/, '');
    const noKey = await fetch(`${lan}/api/state`).catch(() => null);
    check('LAN request without a key is refused', noKey?.status === 401, `status ${noKey?.status}`);
    const key = new URL(remote.data.qrUrl).searchParams.get('key');
    const withKey = await fetch(`${lan}/api/state`, { headers: { 'X-Stagio-Key': key } }).catch(() => null);
    check('LAN request with the key is accepted', withKey?.status === 200, `status ${withKey?.status}`);
    const remoteFromLan = await fetch(`${lan}/api/remote`, { headers: { 'X-Stagio-Key': key } }).catch(() => null);
    check('/api/remote is refused from other devices', remoteFromLan?.status === 403, `status ${remoteFromLan?.status}`);
    const page = await fetch(`${lan}/`).catch(() => null);
    check('sign-in page loads from the LAN without a key', page?.status === 200);
  } else {
    console.log('      (no LAN address: LAN checks skipped)');
  }

  // Headphone preview: Standard (basic) and Extra (full), on Windows; not in Lite.
  const pvStatus = await post('/api/preview', {}, JSON.stringify({ on: true })).then((r) => r.status);
  const stPv = await get('/api/state').then((r) => r.json());
  const types = await get('/api/cues/types').then((r) => (r.ok ? r.json() : {}));
  if (!ed.features.preview) {
    check('Lite has no headphone preview', pvStatus === 403 && !stPv.preview, `status ${pvStatus}`);
  } else if (stPv.preview) {
    check('headphone preview is there, and full only in Extra', stPv.preview.pro === !!ed.features.previewPro && stPv.preview.on === false);
    check('it does not turn on without headphones chosen', pvStatus >= 400, `status ${pvStatus}`);
    const perApp = await post('/api/preview/app', {}, JSON.stringify({ name: 'checks', route: 'room' })).then((r) => r.status);
    check(ed.features.previewPro ? 'Extra: per-app choices are accepted' : 'Standard: no per-app choices', ed.features.previewPro ? perApp === 200 : perApp >= 400, `status ${perApp}`);
    if (ed.features.previewPro) await post('/api/preview/app', {}, JSON.stringify({ name: 'checks', route: 'auto' }));
    check('the cue step for it only in Extra', !!types['audio.preview'] === !!ed.features.previewPro);
  }

  // No Spotify Web API (Premium) any more: its sign-in pages are gone.
  const gone = [await get('/spotify/login', { redirect: 'manual' }).then((r) => r.status), await get('/api/spotify/playlists').then((r) => r.status)];
  check('the Spotify Premium sign-in and its API are gone', gone.every((x) => x === 404), gone.join(' '));
  // Reordering checks what it is given.
  const badMove = await post('/api/ppt/move', {}, JSON.stringify({ path: '', id: 'x', to: 0 }));
  check('moving a slide needs a file, a slide and a place', badMove.status >= 400, `status ${badMove.status}`);
  if (ed.features.music) {
    const pick = await post('/api/music/source', {}, JSON.stringify({ id: 'Checks.exe' }));
    const st1 = await get('/api/state').then((r) => r.json());
    const back = await post('/api/music/source', {}, JSON.stringify({ id: '' }));
    const st2 = await get('/api/state').then((r) => r.json());
    check('the music app can be chosen, and set back to automatic',
      pick.status === 200 && back.status === 200 && st1.localMusic?.pinned === 'Checks.exe' && st2.localMusic?.pinned === '',
      `${st1.localMusic?.pinned} -> "${st2.localMusic?.pinned}"`);
    check('the state shows no program path of the music app', !JSON.stringify(st2.localMusic || {}).includes('\\\\') && !/"path"/.test(JSON.stringify(st2.localMusic || {})));
  }

  // Live stream: a full snapshot first, then only the parts that changed; rebuilt state must match.
  const ctrl = new AbortController();
  const res = await get('/api/events', { signal: ctrl.signal });
  let live = null; let messages = 0; let bytes = 0; let fulls = 0; let buf = '';
  (async () => {
    try {
      for await (const chunk of res.body) {
        bytes += chunk.length;
        buf += Buffer.from(chunk).toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const p = JSON.parse(line.slice(6));
          messages++;
          if (p._full) { fulls++; live = p; delete live._full; } else if (live) Object.assign(live, p);
        }
      }
    } catch { /* aborted */ }
  })();
  await sleep(1200);
  check('stream starts with one full snapshot', fulls === 1 && live && 'ppt' in live && 'cues' in live, `${messages} message(s)`);
  // Change something small and reversible (restored below): the music mode, or in Lite a setting.
  if (ed.features.music) {
    const modeBefore = live.features.music;
    const other = modeBefore === 'off' ? 'local' : 'off';
    await post('/api/features', {}, JSON.stringify({ music: other }));
    await sleep(700);
    check('a change arrives as a patch', live.features.music === other && fulls === 1);
    await post('/api/features', {}, JSON.stringify({ music: modeBefore }));
  } else {
    const before = live.settings.autoCues;
    await post('/api/settings', {}, JSON.stringify({ autoCues: !before }));
    await sleep(700);
    check('a change arrives as a patch', live.settings.autoCues === !before && fulls === 1);
    await post('/api/settings', {}, JSON.stringify({ autoCues: before }));
  }
  await sleep(6500); // long enough to see a heartbeat
  const now = await get('/api/state').then((r) => r.json());
  const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.program; delete c.localMusic; delete c.audio; if (c.ppt) delete c.ppt.slides; return JSON.stringify(c); };
  check('state rebuilt from patches matches the server', strip(live) === strip(now));
  check('heartbeats keep the stream alive when nothing changes', messages >= 4, `${messages} messages, ${Math.round(bytes / 1024)} KB in ~8 s`);

  // Settings arrive over the same stream; cue "run by itself" bindings are stored cleaned up.
  const put = (body) => fetch(`${BASE}/api/cues`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const hideBefore = live.settings.hidePresenterView;
  await post('/api/settings', {}, JSON.stringify({ hidePresenterView: !hideBefore, autoCues: 'yes' }));
  await sleep(500);
  check('a settings change reaches the consoles', live.settings.hidePresenterView === !hideBefore && typeof live.settings.autoCues === 'boolean');
  await post('/api/settings', {}, JSON.stringify({ hidePresenterView: hideBefore }));
  if (now.cues.length && ed.features.cues) {
    const edited = JSON.parse(JSON.stringify(now.cues));
    edited[0].auto = { deck: 'C:\\somewhere\\Deck.pptx', slideId: '261', slide: 5, extra: 'x' };
    await put(edited);
    await sleep(500);
    const a = live.cues[0].auto;
    check('a cue\'s slide binding is saved (file name and slide ID only)', a && a.deck === 'Deck.pptx' && a.slideId === 261 && a.slide === 5 && !('extra' in a), JSON.stringify(a));
    await put(now.cues);
    await sleep(500);
    check('...and removed again', JSON.stringify(live.cues) === JSON.stringify(now.cues));
  }

  // Show timer, connected phones, cue keys, earlier versions (0.7.0).
  const fresh = await get('/api/ping').then((r) => r.json());
  check('ping carries the PC clock (show timer on phones)', Math.abs((fresh.now || 0) - Date.now()) < 2000, `${(fresh.now || 0) - Date.now()} ms`);
  check('state has the show timer and the count of connected phones', !!live.timer && 'segAt' in live.timer && typeof live.remotes === 'number');
  check('state says whether the slow-text check is done and lists earlier versions', 'checked' in live.fastCopy && Array.isArray(live.fastCopy.backups));
  const shiftBefore = !!live.settings.cueShift;
  await post('/api/settings', {}, JSON.stringify({ cueShift: !shiftBefore }));
  await sleep(500);
  check('the cue-key setting (Shift + 1–9) reaches the consoles', live.settings.cueShift === !shiftBefore);
  await post('/api/settings', {}, JSON.stringify({ cueShift: shiftBefore }));
  const segBefore = live.timer?.segAt || 0;
  await sleep(20);
  await post('/api/timer/segment');
  await sleep(500);
  check('restarting the segment timer reaches the consoles', live.timer.segAt > segBefore && live.timer.segBy === '');
  const bad = await post('/api/ppt/restoreBackup', {}, JSON.stringify({ file: '..\\config.json' })).then((r) => r.json());
  check('restoring anything but an earlier version of the deck in view is refused', !bad.ok, bad.error);

  // Bluetooth remote (0.8.0): every command carries the PIN; wrong PINs are ignored and a phone
  // that keeps guessing is locked out for 5 minutes.
  if (remote.data?.pin) {
    const bt = (command, phone = 'checks-phone') => post('/api/debug/bluetoothCommand', {}, JSON.stringify({ phone, command })).then((r) => r.json());
    const a0 = (await bt({ pin: remote.data.pin, c: 'hello' })).data.accepted;
    const wrong = await bt({ pin: '000000', c: 'hello' });
    check('Bluetooth: a command with a wrong PIN is ignored', wrong.data.accepted === a0, `accepted ${a0} -> ${wrong.data.accepted}`);
    const right = await bt({ pin: remote.data.pin, c: 'hello' });
    check('Bluetooth: with the right PIN it is accepted (the phone sees the count go up)', right.data.accepted === a0 + 1);
    check('Bluetooth: the state for phones stays small', JSON.stringify(right.data.state).length < 180, `${JSON.stringify(right.data.state).length} bytes`);
    for (let i = 0; i < 8; i++) await bt({ pin: '111111', c: 'hello' }, 'guessing-phone');
    const locked = await bt({ pin: remote.data.pin, c: 'hello' }, 'guessing-phone');
    check('Bluetooth: after 8 wrong PINs that phone is locked out, even with the right PIN', locked.data.accepted === right.data.accepted);
    const other = await bt({ pin: remote.data.pin, c: 'hello' }, 'another-phone');
    check('...other phones are not', other.data.accepted === right.data.accepted + 1);
  }
  // What this edition has, and refuses what it doesn't (Beta 1.0).
  const status = (p, body = '{}', method = 'POST') => fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body }).then((r) => r.status);
  check('the state says which edition this is', ['lite', 'standard', 'extra'].includes(now.edition?.id) && /Stagio/.test(now.edition?.name || ''), `${now.edition?.name} ${now.edition?.label}`);
  if (!ed.features.music) {
    const refused = [await status('/api/music/toggle'), await status('/api/cues', '[]', 'PUT'), await status('/api/audio/mute', '{"mute":false}'), await status('/api/display/mode', '{"mode":"extend"}')];
    check('Lite refuses music, cues, sound and display mode', refused.every((x) => x === 403), refused.join(' '));
  }
  // Stage display (Extra): its own PIN and key reach the stage display only (checked from the LAN
  // address, so this PC is not trusted as itself).
  if (ed.features.stage && remote.data?.stage?.pin && remote.data.url) {
    const lan = remote.data.url.replace(/\/$/, '');
    const lanPost = (p, body, key) => fetch(lan + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Stagio-Key': key } : {}) }, body: JSON.stringify(body || {}) });
    const wrong = await lanPost('/api/stage/login', { pin: remote.data.pin === '000000' ? '111111' : '000000' });
    check('Stage: a wrong stage PIN is refused', wrong.status === 401, `status ${wrong.status}`);
    const asConsole = await lanPost('/api/login', { pin: remote.data.stage.pin });
    check('Stage: the stage PIN does not open the console', asConsole.status === 401, `status ${asConsole.status}`);
    const login = await lanPost('/api/stage/login', { pin: remote.data.stage.pin }).then((r) => r.json());
    const sk = login.data?.key;
    check('Stage: the stage PIN gives the stage key', login.ok && !!sk && sk !== new URL(remote.data.qrUrl).searchParams.get('key'));
    const sget = (p) => fetch(lan + p, { headers: { 'X-Stagio-Key': sk } }).then((r) => r.status);
    const refused = [await sget('/api/state'), await sget('/api/remote'), (await lanPost('/api/ppt/next', {}, sk)).status, (await lanPost('/api/stage/message', { text: 'x' }, sk)).status, (await lanPost('/api/cues/open/run', {}, sk)).status];
    check('Stage: its key reaches nothing else (state, remote, slides, messages, cues)', refused.every((x) => x === 403 || x === 401), refused.join(' '));
    check('Stage: its key reaches ping', (await sget('/api/ping')) === 200);
    const flipOff = await lanPost('/api/stage/next', {}, sk);
    check('Stage: Prev/Next refused while the console has them off', flipOff.status === 400, `status ${flipOff.status}`);
    // the live stream: the message arrives, and the speaker's "seen" reaches the console
    const sctrl = new AbortController();
    const sres = await fetch(`${lan}/api/stage/events?key=${encodeURIComponent(sk)}`, { signal: sctrl.signal });
    let sv = null; let sbuf = '';
    (async () => {
      try {
        for await (const chunk of sres.body) {
          sbuf += Buffer.from(chunk).toString();
          let i;
          while ((i = sbuf.indexOf('\n\n')) >= 0) {
            const line = sbuf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
            sbuf = sbuf.slice(i + 2);
            if (line) { const d = JSON.parse(line.slice(6)); if ('show' in d) sv = d; }
          }
        }
      } catch { /* aborted */ }
    })();
    await sleep(800);
    check('Stage: the stream starts with the stage view (no keys, no PIN in it)', !!sv && 'notes' in sv && !JSON.stringify(sv).includes(remote.data.pin) && !JSON.stringify(sv).includes(sk));
    await sleep(300);
    check('Stage: the console counts the connected stage display', live.stage?.screens >= 1, `${live.stage?.screens}`);
    const t0 = Date.now();
    const sent = await post('/api/stage/message', {}, JSON.stringify({ text: '  5 minutes   left ' })).then((r) => r.json());
    while (Date.now() - t0 < 3000 && !(sv?.message && sv.message.id === sent.data)) await sleep(50);
    check('Stage: a message reaches the stage display within a second', sv?.message?.text === '5 minutes left' && Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    await lanPost('/api/stage/ack', { id: sent.data }, sk);
    await sleep(500);
    check('Stage: the speaker\'s "seen" reaches the console', !!live.stage?.message?.ackAt && sv?.message?.acked === true);
    await post('/api/stage/clear');
    await sleep(400);
    check('Stage: Clear removes it from the stage display', sv && sv.message === null);
    sctrl.abort();
  }

  if (ed.features.run) {
    const cd = await get('/api/run/countdown').then((r) => r.json());
    check('Extra: the countdown window gets its answer', cd.ok === true && 'data' in cd);
    check('Extra: the state carries the runs of show', Array.isArray(now.run?.shows));
  } else {
    check('the run of show is refused outside Extra', (await status('/api/run/next')) === 403 && now.run === null);
  }
  ctrl.abort();
}

(async () => {
  try {
    // --no-helper: on a Mac (GitHub's), where the Windows PowerShell helper doesn't exist.
    if (!process.argv.includes('--no-helper')) await helperChecks();
    configChecks();
    await autoCueChecks();
    await previewChecks();
    await fadeChecks();
    imageChecks();
    editionChecks();
    await runChecks();
    if (process.argv.includes('--server')) await serverChecks();
  } catch (e) {
    check('checks ran to the end', false, e.stack);
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
