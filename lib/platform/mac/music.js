// Spotify desktop app on Mac via AppleScript (works with a free account). BETA, untested on a Mac.
// Same interface as lib/localmusic.js; fades change Spotify's own volume ("sound volume").
const { withFades } = require('../../fade');
const { Queue, records, num } = require('./osa');

class LocalMusicMac {
  constructor() {
    this.q = new Queue();
    this.state = null;
    this.error = null;
    withFades(this, { stepMs: 120 });
  }

  async poll() {
    try {
      const out = await this.q.run('music.state', `
        if application "Spotify" is not running then return "off"
        tell application "Spotify"
          set st to (player state as string)
          set vol to sound volume
          try
            set t to current track
            return "on" & US & st & US & (name of t) & US & (artist of t) & US & (album of t) & US & (artwork url of t) & US & (duration of t) & US & (player position) & US & vol
          on error
            return "on" & US & st & US & "" & US & "" & US & "" & US & "" & US & 0 & US & 0 & US & vol
          end try
        end tell`);
      if (out === 'off') {
        this.state = { running: false, session: false, volume: -1 };
      } else {
        const [r] = records(out);
        const [, st, title, artist, album, art, dur, pos, vol] = r;
        this.state = {
          running: true,
          session: !!title,
          isPlaying: /playing/i.test(st),
          status: st,
          title, artist, album,
          art: art || null,                           // an https URL from Spotify
          durationMs: Math.round(num(dur)),           // Spotify reports milliseconds
          positionMs: Math.round(num(pos) * 1000),    // ...and the position in seconds
          volume: Math.round(num(vol)),
        };
      }
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
  }

  summary() { return { ...(this.state || {}), error: this.error, fading: this.fading }; }
  artFile() { return null; } // artwork is a web URL on Mac

  // ---- used by withFades ----
  readout() {
    const s = this.state || {};
    return { playing: !!s.isPlaying, volume: s.volume >= 0 ? s.volume : null, canSetVolume: true };
  }
  rawVolume(v) { return this.tell(`set sound volume to ${Math.max(0, Math.min(100, Math.round(v)))}`); }

  tell(cmd) {
    return this.q.run('music.cmd', `
      if application "Spotify" is not running then error "Spotify is not running"
      tell application "Spotify" to ${cmd}`);
  }

  play() { return this.tell('play'); }
  pause() { return this.tell('pause'); }
  next() { return this.tell('next track'); }
  previous() { return this.tell('previous track'); }
  togglePlay() { return this.tell('playpause'); }
  launch() { return this.q.run('music.launch', 'tell application "Spotify" to activate'); }
}

module.exports = { LocalMusicMac };
