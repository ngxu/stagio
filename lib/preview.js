// Headphone preview (Standard, Extra; Windows). While it is on, the music app Stagio follows,
// PowerPoint (slide videos) and apps kept on the speakers play on the speakers; every other app
// plays only in the headphones, so the operator can listen to the next song or video before the
// room hears it. The work is done in the helper (Preview-Apply in ps/helper.ps1): Windows' own
// per-app output setting, the one under Settings > Sound > Volume mixer.
//
// Windows remembers an app's output per program, also after a restart. So every program Stagio
// sent somewhere is kept in the settings (cfg.preview.touched) and set back to the default as soon
// as it is seen while the preview is off; the preview always starts off.
//
// Standard: choose the headphones, On/Off, and a prompt when they are plugged in.
// Extra (pro): also which device counts as the speakers, apps kept on the speakers, and per-app
// choices (speakers / headphones), plus a cue step.

const POLL_ON_MS = 600;     // apps that start playing move within about this long
const POLL_TIDY_MS = 1500;  // while off, programs moved earlier are set back when they show up

class Preview {
  /**
   * @param o.control  helper (the music one)
   * @param o.cfg      shared settings; cfg.preview is created here if missing
   * @param o.save     saves the settings
   * @param o.pro      Extra: device for the speakers, kept apps, per-app choices
   * @param o.musicApp () => process name of the music app Stagio follows, or ''
   * @param o.devices  () => the output devices [{ id, name, isDefault }] (from the audio poll)
   * @param o.onChange called when the state shown to consoles changes
   */
  constructor({ control, cfg, save, pro, musicApp, devices, onChange }) {
    Object.assign(this, { control, cfg, save, pro: !!pro, musicApp, devices, onChange: onChange || (() => {}) });
    cfg.preview = { phones: '', room: '', keep: [], overrides: {}, touched: [], ...(cfg.preview || {}) };
    if (!Array.isArray(cfg.preview.keep)) cfg.preview.keep = [];
    if (!Array.isArray(cfg.preview.touched)) cfg.preview.touched = [];
    if (!cfg.preview.overrides || typeof cfg.preview.overrides !== 'object') cfg.preview.overrides = {};
    this.on = false;
    this.available = null;   // unknown until the helper was asked
    this.error = null;
    this.apps = [];
    this.prompt = null;      // { kind: 'plugged' | 'new', id, name }
    this.notice = null;      // { text, at }
    this.lastIds = null;     // output devices seen at the last poll
    this.busy = false;
    this.nextAt = 0;
  }

  get p() { return this.cfg.preview; }

  deviceName(id) { return (this.devices() || []).find((d) => d.id === id)?.name || ''; }

  summary() {
    const p = this.p;
    return {
      on: this.on,
      available: this.available,
      error: this.error,
      phones: p.phones,
      phonesName: this.deviceName(p.phones),
      phonesPresent: !!p.phones && !!this.deviceName(p.phones),
      room: this.pro ? p.room : '',
      keep: this.pro ? p.keep : [],
      overrides: this.pro ? p.overrides : {},
      apps: this.apps,
      prompt: this.prompt,
      notice: this.notice,
      pro: this.pro,
    };
  }

  /** Called often by the server: does the work when something is due. */
  async tick() {
    if (this.busy || Date.now() < this.nextAt) return;
    const due = this.on || this.p.touched.length > 0;
    if (!due) return;
    this.busy = true;
    try { await this.apply(); } finally {
      this.busy = false;
      this.nextAt = Date.now() + (this.on ? POLL_ON_MS : POLL_TIDY_MS);
    }
  }

