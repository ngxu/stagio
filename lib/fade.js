// Shared fade logic for the music controllers (Windows: any app in the media controls; Mac: Music or Spotify).
//
// `level` is the music's normal volume: the volume a fade-in returns to and a fade-out restores
// after pausing. It is only learned from a volume that isn't mid-fade (or set explicitly), so
// pressing fade-in/fade-out repeatedly can never ratchet the music quieter and quieter.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Moves the volume from `from` to `to` over `seconds`. Steps follow the clock, so a slow
 * volume call can't stretch the fade. Returns false if another fade took over.
 */
async function ramp(setVol, from, to, seconds, isCurrent, stepMs) {
  const start = Date.now();
  const dur = Math.max(0.1, seconds) * 1000;
  let last = null;
  for (;;) {
    if (!isCurrent()) return false;
    const f = Math.min(1, (Date.now() - start) / dur);
    const v = Math.round(from + (to - from) * f);
    if (v !== last) { await setVol(v).catch(() => {}); last = v; }
    if (f >= 1) return isCurrent();
    await sleep(stepMs);
  }
}

/**
 * Adds fadeOut/fadeIn/cancelFade/setVolume to a controller that provides:
 *   poll(), play(), pause(), rawVolume(v), and readout() -> { playing, volume, canSetVolume }.
 * Optional, for smooth fades (local mode; see lib/localmusic.js):
 *   glide(from, to, seconds, isCurrent) -> true when done (used instead of stepping rawVolume),
 *   glideTo(v)          a level set by hand, as a short glide instead of a jump,
 *   waitStopped()       after pausing, until no more sound comes out,
 *   silenceWhenReady()  after starting playback, silences the music the moment it exists.
 */
function withFades(target, { stepMs }) {
  Object.assign(target, {
    fadeToken: 0,
    fading: null,
    level: null,

    cancelFade() { this.fadeToken++; this.fading = null; },

    /** Explicit volume change by the operator or a cue: this becomes the normal level. */
    async setVolume(v) {
      this.cancelFade();
      const n = Math.max(0, Math.min(100, Math.round(v)));
      await (this.glideTo ? this.glideTo(n) : this.rawVolume(n));
      if (n > 0) this.level = n;
    },

    /** Moves the volume over `seconds`: the controller's own glide if it has one, else in steps. */
    move(from, to, seconds, current) {
      return this.glide
        ? this.glide(from, to, seconds, current).catch(() => false)
        : ramp((v) => this.rawVolume(v), from, to, seconds, current, stepMs);
    },

    async fadeOut(seconds = 3) {
      const token = ++this.fadeToken;
      const interrupting = !!this.fading;
      this.fading = 'out'; // set immediately so the console shows it without delay
      const current = () => token === this.fadeToken;
      try {
        await this.poll();
        if (!current()) return;
        const r = this.readout();
        if (!r.playing) return;
        if (!r.canSetVolume) { await this.pause(); return; }
        const from = r.volume ?? 100;
        if (!interrupting && from > 0) this.level = from;
        const level = this.level ?? 100;
        if (await this.move(from, 0, seconds, current)) {
          await this.pause();
          // Only then back to the normal level, ready for the next play: restored while sound
          // was still coming out, the last moment of the music would play at full level.
          await (this.waitStopped ? this.waitStopped() : sleep(300));
          if (current()) await this.rawVolume(level).catch(() => {});
        }
      } finally {
        if (current()) this.fading = null;
      }
    },

    /**
     * From level `from` (null: where it is now) to level `to`, over `seconds`. Music that is
     * stopped starts at `from` (or silence). To 0 it ends like a fade-out: paused, the level put
     * back for the next play. The level reached becomes the normal level (what Fade in returns to).
     */
    async fadeTo(to, seconds = 3, from = null) {
      const target = Math.max(0, Math.min(100, Math.round(Number(to))));
      if (!Number.isFinite(target)) throw new Error('Enter the level to fade to (0-100)');
      const start = from === null || from === undefined || from === '' ? null : Math.max(0, Math.min(100, Math.round(Number(from))));
      const token = ++this.fadeToken;
      this.fading = target === 0 ? 'out' : 'in';
      const current = () => token === this.fadeToken;
      try {
        await this.poll();
        if (!current()) return;
        const r = this.readout();
        if (!r.canSetVolume) { if (target === 0 && r.playing) await this.pause(); else if (!r.playing && target > 0) await this.play(); return; }
        let at;
        if (!r.playing) {
          if (target === 0) return; // stopped already
          await this.rawVolume(0).catch(() => {});
          await this.play();
          if (this.silenceWhenReady) await this.silenceWhenReady(); else await this.rawVolume(0).catch(() => {});
          at = 0;
          if (start) { if (!(await this.move(0, start, 0.3, current))) return; at = start; } // up to "from", without a click
        } else {
          at = r.volume ?? 0;
          if (start !== null && start !== at) { if (!(await this.move(at, start, 0.3, current))) return; at = start; }
        }
        if (target > 0) this.level = target;
        const restore = this.level ?? (at > 0 ? at : 100);
        if (!(await this.move(at, target, seconds, current))) return;
        if (target === 0) {
          await this.pause();
          await (this.waitStopped ? this.waitStopped() : sleep(300));
          if (current()) await this.rawVolume(restore).catch(() => {});
        }
      } finally {
        if (current()) this.fading = null;
      }
    },

    async fadeIn(seconds = 3, targetVolume) {
      const token = ++this.fadeToken;
      const interrupting = !!this.fading;
      this.fading = 'in';
      const current = () => token === this.fadeToken;
      try {
        await this.poll();
        if (!current()) return;
        const r = this.readout();
        if (targetVolume !== undefined && targetVolume !== null && targetVolume !== '') this.level = Number(targetVolume);
        else if (!interrupting && r.playing && r.volume > 0) this.level = this.level ?? r.volume;
        const level = this.level ?? (r.volume > 0 ? r.volume : 100);
        this.level = level;
        let from;
        if (!r.playing) {
          await this.rawVolume(0).catch(() => {});
          await this.play();
          // Again: an app that has not played since it was opened only has a volume once it
          // plays. Silenced the moment it appears, so the fade doesn't start with a loud burst.
          if (this.silenceWhenReady) await this.silenceWhenReady();
          else await this.rawVolume(0).catch(() => {});
          from = 0;
        } else {
          from = r.volume ?? 0; // e.g. interrupting a fade-out: rise from where it is now
        }
        if (!r.canSetVolume) return;
        await this.move(from, level, seconds, current);
      } finally {
        if (current()) this.fading = null;
      }
    },
  });
  return target;
}

module.exports = { withFades };
