// Checks the Mac helper (build/mac-helper/stagio-mac-helper) on a Mac without PowerPoint, a
// projector or Bluetooth (e.g. GitHub's): every command must answer, nothing may crash.
// Run: node test/mac-helper-check.js   (exit code 1 if anything fails)
const path = require('path');
const os = require('os');
const { Native } = require('../lib/platform/mac/native');

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

(async () => {
  const n = new Native(path.join(__dirname, '..', 'build', 'mac-helper', 'stagio-mac-helper'));
  try {
    check('helper starts and answers', (await n.call('ping')) === 'pong');
    const d = await n.call('displays');
    check('lists the screens', Array.isArray(d) && d.length >= 1, JSON.stringify(d));
    const a = await n.call('audio.devices');
    check('lists audio outputs (may be none on a server)', Array.isArray(a.devices), JSON.stringify(a.devices));
    const c = await n.call('show.capture', { out: path.join(os.tmpdir(), 'od-cap.jpg'), width: 960, ratio: 16 / 9 }, { timeoutMs: 20000 });
    check('slide show capture answers without PowerPoint', ['none', 'permission', 'unsupported'].includes(c), c);
    const s = await n.call('show.captureSlide', { out: path.join(os.tmpdir(), 'od-slide'), ratio: 16 / 9, ref: '' }, { timeoutMs: 20000 });
    check('...and the slide capture too', ['none', 'permission', 'unsupported'].includes(s), s);
    const b = await n.call('ble.start', {}, { timeoutMs: 20000 });
    check('Bluetooth start answers (no Bluetooth here)', typeof b === 'string', b);
    check('...status', typeof (await n.call('ble.status')) === 'string');
    check('...take', Array.isArray(await n.call('ble.take')));
    await n.call('ble.stop');
    const m = await n.call('mirror', { on: true }).then(() => 'changed', (e) => e.message);
    check('Duplicate with one screen is refused politely', /one screen|refused/i.test(m), m);
    const u = await n.call('nope').then(() => 'answered', (e) => e.message);
    check('unknown command is an error, not a crash', /Unknown command/.test(u), u);
    // A real capture, of another app's window (no PowerPoint here): TextEdit, opened by the
    // workflow before this check (MAC_CAPTURE_TEST=1).
    if (process.env.MAC_CAPTURE_TEST) {
      await n.call('test.useApp', { bundle: 'com.apple.TextEdit' });
      const fs = require('fs');
      const out = path.join(os.tmpdir(), 'od-window.jpg');
      const r = await n.call('show.capture', { out, width: 960, ratio: 0 }, { timeoutMs: 20000 });
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      check('captures a real window (TextEdit standing in for the slide show)', r === 'ok' && size > 1000, `${r}, ${size} bytes`);
      const base = path.join(os.tmpdir(), 'od-window-slide');
      const r2 = await n.call('show.captureSlide', { out: base, ratio: 16 / 9, ref: '' }, { timeoutMs: 20000 });
      check('...saves it as a slide image (640 + 256 px, cut to 16:9)', r2 === 'ok' && fs.existsSync(`${base}.jpg`) && fs.existsSync(`${base}.s.jpg`), r2);
      const r3 = await n.call('show.captureSlide', { out: `${base}-x`, ratio: 16 / 9, ref: `${base}.jpg` }, { timeoutMs: 20000 });
      check('...and a second picture matches the first (the comparison works)', r3 === 'ok', r3);
      await n.call('test.useApp', { bundle: '' });
    } else {
      console.log('SKIP  real window capture (set MAC_CAPTURE_TEST=1 with TextEdit open)');
    }
    check('still alive after all that', (await n.call('ping')) === 'pong');
  } catch (e) {
    check('ran to the end', false, e.stack);
  } finally {
    n.stop();
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
