// macOS. Controls PowerPoint for Mac and the music app (Music or Spotify) with AppleScript, system volume with
// built-in AppleScript commands, and the rest through the Mac helper (mac/helper/main.swift):
// screens (Duplicate / Extend), audio outputs, the live slide-show picture and Bluetooth.
// Built and checked on GitHub's Macs; not yet run with PowerPoint on a real Mac (see README).
const { PowerPointMac } = require('./powerpoint');
const { LocalMusicMac } = require('./music');
const { OutputMac } = require('./output');
const { Native } = require('./native');
const { ProgramFeed } = require('../../programfeed');

function create() {
  const native = new Native();
  const ppt = new PowerPointMac();
  const localMusic = new LocalMusicMac();
  const output = new OutputMac(native);
  // The slide-show window is captured itself (ScreenCaptureKit), so the live picture works even
  // on a single screen with Stagio in front. Needs macOS 14 and the Screen Recording permission.
  const program = native.available
    ? new ProgramFeed(native, () => !!ppt.state.show, () => ppt.ratio)
    : { status: 'unsupported', file: null, onChange: () => {}, start() {}, summary: () => ({ live: false, status: 'unsupported', url: null }) };
  return {
    os: 'mac',
    beta: true,
    features: {
      audioDeviceSwitch: output.canSwitchAudio,
      displayMode: native.available,
      displayModes: ['clone', 'extend'], // a Mac can't switch one screen off
      showMonitor: false,
      liveCapture: native.available,
      liveEdits: true,
      presenterView: false,
      builds: false,
      fastCopy: false,       // PowerPoint for Mac doesn't have the slow-text problem it solves
      ownWifi: false,        // macOS doesn't let an app open a Wi-Fi network: phone hotspot instead
      hotspotGuide: true,
      bluetooth: native.available,
      macCheck: true,
    },
    ppt,
    program,
    localMusic,
    output,
    native,
    // The Bluetooth commands have the same names as on Windows (server.js uses helpers.net).
    helpers: native.available ? { net: native } : {},
    timings: () => ({ ...ppt.q.stats, ...localMusic.q.stats }),
    // Settings → Mac check (see check.js).
    check: (version) => require('./check').macCheck({ native, ppt, version }),
    stop() { native.stop(); },
  };
}

module.exports = { create };
