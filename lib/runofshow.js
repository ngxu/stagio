// Run of show (Stagio Extra): an event planned as a list of parts. "Next" goes to the next part
// and does what it needs: open that speaker's file and start its slide show, show the opening
// countdown on the projector, black out and bring the music in, and so on. Each part has a planned
// length, so the console can say how far ahead or behind the event is.
//
// The runs are kept in the shared settings (cfg.shows), the one in progress in cfg.run, so a
// restart of Stagio mid-event carries on where it was (nothing is done again on restart).
//
// Part kinds:
//   slides     open `file`, start its show at `slide`; other files' shows end. Music can fade out.
//   countdown  a countdown on the projector (Stagio's own full-screen window) to a clock time or
//              for some minutes, with a title and notices. Music can fade in, and fades out to
//              end exactly at zero; then the run can go on by itself.
//   music      black screen (if a show is up) and music fading in: a break, walking in or out.
//   manual     only timed: someone talks, nothing to switch.
// Any part can also run one of the cues when it starts.

const fs = require('fs');

const KINDS = ['slides', 'countdown', 'music', 'manual'];
const KIND_NAMES = { slides: 'Slides', countdown: 'Countdown', music: 'Music', manual: 'Manual' };
const clampNum = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const str = (v, max = 200) => String(v ?? '').slice(0, max);
const newId = (p) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** A part as stored: only known fields, numbers in range. */
function cleanPart(x, i) {
  const kind = KINDS.includes(x?.kind) ? x.kind : 'manual';
  const p = {
    id: str(x?.id, 60) || newId('p'),
    name: str(x?.name, 80).trim() || `${KIND_NAMES[kind]} ${i + 1}`,
    kind,
    minutes: clampNum(x?.minutes, 0, 600, 0),
    cue: str(x?.cue, 60),
  };
  if (kind === 'slides') {
    p.file = str(x?.file, 1000).trim().replace(/^"|"$/g, '');
    p.slide = Math.floor(clampNum(x?.slide, 1, 9999, 1));
    p.musicOut = { on: !!x?.musicOut?.on, seconds: clampNum(x?.musicOut?.seconds, 1, 30, 4) };
  }
  if (kind === 'countdown') {
    p.until = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(x?.until || '')) ? String(x.until).padStart(5, '0') : '';
    p.title = str(x?.title, 120);
    p.notices = (Array.isArray(x?.notices) ? x.notices : String(x?.notices || '').split('\n')).map((n) => str(n, 200).trim()).filter(Boolean).slice(0, 12);
    p.fadeOut = clampNum(x?.fadeOut, 0, 30, 5);
    p.autoNext = x?.autoNext !== false;
  }
  if (kind === 'countdown' || kind === 'music') {
    p.musicIn = { on: !!x?.musicIn?.on, volume: clampNum(x?.musicIn?.volume, 0, 100, 60), seconds: clampNum(x?.musicIn?.seconds, 1, 30, 4) };
  }
  if (kind === 'music') p.black = x?.black !== false;
  return p;
}

function cleanShow(x) {
  return {
    id: str(x?.id, 60) || newId('r'),
    name: str(x?.name, 80).trim() || 'Run of show',
    parts: (Array.isArray(x?.parts) ? x.parts : []).slice(0, 60).map(cleanPart),
  };
}

/** Today at "HH:MM" on this computer's clock (ms). */
function todayAt(hhmm, now) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

class RunOfShow {
  /**
   * @param o.cfg       shared settings (cfg.shows, cfg.run)
   * @param o.save      writes the settings
   * @param o.ppt       PowerPoint controller (cmd, state, focus)
   * @param o.music     () => the music controller in use, or null
   * @param o.cues      CueRunner;  o.cueList: () => the cues
   * @param o.onChange  something changed (the console is updated)
   * @param o.segment   (name) => restarts the segment timer under that name
   */
  constructor(o) {
    Object.assign(this, o);
    this.now ||= () => Date.now();
    this.screen = null;       // the countdown window (the desktop app sets it; none in plain Node)
    this.busy = false;        // a part is being started
    this.error = null;        // what went wrong starting the current part
    this.note = null;         // something to know that isn't an error (e.g. next file not found)
    this.cfg.shows = (Array.isArray(this.cfg.shows) ? this.cfg.shows : []).map(cleanShow);
    if (this.cfg.run && !this.show(this.cfg.run.showId)) this.cfg.run = null;
    this.fileOk = new Map();  // file -> exists (checked every few seconds, see checkFiles)
  }

  show(id) { return this.cfg.shows.find((s) => s.id === id) || null; }
  get run() { return this.cfg.run || null; }
  get current() { const r = this.run; return r ? this.show(r.showId)?.parts[r.index] || null : null; }

