// "Mac check": what PowerPoint for Mac, macOS and the Stagio helper can do on this Mac, as a text
// report to send back, so the Mac-only parts (Presenter View, which screen the show uses, animation
// steps) can be finished against the real thing. Only reads; changes nothing.
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { osa } = require('./osa');

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 15000 }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
});

async function step(name, fn) {
  try { return `## ${name}\n${await fn()}\n`; } catch (e) { return `## ${name}\nERROR: ${String(e.message || e).trim()}\n`; }
}

const DURING_SHOW = (body) => `tell application "Microsoft PowerPoint"
  if (count of slide show windows) is 0 then return "(no slide show running: run the check again during a show)"
  ${body}
end tell`;

async function macCheck({ native, ppt, version }) {
  const parts = [`${version} · ${process.arch} · ${new Date().toISOString()}`]; // e.g. "Stagio Standard Beta 1.0"
  parts.push(await step('macOS', () => run('sw_vers', [])));
  // Only a running PowerPoint is asked anything (asking one that isn't open would start it, or
  // make macOS ask where it is).
  const running = await osa('tell application "System Events" to return (exists process "Microsoft PowerPoint")').then((r) => /true/i.test(r), () => false);
  if (!running) {
    parts.push('## PowerPoint\nnot running: open your presentation in PowerPoint and run the check again (once more during a slide show)\n');
  }
  const pptStep = (name, fn) => (running ? step(name, fn) : Promise.resolve(''));
  parts.push(await pptStep('PowerPoint version', () => osa('tell application "Microsoft PowerPoint" to return version')));
  parts.push(await pptStep('Slide show settings of the presentation in front', () => osa('tell application "Microsoft PowerPoint" to return properties of slide show settings of active presentation')));
  parts.push(await pptStep('Slide show window', () => osa(DURING_SHOW('return properties of slide show window 1'))));
  parts.push(await pptStep('Slide show view', () => osa(DURING_SHOW('return properties of slide show view of slide show window 1'))));
  parts.push(await pptStep('Animations of the slide on screen', () => osa(DURING_SHOW(`set sl to slide of slide show view of slide show window 1
    try
      return "main sequence steps: " & (count of (main sequence of timeline of sl))
    on error e
      return "timeline: " & e
    end try`))));
  parts.push(await pptStep('PowerPoint windows (needs Accessibility for Stagio)', () => osa('tell application "System Events" to tell process "Microsoft PowerPoint" to return name of every window')));
  parts.push(await pptStep('Menus of PowerPoint (needs Accessibility for Stagio)', () => osa('tell application "System Events" to tell process "Microsoft PowerPoint" to return name of every menu bar item of menu bar 1')));
  parts.push(await pptStep('Items of the slide show menu (needs Accessibility for Stagio)', () => osa(`tell application "System Events" to tell process "Microsoft PowerPoint"
    set out to ""
    repeat with m in menu bar items of menu bar 1
      set n to name of m
      if n contains "Slide" or n contains "幻灯片" or n contains "投影片" then
        set out to out & n & ": " & (name of every menu item of menu 1 of m) & linefeed
      end if
    end repeat
    return out
  end tell`)));
  parts.push(await step('Edit detection', async () => (ppt.fpBroken ? `not working: ${ppt.fpBroken}` : `working (${ppt.sigs.size} slides read)`)));
  parts.push(await step('Slide shape (width / height)', async () => ppt.ratio.toFixed(3)));
  parts.push(await step('Stagio helper', async () => (native.available ? native.call('ping') : 'missing')));
  if (native.available) {
    parts.push(await step('Screens', async () => JSON.stringify(await native.call('displays'), null, 1)));
    parts.push(await step('Audio outputs', async () => JSON.stringify((await native.call('audio.devices')).devices)));
    parts.push(await step('Slide show picture', () => native.call('show.capture', { out: path.join(os.tmpdir(), 'stagio-check.jpg'), width: 640, ratio: ppt.ratio }, { timeoutMs: 20000 })));
    parts.push(await step('Bluetooth', () => native.call('ble.status')));
  }
  return parts.join('\n');
}

module.exports = { macCheck };
