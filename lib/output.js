// Audio output device / system volume and projector display mode.
const { execFile } = require('child_process');

const DISPLAY_MODES = { internal: '/internal', clone: '/clone', extend: '/extend', external: '/external' };

class Output {
  constructor(control) {
    this.control = control;
    this.audio = null;
    this.displays = null;
    this.displayMode = null; // last mode chosen from Stagio (Windows does not report it back)
  }

  async pollAudio() {
    try { this.audio = await this.control.call('audio.state'); } catch (e) { this.audio = { error: e.message }; }
  }

  async pollDisplays() {
    try { this.displays = await this.control.call('display.list'); } catch (e) { this.displays = { error: e.message }; }
  }

  setDevice(id) { return this.control.call('audio.setDefault', { id }); }
  /** Glides from the current level to `value` over 0.4 s (a jump is heard as a bump or a click). */
  setVolume(value) { return this.control.call('audio.volume', { value, glideMs: 400 }); }
  setMute(mute) { return this.control.call('audio.mute', { mute }); }

  setDisplayMode(mode) {
    const flag = DISPLAY_MODES[mode];
    if (!flag) return Promise.reject(new Error(`Unknown display mode: ${mode}`));
    return new Promise((resolve, reject) => {
      execFile('DisplaySwitch.exe', [flag], { windowsHide: true }, (err) => {
        if (err) return reject(err);
        this.displayMode = mode;
        // Screens take a moment to re-enumerate after switching.
        setTimeout(() => this.pollDisplays(), 2500);
        resolve();
      });
    });
  }
}

module.exports = { Output, DISPLAY_MODES };
