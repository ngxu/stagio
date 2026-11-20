// Controls the Spotify desktop app on this PC without the Web API (works with a free account).
// Play/pause/skip go through Windows media controls; fades change only Spotify's own audio
// volume, so the system volume and other apps are untouched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withFades } = require('./fade');

const NO_AUDIO = 'Spotify has not played audio yet; play a track before changing its level';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LocalMusic {
  constructor(control) {
    this.control = control;
    this.state = null;
    this.error = null;
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
      this.state = await this.control.call('music.state');
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
  }

  summary() {
    const s = this.state || {};
    // The helper reports a local file path; the console gets a URL that changes per track.
    const art = s.art ? `/api/music/art?f=${encodeURIComponent(path.basename(s.art))}` : null;
    return { ...s, art, error: this.error, fading: this.fading };
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
  /** After a pause: until Spotify reports it stopped, and what it had already sent has played out. */
  async waitStopped() {
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      await this.poll();
      if (!this.state?.isPlaying) break;
      await sleep(100);
    }
    await sleep(400);
  }
  /** Right after play: silences Spotify's audio the moment Windows has it (see SilenceWhenReady). */
  silenceWhenReady() {
    return this.control.call('music.silenceWhenReady', { ms: 3000 }, { timeoutMs: 8000 }).catch(() => false);
  }

  // ---- same method names as the Spotify Web API client, so cues work with either ----
  do(action) { return this.control.call('music.do', { action }); }
  launch() { return this.control.call('music.launch'); }
  play() { return this.do('play'); }
  pause() { return this.do('pause'); }
  next() { return this.do('next'); }
  previous() { return this.do('previous'); }
  togglePlay() { return this.do('toggle'); }
}

module.exports = { LocalMusic };
