// Music on the Mac via AppleScript: Apple's Music app or the Spotify app (no account or sign-in
// needed). BETA, untested on a Mac. macOS doesn't let other apps read what any player is playing,
// so on the Mac it is these two. Same interface as lib/localmusic.js; fades change the app's own
// volume ("sound volume").
const { withFades } = require('../../fade');
const { Queue, records, num } = require('./osa');

// Each app gets its own script: one that names an app that isn't installed would not even compile.
const APPS = {
  Music: { name: 'Music', msDuration: false },     // duration in seconds
  Spotify: { name: 'Spotify', msDuration: true },  // duration in milliseconds
};

class LocalMusicMac {
  constructor() {
    this.q = new Queue();
    this.state = null;
    this.error = null;
    this.current = null; // 'Music' | 'Spotify': the app followed
    this.sourceFn = () => '';
    this.lastAppFn = () => null;
    withFades(this, { stepMs: 120 });
  }

  /** Which of the two apps are running (System Events: asking an app itself would start it). */
  async running() {
    const out = await this.q.run('music.running', `
      tell application "System Events"
        set r to ""
        if exists (process "Music") then set r to r & "Music,"
        if exists (process "Spotify") then set r to r & "Spotify,"
        return r
      end tell`);
    return String(out).split(',').filter((x) => APPS[x]);
  }

  async readApp(app) {
    const out = await this.q.run(`music.state.${app}`, `
      tell application "${app}"
        set st to (player state as string)
        set vol to sound volume
        try
          set t to current track
          return st & US & (name of t) & US & (artist of t) & US & (album of t) & US & (duration of t) & US & (player position) & US & vol
        on error
          return st & US & "" & US & "" & US & "" & US & 0 & US & 0 & US & vol
        end try
      end tell`);
    const [r] = records(out);
    const [st, title, artist, album, dur, pos, vol] = r;
    return {
      running: true,
      session: !!title,
      isPlaying: /playing/i.test(st),
      status: st,
      title, artist, album,
      art: null,
      durationMs: Math.round(num(dur) * (APPS[app].msDuration ? 1 : 1000)),
      positionMs: Math.round(num(pos) * 1000), // both report the position in seconds
      volume: Math.round(num(vol)),
      canSeek: true,
      app: { id: app, name: app },
    };
  }

  async poll() {
    try {
      const want = APPS[this.sourceFn()] ? this.sourceFn() : '';
      const up = await this.running();
      const sources = [];
      const states = {};
      for (const app of up) {
        states[app] = await this.readApp(app).catch(() => null);
        sources.push({ id: app, name: app, playing: !!states[app]?.isPlaying });
      }
      // Chosen app, or: the one followed while it plays, else one that plays, else the one followed, else any.
      let pick = want;
      if (!pick) {
        const playing = up.filter((a) => states[a]?.isPlaying);
        pick = playing.includes(this.current) ? this.current : playing[0] || (up.includes(this.current) ? this.current : up[0]) || '';
      }
      if (pick && states[pick]) {
        this.current = pick;
        this.state = { ...states[pick], sources };
      } else {
        this.state = { running: false, session: false, volume: -1, sources, app: want ? { id: want, name: want } : null };
      }
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
  }

  summary() {
    const last = this.lastAppFn();
    return { ...(this.state || {}), error: this.error, fading: this.fading, pinned: this.sourceFn() || '', lastApp: last ? { id: last.id, name: last.name } : null };
  }
  artFile() { return null; }

  // ---- used by withFades ----
  readout() {
    const s = this.state || {};
    return { playing: !!s.isPlaying, volume: s.volume >= 0 ? s.volume : null, canSetVolume: true };
  }
  rawVolume(v) { return this.tell(`set sound volume to ${Math.max(0, Math.min(100, Math.round(v)))}`); }

  tell(cmd) {
    const app = (APPS[this.sourceFn()] && this.sourceFn()) || this.current;
    if (!app) return Promise.reject(new Error('No music app to control: start the music in Music or Spotify once'));
    return this.q.run('music.cmd', `
      if application "${app}" is not running then error "${app} is not running"
      tell application "${app}" to ${cmd}`);
  }

  play() { return this.tell('play'); }
  pause() { return this.tell('pause'); }
  next() { return this.tell('next track'); }
  previous() { return this.tell('previous track'); }
  togglePlay() { return this.tell('playpause'); }
  seek(ms) { return this.tell(`set player position to ${Math.max(0, Number(ms) || 0) / 1000}`); }
  launch() {
    const app = (APPS[this.sourceFn()] && this.sourceFn()) || this.lastAppFn()?.id || 'Music';
    return this.q.run('music.launch', `tell application "${APPS[app] ? app : 'Music'}" to activate`);
  }
}

module.exports = { LocalMusicMac };