  async apply() {
    const p = this.p;
    const stay = ['POWERPNT'];
    const music = this.musicApp();
    if (music) stay.push(music);
    if (this.pro) stay.push(...p.keep);
    let r;
    try {
      r = await this.control.call('preview.apply', {
        on: this.on, phones: p.phones, room: this.pro ? p.room : '', stay,
        overrides: this.pro ? p.overrides : {}, touched: p.touched,
      });
    } catch (e) {
      this.error = e.message;
      this.onChange();
      return;
    }
    const before = JSON.stringify([this.apps, this.available, this.error]);
    this.available = !!r.available;
    this.error = r.available ? null : r.error;
    if (!r.available && this.on) this.on = false;
    this.apps = (r.apps || []).map((a) => ({ name: a.name, label: a.label, route: a.route, active: !!a.active }));
    const touched = (r.touched || []).filter(Boolean);
    if (JSON.stringify(touched) !== JSON.stringify(p.touched)) { p.touched = touched; this.save(); }
    if (JSON.stringify([this.apps, this.available, this.error]) !== before) this.onChange();
  }

  async setOn(on) {
    const p = this.p;
    if (on) {
      if (!p.phones) throw new Error('Choose the headphones first');
      if (!this.deviceName(p.phones)) throw new Error('The headphones are not connected');
      // the speakers: the device chosen in Extra, otherwise Windows' default output
      const room = (this.pro && p.room) || (this.devices() || []).find((d) => d.isDefault)?.id;
      if (room === p.phones) {
        throw new Error(this.pro && p.room
          ? 'The speakers and the headphones are the same device'
          : 'The headphones are the default output right now: choose the speakers as the audio device first');
      }
    }
    this.on = !!on;
    this.prompt = null;
    this.nextAt = 0;
    await this.apply();
    this.onChange();
  }

  async configure({ phones, room, keep }) {
    const p = this.p;
    if (typeof phones === 'string') p.phones = phones;
    if (this.pro && typeof room === 'string') p.room = room;
    if (this.pro && Array.isArray(keep)) p.keep = [...new Set(keep.map((k) => String(k).trim()).filter(Boolean))].slice(0, 50);
    this.save();
    if (this.on && !p.phones) this.on = false;
    this.nextAt = 0;
    await this.apply();
    this.onChange();
  }

  /** Extra: one app to the speakers ('room'), the headphones ('phones') or back to the rule ('auto'). */
  async setApp(name, route) {
    if (!this.pro) throw new Error('Per-app choices are part of Stagio Extra');
    const key = String(name || '').trim();
    if (!key) throw new Error('Which app?');
    if (route === 'auto') delete this.p.overrides[key];
    else if (route === 'room' || route === 'phones') this.p.overrides[key] = route;
    else throw new Error('Speakers, headphones or automatic?');
    this.save();
    this.nextAt = 0;
    await this.apply();
    this.onChange();
  }

  dismiss() { this.prompt = null; this.onChange(); }

  /**
   * After each audio poll: the headphones plugged in (ask), unplugged (preview off, everything
   * back on the speakers), or a new output device when none is chosen yet (offer it).
   */
  devicesChanged() {
    const list = this.devices();
    // A failed reading (no list) is not "everything unplugged": wait for the next one.
    if (!Array.isArray(list) || !list.length) return;
    const ids = new Set(list.map((d) => d.id));
    const prev = this.lastIds;
    this.lastIds = ids;
    if (!prev) return; // first poll: nothing was plugged in or out
    const p = this.p;
    if (p.phones && !ids.has(p.phones) && prev.has(p.phones)) {
      this.prompt = null;
      if (this.on) {
        this.on = false;
        this.notice = { text: 'The headphones were unplugged: the preview is off and every app plays on the speakers again.', at: Date.now() };
        this.nextAt = 0;
      }
      this.onChange();
      return;
    }
    if (p.phones && ids.has(p.phones) && !prev.has(p.phones) && !this.on) {
      this.prompt = { kind: 'plugged', id: p.phones, name: this.deviceName(p.phones) };
      this.onChange();
      return;
    }
    if (!p.phones) {
      const fresh = list.find((d) => !prev.has(d.id) && !d.isDefault);
      if (fresh) { this.prompt = { kind: 'new', id: fresh.id, name: fresh.name }; this.onChange(); }
    }
  }

  /** On quit: everything back to the default, as far as the helper still answers. */
  async shutdown() {
    if (!this.on && !this.p.touched.length) return;
    this.on = false;
    try { await this.apply(); } catch { /* the rest is set back at the next start */ }
  }
}

module.exports = { Preview };
