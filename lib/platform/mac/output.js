// Audio and display output on Mac.
//   - System volume and mute: built into AppleScript.
//   - Audio devices and screens: the Mac helper (CoreAudio / CoreGraphics, mac/helper/main.swift).
//     Without the helper (running from source without building it): system_profiler, and switching
//     audio devices only with SwitchAudioSource installed.
//   - Display mode: Duplicate (mirror) and Extend. macOS has no official way to switch a screen
//     off, so "PC only" / "Projector only" are not offered (closing the lid is the Mac's way).
const fs = require('fs');
const { execFile } = require('child_process');
const { osa, num } = require('./osa');

const run = (cmd, args, timeout = 15000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out))));
});

const SWITCHERS = ['/opt/homebrew/bin/SwitchAudioSource', '/usr/local/bin/SwitchAudioSource'];

class OutputMac {
  constructor(native) {
    this.native = native?.available ? native : null;
    this.audio = null;
    this.displays = null;
    this.displayMode = null;
    this.devices = [];
    this.devicesAt = 0;
    this.switcher = null;
    for (const p of SWITCHERS) { try { fs.accessSync(p); this.switcher = p; break; } catch { /* not installed */ } }
  }

  get canSwitchAudio() { return !!this.native || !!this.switcher; }

  async readDevices() {
    if (this.native) return (await this.native.call('audio.devices')).devices;
    const json = JSON.parse(await run('system_profiler', ['SPAudioDataType', '-json']));
    const items = (json.SPAudioDataType || []).flatMap((x) => x._items || []);
    return items
      .filter((d) => d.coreaudio_device_output)
      .map((d) => ({ id: d._name, name: d._name, isDefault: d.coreaudio_default_audio_output_device === 'spaudio_yes' }));
  }

  async pollAudio() {
    try {
      // The helper answers at once; system_profiler takes about a second, so it is read less often.
      if (this.native || Date.now() - this.devicesAt > 15000) { this.devices = await this.readDevices(); this.devicesAt = Date.now(); }
      const out = await osa('set s to get volume settings\nreturn ((output volume of s) as string) & US & ((output muted of s) as string)');
      const [vol, muted] = out.split(String.fromCharCode(31));
      this.audio = { devices: this.devices, volume: Math.round(num(vol)), mute: /true/i.test(muted), canSwitch: this.canSwitchAudio };
    } catch (e) {
      this.audio = { error: e.message, devices: this.devices };
    }
  }

  async pollDisplays() {
    if (this.native) {
      try {
        const list = await this.native.call('displays');
        const screens = list.map((d) => ({ device: String(d.id), name: d.name, primary: d.main, width: d.width, height: d.height, scale: d.scale, builtin: d.builtin, mirrorOf: d.mirrorOf }));
        this.displays = { screens, pptMonitor: null };
        // What the screens are doing now (macOS reports it, unlike Windows).
        if (screens.length >= 2) this.displayMode = screens.some((s) => s.mirrorOf) ? 'clone' : 'extend';
      } catch (e) { this.displays = { error: e.message, screens: [] }; }
      return;
    }
    if (this.displays && Date.now() - (this.displaysAt || 0) < 30000) return; // system_profiler is slow
    this.displaysAt = Date.now();
    try {
      const json = JSON.parse(await run('system_profiler', ['SPDisplaysDataType', '-json']));
      const screens = (json.SPDisplaysDataType || []).flatMap((g) => g.spdisplays_ndrvs || []).map((d) => {
        const m = String(d._spdisplays_resolution || d.spdisplays_resolution || '').match(/(\d+)\s*x\s*(\d+)/);
        return { device: d._name, primary: d.spdisplays_main === 'spdisplays_yes', width: m ? +m[1] : 0, height: m ? +m[2] : 0 };
      });
      this.displays = { screens, pptMonitor: null };
    } catch (e) {
      this.displays = { error: e.message, screens: [] };
    }
  }

  async setDevice(id) {
    if (this.native) { await this.native.call('audio.setDefault', { id }); this.devicesAt = 0; return; }
    if (!this.switcher) throw new Error('Switching the audio device needs the Stagio helper (or SwitchAudioSource: brew install switchaudio-osx)');
    await run(this.switcher, ['-t', 'output', '-s', id]);
    this.devicesAt = 0;
  }

  /** Glides from the current level to `value` in ten steps over ~0.4 s, in one AppleScript run. */
  setVolume(value) {
    const to = Math.max(0, Math.min(100, Math.round(value)));
    return osa([
      'set startV to output volume of (get volume settings)',
      'repeat with i from 1 to 10',
      `  set volume output volume (startV + (${to} - startV) * i / 10)`,
      '  delay 0.04',
      'end repeat',
    ].join('\n'));
  }
  setMute(mute) { return osa(`set volume output muted ${mute ? 'true' : 'false'}`); }

  /** Duplicate or Extend. ("PC only" / "Projector only" don't exist on a Mac.) */
  async setDisplayMode(mode) {
    if (mode !== 'clone' && mode !== 'extend') {
      throw new Error('A Mac can\'t switch one screen off. For the projector only, close the laptop lid (with power, keyboard and mouse connected); otherwise use Duplicate or Extend.');
    }
    if (!this.native) throw new Error('Display mode needs the Stagio helper. Use System Settings → Displays.');
    await this.native.call('mirror', { on: mode === 'clone' }, { timeoutMs: 20000 });
    this.displayMode = mode;
    setTimeout(() => this.pollDisplays(), 2500);
  }
}

module.exports = { OutputMac };
