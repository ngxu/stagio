// Cues: one button runs a sequence of actions across music, slides and outputs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Step catalogue, shared with the UI's cue editor.
const STEP_TYPES = {
  'spotify.play':     { label: 'Music · play', params: [] },
  'spotify.pause':    { label: 'Music · pause', params: [] },
  'spotify.next':     { label: 'Music · next track', params: [] },
  'spotify.fadeOut':  { label: 'Music · fade out and pause', params: [{ key: 'seconds', label: 'sec', type: 'number', default: 3 }] },
  'spotify.fadeIn':   { label: 'Music · fade in', params: [{ key: 'seconds', label: 'sec', type: 'number', default: 3 }, { key: 'volume', label: 'level', type: 'number', default: 60 }] },
  'spotify.volume':   { label: 'Music · set level', params: [{ key: 'volume', label: 'level', type: 'number', default: 60 }] },
  'spotify.fadeTo':   { label: 'Music · fade from level to level', params: [{ key: 'from', label: 'from (blank: now)', type: 'text', default: '' }, { key: 'to', label: 'to', type: 'number', default: 30 }, { key: 'seconds', label: 'sec', type: 'number', default: 3 }] },
  'spotify.playUri':  { label: 'Music · play playlist/track (Premium)', params: [{ key: 'uri', label: 'Spotify URI', type: 'text', default: '' }] },
  'ppt.start':        { label: 'Slides · start show', params: [{ key: 'slide', label: 'from slide', type: 'number', default: 1 }] },
  'ppt.goto':         { label: 'Slides · go to slide', params: [{ key: 'slide', label: 'slide', type: 'number', default: 1 }] },
  'ppt.next':         { label: 'Slides · next', params: [] },
  'ppt.prev':         { label: 'Slides · previous', params: [] },
  'ppt.black':        { label: 'Screen · black', params: [] },
  'ppt.white':        { label: 'Screen · white', params: [] },
  'ppt.normal':       { label: 'Screen · show slides', params: [] },
  'ppt.end':          { label: 'Slides · end show', params: [] },
  'audio.device':     { label: 'Output · audio device', params: [{ key: 'id', label: 'device', type: 'audioDevice', default: '' }] },
  'audio.volume':     { label: 'Output · system volume', params: [{ key: 'value', label: 'level', type: 'number', default: 50 }] },
  'display.mode':     { label: 'Output · display mode', params: [{ key: 'mode', label: 'mode', type: 'displayMode', default: 'extend' }] },
  'wait':             { label: 'Wait', params: [{ key: 'seconds', label: 'sec', type: 'number', default: 1 }] },
};

class CueRunner {
  constructor({ ppt, spotify, output, music }) {
    this.music = music; // () => current music controller (local app or Web API), or null when off
    this.ppt = ppt;
    this.spotify = spotify;
    this.output = output;
    this.running = null; // { id, step, total }
  }

  async runStep(s) {
    const { ppt, spotify, output } = this;
    const music = this.music();
    switch (s.type) {
      case 'spotify.play': return music.play({ deviceId: music.deviceId?.() });
      case 'spotify.pause': return music.pause();
      case 'spotify.next': return music.next();
      case 'spotify.fadeOut': return music.fadeOut(Number(s.seconds) || 3);
      case 'spotify.fadeIn': return music.fadeIn(Number(s.seconds) || 3, s.volume !== undefined && s.volume !== '' ? Number(s.volume) : undefined);
      case 'spotify.volume': return music.setVolume(Number(s.volume));
      case 'spotify.fadeTo': return music.fadeTo(Number(s.to), Number(s.seconds) || 3, s.from === '' || s.from === undefined || s.from === null ? null : Number(s.from));
      case 'spotify.playUri': {
        if (music !== spotify) throw new Error('Playing a specific playlist needs Premium mode');
        const uri = String(s.uri || '');
        return uri.includes(':track:') ? spotify.play({ uris: [uri], deviceId: spotify.deviceId() }) : spotify.play({ contextUri: uri, deviceId: spotify.deviceId() });
      }
      case 'ppt.start': return ppt.cmd('ppt.start', { slide: Number(s.slide) || 1 });
      case 'ppt.goto': return ppt.cmd('ppt.goto', { slide: Number(s.slide) || 1 });
      case 'ppt.next': return ppt.cmd('ppt.next');
      case 'ppt.prev': return ppt.cmd('ppt.prev');
      case 'ppt.black': return ppt.state.show?.state === 'black' ? null : ppt.cmd('ppt.setState', { state: 'black' });
      case 'ppt.white': return ppt.state.show?.state === 'white' ? null : ppt.cmd('ppt.setState', { state: 'white' });
      case 'ppt.normal': return ppt.cmd('ppt.setState', { state: 'running' });
      case 'ppt.end': return ppt.cmd('ppt.end');
      case 'audio.device': return output.setDevice(s.id);
      case 'audio.volume': return output.setVolume(Number(s.value));
      case 'display.mode': return output.setDisplayMode(s.mode);
      case 'wait': return sleep((Number(s.seconds) || 0) * 1000);
      default: throw new Error(`Unknown step: ${s.type}`);
    }
  }

  /** Runs every step; a failing step is reported but does not stop the rest of the cue. */
  async run(cue) {
    const errors = [];
    const mine = { id: cue.id, step: 0, total: cue.steps.length };
    this.running = mine;
    try {
      for (let i = 0; i < cue.steps.length; i++) {
        mine.step = i + 1;
        const step = cue.steps[i];
        // Music steps are skipped while music control is switched off.
        if (step.type.startsWith('spotify.') && !this.music()) continue;
        try {
          // Fades run in the background so the next step (e.g. switching slides) happens right away.
          if (step.type.startsWith('spotify.fade') && step.wait !== true) {
            this.runStep(step).catch((e) => errors.push(`${STEP_TYPES[step.type]?.label}: ${e.message}`));
          } else {
            await this.runStep(step);
          }
        } catch (e) {
          errors.push(`${STEP_TYPES[step.type]?.label || step.type}: ${e.message}`);
        }
      }
    } finally {
      // A second cue may have started meanwhile; only clear the indicator if it is still ours.
      if (this.running === mine) this.running = null;
    }
    return errors;
  }
}

module.exports = { CueRunner, STEP_TYPES };
