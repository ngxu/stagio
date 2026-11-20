// Persistent settings in config.json (Spotify tokens, access key, PIN, cues), with the previous
// version kept as config.backup.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The installed app sets STAGIO_DATA to a per-user folder (its own folder is read-only).
const DATA_DIR = process.env.STAGIO_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CUES = [
  {
    id: 'open',
    name: 'Opening · music out, slide 1',
    color: 'green',
    steps: [
      { type: 'spotify.fadeOut', seconds: 4 },
      { type: 'ppt.start', slide: 1 },
    ],
  },
  {
    id: 'break',
    name: 'Break · black, music in',
    color: 'blue',
    steps: [
      { type: 'ppt.black' },
      { type: 'spotify.fadeIn', seconds: 3, volume: 60 },
    ],
  },
  {
    id: 'resume',
    name: 'Resume · music out, slides on',
    color: 'amber',
    steps: [
      { type: 'spotify.fadeOut', seconds: 3 },
      { type: 'ppt.normal' },
    ],
  },
  {
    id: 'end',
    name: 'Close · black, exit music',
    color: 'red',
    steps: [
      { type: 'ppt.black' },
      { type: 'spotify.fadeIn', seconds: 5, volume: 70 },
    ],
  },
];

const BACKUP = path.join(DATA_DIR, 'config.backup.json');

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

function load() {
  let cfg = readJson(FILE);
  if (!cfg && fs.existsSync(FILE)) {
    // The file is there but unreadable (power loss or a full disk while it was being written).
    // Keep it for inspection and fall back to the last good copy, rather than silently starting
    // over and losing the cues, the PIN the phones use and the Spotify sign-in.
    try { fs.renameSync(FILE, path.join(DATA_DIR, `config.damaged-${Date.now()}.json`)); } catch { /* leave it */ }
    cfg = readJson(BACKUP);
    console.warn(cfg ? 'config.json was damaged; restored the previous settings' : 'config.json was damaged and no backup exists; starting with defaults');
  }
  cfg ||= {};
  cfg.port ??= 7300;
  cfg.accessKey ??= crypto.randomBytes(9).toString('base64url');
  cfg.pin ??= String(crypto.randomInt(0, 1000000)).padStart(6, '0'); // typed on phones that can't scan
  cfg.spotify ??= { clientId: '', tokens: null };
  cfg.cues ??= DEFAULT_CUES;
  // Rename the built-in cues from the earlier Chinese interface, unless the user renamed them.
  const OLD_NAMES = {
    open: '开场：音乐淡出 → 第 1 页',
    break: '中场：黑屏 + 音乐淡入',
    resume: '回到投影片：音乐淡出',
    end: '结束：黑屏 + 播放散场音乐',
  };
  for (const c of cfg.cues) {
    const d = DEFAULT_CUES.find((x) => x.id === c.id);
    if (d && c.name === OLD_NAMES[c.id]) c.name = d.name;
  }
  cfg.features ??= {};
  // Music control: 'local' = Spotify app on this PC (free account works),
  // 'spotify' = Spotify Web API (Premium), 'off'.
  if (!['local', 'spotify', 'off'].includes(cfg.features.music)) {
    cfg.features.music = cfg.features.spotify === true ? 'spotify' : 'local';
  }
  delete cfg.features.spotify;
  // Recently opened presentations, newest first: [{ path, name }].
  if (!Array.isArray(cfg.recent)) cfg.recent = [];
  cfg.recent = cfg.recent.filter((r) => r && typeof r.path === 'string' && r.path);
  if (cfg.lastPresentation && !cfg.recent.length) {
    cfg.recent.push({ path: cfg.lastPresentation, name: cfg.lastPresentation.split(/[\\/]/).pop() });
  }
  delete cfg.lastPresentation;
  cfg.hidePresenterView ??= true; // Stagio is the operator's view; keep PowerPoint's own one away
  cfg.autoCues ??= true;          // cues bound to a slide run by themselves
  cfg.cueShift ??= false;         // true: cues need Shift + 1–9, so a stray number key does nothing
  // Stage display (Extra): the speaker's view-only screen has its own key and PIN, so handing a
  // phone to a speaker never hands over the console.
  cfg.stageKey ??= crypto.randomBytes(9).toString('base64url');
  if (!/^\d{6}$/.test(String(cfg.stagePin || '')) || cfg.stagePin === cfg.pin) {
    do { cfg.stagePin = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); } while (cfg.stagePin === cfg.pin);
  }
  cfg.stageCanFlip ??= false;     // the speaker may change slides from the stage screen
  if (!Array.isArray(cfg.stagePresets)) {
    cfg.stagePresets = ['5 minutes left', '2 minutes left', 'Please wrap up', 'Time is up', 'A little louder, please', 'Next song is ready'];
  }
  // Stagio's own Wi-Fi (Windows): the same name and password every time, so phones that joined
  // once join again by themselves. Letters that can't be mistaken for each other.
  if (!cfg.ownWifi?.ssid || !cfg.ownWifi?.pass) {
    const pick = (n, set) => Array.from({ length: n }, () => set[crypto.randomInt(0, set.length)]).join('');
    cfg.ownWifi = { ssid: `Stagio-${pick(4, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789')}`, pass: pick(10, 'abcdefghjkmnpqrstuvwxyz23456789') };
  }
  save(cfg);
  return cfg;
}

/** Writes to a temporary file and swaps it in, so config.json is never left half-written. */
function save(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  if (readJson(FILE)) { try { fs.copyFileSync(FILE, BACKUP); } catch { /* backup is best effort */ } }
  fs.renameSync(tmp, FILE);
}

module.exports = { load, save, DATA_DIR };