  /** The desktop app's countdown window: { show(), hide(), focusConsole(), mode() }. */
  setScreen(screen) {
    this.screen = screen;
    if (this.current?.kind === 'countdown' && this.run.countdown && this.run.countdown.target > this.now()) this.screen?.show();
  }

  /** Saves the list of runs from the editor. A run in progress keeps going if its run still exists. */
  setShows(list) {
    if (!Array.isArray(list)) throw new Error('Invalid run of show list');
    this.cfg.shows = list.slice(0, 50).map(cleanShow);
    const r = this.run;
    if (r) {
      const s = this.show(r.showId);
      if (!s) this.stop(false);
      else if (r.index >= s.parts.length) r.index = Math.max(0, s.parts.length - 1);
    }
    this.save();
    this.checkFiles();
  }

  /** Planned length of each part (ms); a countdown to a clock time counts until that time. */
  planned(show) {
    const r = this.run;
    return show.parts.map((p, i) => (r?.planned?.[i] != null ? r.planned[i] : p.minutes * 60000));
  }

  async start(showId, index = 0) {
    const s = this.show(showId);
    if (!s) throw new Error('That run of show no longer exists');
    if (!s.parts.length) throw new Error('This run of show has no parts yet. Add them with Edit.');
    const now = this.now();
    // Started part-way (the first parts happened without the run): on time from here, so the
    // event starts as if the parts before had taken exactly their planned time.
    const before = s.parts.slice(0, index).reduce((n, p) => n + p.minutes * 60000, 0);
    this.cfg.run = { showId, index: -1, startedAt: now - before, segAt: now, planned: {}, log: [] };
    return this.go(index);
  }

  next() { const r = this.run; if (!r) throw new Error('No run of show is running'); return this.go(r.index + 1); }
  prev() { const r = this.run; if (!r) throw new Error('No run of show is running'); return this.go(r.index - 1); }

  stop(saveNow = true) {
    if (this.run?.countdown) this.screen?.hide();
    this.cfg.run = null;
    this.error = null;
    this.note = null;
    if (saveNow) this.save();
    this.onChange();
  }

  /** Goes to part `index` and does what it needs. One at a time: a second press while busy is ignored. */
  async go(index) {
    const r = this.run;
    if (!r) throw new Error('No run of show is running');
    const s = this.show(r.showId);
    if (index < 0 || index >= s.parts.length) throw new Error(index < 0 ? 'This is the first part' : 'That was the last part. Stop the run when the event is over.');
    if (this.busy) return { busy: true };
    this.busy = true;
    this.error = null;
    this.note = null;
    const part = s.parts[index];
    const now = this.now();
    const leaving = s.parts[r.index];
    if (r.index >= 0) r.log.push({ index: r.index, name: leaving?.name || '', from: r.segAt, to: now });
    r.log = r.log.slice(-100);
    r.index = index;
    r.segAt = now;
    r.countdown = null;
    delete r.planned[index];
    this.segment(part.name);
    this.save();
    this.onChange();
    const errors = [];
    try {
      await this.enter(part, r, errors);
    } catch (e) {
      errors.push(e.message);
    } finally {
      this.busy = false;
    }
    // Leaving a countdown: its window goes once the next part is up (no desktop in between).
    if (part.kind !== 'countdown' && leaving?.kind === 'countdown') this.screen?.hide();
    if (errors.length) this.error = errors.join('\n');
    this.save();
    this.onChange();
    this.prepareNext(s, index);
    if (this.error) throw new Error(this.error);
    return { index };
  }

  async enter(part, r, errors) {
    const m = this.music();
    const fade = (fn) => fn().catch((e) => errors.push(`Music: ${e.message}`));
    if (part.kind === 'slides') {
      if (!part.file) throw new Error(`“${part.name}” has no file. Choose one with Edit.`);
      if (part.musicOut?.on && m) fade(() => m.fadeOut(part.musicOut.seconds));
      const full = await this.ppt.cmd('ppt.open', { path: part.file, background: true });
      if (this.ppt.endBeforeStart) await this.ppt.cmd('ppt.endOthers', { path: full }).catch(() => {});
      await this.ppt.cmd('ppt.start', { path: full, slide: part.slide || 1 });
      if (!this.ppt.endBeforeStart) await this.ppt.cmd('ppt.endOthers', { path: full }).catch(() => {});
      this.ppt.focus = full;
      // Ending the previous file's show brings PowerPoint's own window up on this screen.
      this.screen?.focusConsole();
    } else if (part.kind === 'countdown') {
      const now = this.now();
      let target = part.until ? todayAt(part.until, now) : now + Math.max(part.minutes, 0.25) * 60000;
      if (part.until && target < now) target = now; // that time has passed: it shows 0:00
      if (part.until) r.planned[r.index] = Math.max(0, target - now);
      r.countdown = { target, faded: false, advanced: false };
      if (part.musicIn?.on && m) fade(() => m.fadeIn(part.musicIn.seconds, part.musicIn.volume));
      this.screen?.show();
    } else if (part.kind === 'music') {
      const sh = this.ppt.state.show;
      if (part.black && sh && sh.slide && sh.state !== 'black') {
        await this.ppt.cmd('ppt.setState', { state: 'black' }).catch((e) => errors.push(e.message));
      }
      if (part.musicIn?.on && m) fade(() => m.fadeIn(part.musicIn.seconds, part.musicIn.volume));
    }
    if (part.cue) {
      const cue = this.cueList().find((c) => c.id === part.cue);
      if (!cue) errors.push(`The cue for “${part.name}” no longer exists`);
      else errors.push(...(await this.cues.run(cue)));
    }
  }

