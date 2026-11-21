// Cues: one button runs a sequence of actions across music, slides and outputs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Music steps were called "spotify.*" before 1.2 / 1.3 (config.js renames them; this is a fallback).
const stepType = (t) => String(t || '').replace(/^spotify\./, 'music.');

// Step catalogue, shared with the UI's cue editor.
const STEP_TYPES = {
  'music.play':       { label: 'Music · play', params: [] },
  'music.pause':      { label: 'Music · pause', params: [] },
  'music.next':       { label: 'Music · next track', params: [] },
  'music.fadeOut':    { label: 'Music · fade out and pause', params: [{ key: 'seconds', label: 'sec', type: 'number', default: 3 }] },
  'music.fadeIn':     { label: 'Music · fade in', params: [{ key: 'seconds', label: 'sec', type: 'number', default: 3 }, { key: 'volume', label: 'level', type: 'number', default: 60 }] },
  'music.volume':     { label: 'Music · set level', params: [{ key: 'volume', label: 'level', type: 'number', default: 60 }] },
  'music.fadeTo':     { label: 'Music · fade from level to level', params: [{ key: 'from', label: 'from (blank: now)', type: 'text', default: '' }, { key: 'to', label: 'to', type: 'number', default: 30 }, { key: 'seconds', label: 'sec', type: 'number', default: 3 }] },
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
  constructor({ ppt, output, music }) {
    this.music = music; // () => the music controller, or null when music is off (or Lite)
    this.ppt = ppt;
    this.output = output;
    this.running = null; // { id, step, total }
  }

  async runStep(s) {
    const { ppt, output } = this;
    const music = this.music();
    switch (stepType(s.type)) {
      case 'music.play': return music.play();
      case 'music.pause': return music.pause();
      case 'music.next': return music.next();
      case 'music.fadeOut': return music.fadeOut(Number(s.seconds) || 3);
      case 'music.fadeIn': return music.fadeIn(Number(s.seconds) || 3, s.volume !== undefined && s.volume !== '' ? Number(s.volume) : undefined);
      case 'music.volume': return music.setVolume(Number(s.volume));
      case 'music.fadeTo': return music.fadeTo(Number(s.to), Number(s.seconds) || 3, s.from === '' || s.from === undefined || s.from === null ? null : Number(s.from));
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
        if (stepType(step.type).startsWith('music.') && !this.music()) continue;
        try {
          // Fades run in the background so the next step (e.g. switching slides) happens right away.
          if (stepType(step.type).startsWith('music.fade') && step.wait !== true) {
            this.runStep(step).catch((e) => errors.push(`${STEP_TYPES[stepType(step.type)]?.label}: ${e.message}`));
          } else {
            await this.runStep(step);
          }
        } catch (e) {
          errors.push(`${STEP_TYPES[stepType(step.type)]?.label || step.type}: ${e.message}`);
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
