// Live "program" feed: about once a second, copies the slide-show window from the screen.
// Runs in its own helper and never talks to PowerPoint, so it can't slow the show down.
// When the show window is covered (e.g. a single screen with the console on top) the console
// falls back to the rendered slide thumbnail.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.tmpdir(), 'stagio-program');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ProgramFeed {
  constructor(helper, isShowing, ratio = () => 0) {
    this.helper = helper;
    this.isShowing = isShowing; // () => true while a slide show is running
    this.ratio = ratio;         // () => the slide's width / height: the picture is cut to the slide
    this.status = 'none';       // ok | covered | hidden | none | geometry | error
    this.seq = 0;
    this.file = null;
    this.at = 0;
    this.onChange = () => {};
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
  }

  start() {
    const loop = async () => {
      for (;;) {
        if (!this.isShowing()) {
          if (this.status !== 'none') { this.status = 'none'; this.onChange(); }
          await sleep(500);
          continue;
        }
        const out = path.join(DIR, `p${this.seq % 2}.jpg`); // alternate so a file is never read mid-write
        let status;
        try { status = await this.helper.call('show.capture', { out, width: 960, ratio: this.ratio() || 0 }); } catch { status = 'error'; }
        if (status === 'ok') { this.file = out; this.seq++; this.at = Date.now(); }
        if (status === 'ok' || status !== this.status) { this.status = status; this.onChange(); }
        await sleep(1000);
      }
    };
    loop();
  }

  /**
   * Saves the projected slide as that slide's image (see ShowCapture.CaptureSlide in helper.ps1):
   * "ok", or why not ("unstable", "pointer", "covered", "mismatch", …). Only while the live feed
   * works. `ref`: PowerPoint's own image of that slide, if there is one; a copy that doesn't look
   * like it (cut off, shifted) is not kept.
   */
  async captureSlide({ out, ratio, ref }) {
    if (this.status !== 'ok') return this.status;
    try { return await this.helper.call('show.captureSlide', { out, ratio, ref: ref || '' }, { timeoutMs: 5000 }); } catch { return 'error'; }
  }

  /** For the live state: a fresh capture URL, or null when the console should use thumbnails. */
  summary() {
    const live = this.status === 'ok' && Date.now() - this.at < 4000;
    return { live, status: this.status, url: live ? `/api/program?s=${this.seq}` : null };
  }
}

module.exports = { ProgramFeed };