  /** Opens the next slides part's file now (no window), so starting it later is quick. */
  prepareNext(s, index) {
    const nextSlides = s.parts.slice(index + 1).find((p) => p.kind === 'slides' && p.file);
    if (!nextSlides) return;
    const open = (this.ppt.state.presentations || []).some((x) => x.path.toLowerCase() === nextSlides.file.toLowerCase());
    if (open) return;
    if (!/^https?:/i.test(nextSlides.file) && !fs.existsSync(nextSlides.file)) {
      this.note = `The file for “${nextSlides.name}” is not there: ${nextSlides.file}`;
      this.onChange();
      return;
    }
    this.ppt.cmd('ppt.open', { path: nextSlides.file, background: true })
      .then(() => this.ppt.poll?.())
      .catch((e) => { this.note = `Could not open the file for “${nextSlides.name}” ahead of time: ${e.message}`; this.onChange(); });
  }

  /** Every half second: the countdown's music fade and going on at zero. */
  tick() {
    const r = this.run;
    const cd = r?.countdown;
    const part = this.current;
    if (!cd || part?.kind !== 'countdown') return;
    const left = cd.target - this.now();
    const m = this.music();
    if (!cd.faded && part.fadeOut > 0 && left <= part.fadeOut * 1000 && left > -2000) {
      cd.faded = true;
      // Whatever is playing (brought in by this part or by hand) ends at zero; nothing if silent.
      if (m) m.fadeOut(Math.max(1, Math.min(part.fadeOut, left / 1000))).catch(() => {});
    }
    if (!cd.advanced && part.autoNext && left <= 0 && !this.busy) {
      cd.advanced = true;
      const s = this.show(r.showId);
      if (r.index + 1 < s.parts.length) this.next().catch(() => {});
    }
  }

  /** Whether each file in the runs is there (the editor and the check show missing ones). */
  checkFiles() {
    const seen = new Set();
    for (const s of this.cfg.shows) {
      for (const p of s.parts) {
        if (p.kind !== 'slides' || !p.file || seen.has(p.file)) continue;
        seen.add(p.file);
        this.fileOk.set(p.file, /^https?:/i.test(p.file) || fs.existsSync(p.file));
      }
    }
    for (const f of [...this.fileOk.keys()]) if (!seen.has(f)) this.fileOk.delete(f);
  }

  /** For the console: the runs, and the one in progress. */
  summary() {
    const r = this.run;
    const s = r ? this.show(r.showId) : null;
    const plan = s ? this.planned(s) : [];
    const before = plan.slice(0, r?.index > 0 ? r.index : 0).reduce((a, b) => a + b, 0);
    const open = new Set((this.ppt.state.presentations || []).map((x) => x.path.toLowerCase()));
    return {
      shows: this.cfg.shows,
      files: Object.fromEntries(this.fileOk),
      open: s ? s.parts.filter((p) => p.kind === 'slides' && p.file && open.has(p.file.toLowerCase())).map((p) => p.id) : [],
      active: r && s ? {
        showId: r.showId,
        index: r.index,
        startedAt: r.startedAt,
        segAt: r.segAt,
        planned: plan,
        plannedBefore: before, // planned time of the parts before this one (ms)
        countdown: r.countdown ? { target: r.countdown.target } : null,
        busy: this.busy,
        error: this.error,
        note: this.note,
        screen: this.screen ? this.screen.mode() : 'none',
      } : null,
    };
  }

  /** What the countdown window shows (it asks every second). */
  countdownInfo() {
    const r = this.run;
    const part = this.current;
    if (!r?.countdown || part?.kind !== 'countdown') return null;
    return { target: r.countdown.target, title: part.title || '', notices: part.notices || [], now: this.now() };
  }
}

module.exports = { RunOfShow, cleanShow, cleanPart, KINDS };
