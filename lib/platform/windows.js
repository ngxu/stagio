// Windows: PowerPoint, audio and displays are controlled through long-running PowerShell
// helpers (ps/helper.ps1). Separate helper processes so slow work never sits in front of a
// slide change: control (slide commands), thumbs (slide list, live-edit checks, thumbnails),
// music (whichever app plays it, + fades), capture (screen copy of the show window + audio/display reads).
const { Helper } = require('../helper');
const { PowerPoint } = require('../powerpoint');
const { LocalMusic } = require('../localmusic');
const { Output } = require('../output');
const { ProgramFeed } = require('../programfeed');

function create() {
  const control = new Helper('control', { timeoutMs: 15000 });
  // The background slide watcher slowly grows in memory (~8 MB/min under constant load in stress
  // tests), so it is replaced by a fresh process every 1000 calls.
  const thumbs = new Helper('thumbs', { timeoutMs: 30000, recycleAfter: Number(process.env.STAGIO_THUMB_RECYCLE) || 1000 });
  const music = new Helper('music', { timeoutMs: 15000 });
  const capture = new Helper('capture', { timeoutMs: 10000 });
  // Stagio's own Wi-Fi and the Bluetooth remote: started only when used, and kept apart so
  // opening a network (seconds) never holds up a slide or music command.
  const net = new Helper('net', { timeoutMs: 30000 });
  const ppt = new PowerPoint(control, thumbs);
  return {
    os: 'windows',
    // What the console can offer on this platform.
    features: { audioDeviceSwitch: true, displayMode: true, showMonitor: true, liveCapture: true, liveEdits: true, presenterView: true, builds: true, fastCopy: true, ownWifi: true, bluetooth: true, preview: true },
    ppt,
    program: new ProgramFeed(capture, () => !!ppt.state.show, () => ppt.ratio),
    localMusic: new LocalMusic(music),
    // Reading audio devices can take 1–3 s on some PCs; it shares the capture helper so it never
    // sits in front of a slide command.
    output: new Output(capture),
    helpers: { control, thumbs, music, capture, net },
    timings: () => control.stats,
    stop() { for (const h of [control, thumbs, music, capture, net]) h.stop(); },
  };
}

module.exports = { create };
