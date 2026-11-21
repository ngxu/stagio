// Music from whichever app plays it on this PC: Spotify, Apple Music, Media Player, a browser tab,
// any player that shows up in Windows' media controls. No account or sign-in is involved.
// Play/pause/skip go through Windows' media controls; fades change only that app's own audio
// volume, so the system volume and other apps are untouched (ps/helper.ps1, "Music").
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withFades } = require('./fade');

const NO_AUDIO = 'The music app has not played any sound yet: start the music before changing its level';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LocalMusic {
  constructor(control) {
    this.control = control;
    this.state = null;
    this.error = null;
    /** The app chosen in Stagio ('' = follow whatever plays); set by the server from the settings. */
    this.sourceFn = () => '';
    /** The app followed last time ({ id, name, path }), so "Open" can start it again. */
    this.lastAppFn = () => null;
    withFades(this, { stepMs: 80 });
    // The helper keeps the current album art in a temp file; drop the ones earlier runs left.
    try {
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (/^(stagio|onedesk)-art-.*\.img$/.test(f)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
      }
    } catch { /* temp folder not listable: nothing to clean */ }
  }

  async poll() {
    try {
      this.state = await this.control.call('music.state', { source: this.sourceFn() || '' });
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
  }

  summary() {
    const s = this.state || {};
    // The helper reports a local file path; the console gets a URL that changes per track.
    const art = s.art ? `/api/music/art?f=${encodeURIComponent(path.basename(s.art))}` : null;
    const app = s.app ? { id: s.app.id, name: s.app.name } : null;
    const last = this.lastAppFn();
    return {
      ...s, app, art, error: this.error, fading: this.fading,
      sources: (s.sources || []).map((x) => ({ id: x.id, name: x.name, playing: !!x.playing })),
      pinned: this.sourceFn() || '',
      lastApp: last ? { id: last.id, name: last.name } : null,
    };
  }

  /** Path of the current album-art file, if any. */
  artFile() { return this.state?.art || null; }

  // ---- used by withFades ----
  readout() {
    const s = this.state || {};
    return { playing: !!s.isPlaying, volume: s.volume >= 0 ? s.volume : null, canSetVolume: true };
  }
  async rawVolume(v) {
    const n = await this.control.call('music.volume', { value: Math.round(v) });
    if (!n) throw new Error(NO_AUDIO);
  }

  // Fades run inside the helper, in steps of ~2 ms along a decibel line (AppVolume.StartFade in
  // helper.ps1): stepping the level from here, a few points every 0.1 s, made the music crackle.
  async glide(from, to, seconds, isCurrent) {
    // From the level it has right now (a fade being interrupted may have moved it since the last poll).
    const id = await this.control.call('music.fade', { from: -1, to: Math.round(to), ms: Math.round(seconds * 1000) });
    if (!id) throw new Error(NO_AUDIO);
    const deadline = Date.now() + seconds * 1000 + 5000;
    for (;;) {
      await sleep(120);
      if (!isCurrent()) { await this.control.call('music.fadeStop', { id }).catch(() => {}); return false; }
      const st = await this.control.call('music.fadeStatus', { id }).catch(() => null);
      if (st && st.state !== 'running') return st.state === 'done' && isCurrent();
      if (Date.now() > deadline) return isCurrent();
    }
  }
  /** A level set by hand (slider, cue): a 0.3 s glide, since a jump clicks while music plays. */
  async glideTo(v) {
    const n = await this.control.call('music.volume', { value: Math.round(v), glideMs: 300 });
    if (!n) throw new Error(NO_AUDIO);
  }
  /** After a pause: until the app reports it stopped, and what it had already sent has played out. */
  async waitStopped() {
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      await this.poll();
      if (!this.state?.isPlaying) break;
      await sleep(100);
    }
    await sleep(400);
  }
  /** Right after play: silences the app's audio the moment Windows has it (see SilenceWhenReady). */
  silenceWhenReady() {
    return this.control.call('music.silenceWhenReady', { ms: 3000 }, { timeoutMs: 8000 }).catch(() => false);
  }

  do(action, extra = {}) { return this.control.call('music.do', { action, source: this.sourceFn() || '', ...extra }); }
  launch() {
    const app = this.sourceFn() ? { id: this.sourceFn(), path: this.lastAppFn()?.id === this.sourceFn() ? this.lastAppFn()?.path : '' } : this.lastAppFn();
    return this.control.call('music.launch', { id: app?.id || '', path: app?.path || '' });
  }
  play() { return this.do('play'); }
  pause() { return this.do('pause'); }
  next() { return this.do('next'); }
  previous() { return this.do('previous'); }
  togglePlay() { return this.do('toggle'); }
  seek(ms) { return this.do('seek', { ms: Math.max(0, Math.round(Number(ms) || 0)) }); }
}

module.exports = { LocalMusic };
