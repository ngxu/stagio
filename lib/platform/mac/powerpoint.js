// PowerPoint for Mac, controlled with AppleScript. Not yet run with PowerPoint on a real Mac.
//
// Same interface as lib/powerpoint.js (Windows). How the slide images work here:
//   - PowerPoint for Mac can only export the whole deck (as PNGs). That blocks PowerPoint for a
//     while, so it runs by itself only when no show is running (and from "Reload all").
//   - During a show, slides are also saved from the slide-show window itself (Mac helper,
//     captureTarget/captured): exact when the picture matches PowerPoint's own image, otherwise a
//     DRAFT (the Mac doesn't say whether all of a slide's animations have played).
//   - Edits: a light fingerprint per slide (shapes, positions, text) is read for the slides near
//     the projector and, outside the show, for all slides in turn. A changed slide is marked
//     Edited, its old image dropped, and the deck exported again after the show.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Queue, str, records, num } = require('./osa');

const IDLE_MS = 8000;
const CHANGED_FOR_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
// PowerPoint for Mac is sandboxed: it may only write inside its own container.
const EXPORT_ROOT = path.join(os.homedir(), 'Library', 'Containers', 'com.microsoft.Powerpoint', 'Data', 'Library', 'Caches', 'Stagio');
const CACHE_DIR = process.env.STAGIO_THUMBS || path.join(os.homedir(), 'Library', 'Caches', 'Stagio', 'thumbs');

const STATES = { running: 'running', paused: 'paused', black: 'black', white: 'white', done: 'done' };
function stateName(s) {
  const t = String(s).toLowerCase();
  for (const k of Object.keys(STATES)) if (t.includes(k)) return STATES[k];
  return 'running';
}

/** AppleScript that sets `p` to the open presentation with this full name. */
const findPres = (fullName) => `
  set p to missing value
  repeat with x in presentations
    if (full name of x) is ${str(fullName)} then set p to contents of x
  end repeat
  if p is missing value then error "Presentation is not open: " & ${str(fullName)}`;

const VIEW = 'slide show view of slide show window 1';

class PowerPointMac {
  // PowerPoint for Mac runs one slide show at a time: the run of show ends the old show before
  // starting the next file's (Windows starts the new one first, so the projector never shows
  // the desktop in between).
  endBeforeStart = true;

  constructor() {
    this.q = new Queue();
    this.state = { running: false };
    this.onChange = () => {};
    this.onSlideChange = () => {};
    this.lastActivity = 0;
    this.info = new Map(); // id -> { title, hidden } (debug + titles)
    this.resetDeck(null);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  resetDeck(p) {
    this.deck = p;
    this.ids = [];
    this.info = new Map();
    this.exportVer = 0;      // bumps on every full export
    this.ready = new Set();  // "id-v" names with a PNG in the cache
    this.changedAt = new Map();
    this.needExport = !!p;
    this.ratio = 16 / 9;
    this.sigs = new Map();         // id -> fingerprint of the slide's content
    this.exportSigs = new Map();   // id -> fingerprint when the deck was last exported
    this.caps = new Map();         // id -> { v, sig, draft }: image saved from the slide-show window
    this.captureTried = new Map();
    this.fpBroken = null;          // why fingerprints can't be read here (then edits aren't detected)
    this.fpCursor = 0;
  }

  noteActivity() { this.lastActivity = Date.now(); }

  focusPath() {
    if (this.state.show?.path) return this.state.show.path;
    const open = this.state.presentations || [];
    if (this.focus && open.some((p) => p.path === this.focus)) return this.focus;
    return this.state.active || null;
  }

  // ---------------- show state ----------------

  async poll() {
    const before = this.state.show;
    try {
      const out = await this.q.run('ppt.state', `
        tell application "System Events" to set isRunning to (exists process "Microsoft PowerPoint")
        if not isRunning then return "off"
        tell application "Microsoft PowerPoint"
          set out to "on" & RS
          repeat with i from 1 to (count of presentations)
            set x to presentation i
            set out to out & "P" & US & (full name of x) & US & (name of x) & US & (count of slides of x) & RS
          end repeat
          try
            set out to out & "A" & US & (full name of active presentation) & RS
          end try
          if (count of slide show windows) > 0 then
            set w to slide show window 1
            set v to slide show view of w
            set pr to presentation of w
            set idx to 0
            set sid to 0
            set nts to ""
            try
              set sl to slide of v
              set idx to slide index of sl
              set sid to slide ID of sl
            end try
            if idx > 0 then
              try
                set nts to content of text range of text frame of place holder 2 of notes page of slide idx of pr
              end try
            end if
            set out to out & "S" & US & (full name of pr) & US & (name of pr) & US & idx & US & sid & US & (count of slides of pr) & US & ((slide state of v) as string) & US & nts & RS
          end if
          return out
        end tell`);
      if (out === 'off') {
        this.state = { running: false };
      } else {
        const st = { running: true, presentations: [], active: null, show: null };
        for (const r of records(out)) {
          if (r[0] === 'P') st.presentations.push({ path: r[1], name: r[2], slides: num(r[3]), cloud: /^https?:/.test(r[1]), autoSave: null });
          if (r[0] === 'A') st.active = r[1];
          if (r[0] === 'S') {
            st.show = { path: r[1], name: r[2], slide: num(r[3]), slideId: num(r[4]), total: num(r[5]), state: stateName(r[6]), notes: r[7] || '' };
            if (!st.show.slide) st.show.state = 'done';
          }
        }
        this.state = st;
      }
    } catch (e) {
      this.state = { running: false, error: e.message };
    }
    const after = this.state.show;
    if (after && (!before || before.slide !== after.slide || before.state !== after.state)) this.noteActivity();
    const steady = after ? `${after.path}|${after.slideId}|${after.state}` : '';
    if (steady !== this.steadyKey) { this.steadyKey = steady; this.steadySince = Date.now(); }
    const first = !this.polledOnce;
    this.polledOnce = true;
    if ((before?.slideId || 0) !== (after?.slideId || 0) || before?.path !== after?.path) {
      try { this.onSlideChange(before || null, after || null, first); } catch (e) { console.error(e); }
    }
    return this.state;
  }

  // ---------------- commands (same names as the Windows helper) ----------------

  async cmd(name, a = {}) {
    this.noteActivity();
    const clearBW = `
      set st to (slide state of ${VIEW}) as string
      if st contains "black" or st contains "white" then set slide state of ${VIEW} to slide show state running`;
    const slideById = (id) => `
      set pr to presentation of slide show window 1
      set n to 0
      repeat with i from 1 to (count of slides of pr)
        if (slide ID of slide i of pr) is ${Number(id)} then set n to i
      end repeat
      if n is 0 then error "That slide no longer exists"`;
    const needShow = `if (count of slide show windows) is 0 then error "The slide show is not running"`;
    const tell = (body) => this.q.run(name, `tell application "Microsoft PowerPoint"\n${body}\nend tell`);
    switch (name) {
      case 'ppt.next':
        // At the end screen, another "next" would leave the show and show the desktop: stay.
        return tell(`${needShow}
          if ((slide state of ${VIEW}) as string) contains "done" then return "end"
          ${clearBW}
          go to next slide ${VIEW}
          return "ok"`);
      case 'ppt.prev':
        return tell(`${needShow}\n${clearBW}\ngo to previous slide ${VIEW}\nreturn "ok"`);
      case 'ppt.goto': {
        const target = a.id ? `${slideById(a.id)}` : `set n to ${Number(a.slide) || 1}`;
        return num(await tell(`${needShow}\n${clearBW}\n${target}\ngo to slide ${VIEW} number n\nreturn n`));
      }
      case 'ppt.start': {
        const pick = a.path ? findPres(a.path) : 'set p to active presentation';
        return tell(`${pick}
          set n to ${Number(a.slide) || 1}
          ${a.id ? `repeat with i from 1 to (count of slides of p)
            if (slide ID of slide i of p) is ${Number(a.id)} then set n to i
          end repeat` : ''}
          if (count of slide show windows) is 0 then run slide show (slide show settings of p)
          delay 0.3
          if n > 1 then go to slide ${VIEW} number n
          return "ok"`);
      }
      case 'ppt.end':
        return tell(`${needShow}\nexit slide show ${VIEW}\nreturn "ok"`);
      case 'ppt.setState': {
        const want = { black: 'black screen', white: 'white screen', running: 'running' }[a.state] || 'running';
        const out = await tell(`${needShow}
          set cur to (slide state of ${VIEW}) as string
          if "${a.state}" is not "running" and cur contains "${a.state}" then
            set slide state of ${VIEW} to slide show state running
            return "running"
          end if
          set slide state of ${VIEW} to slide show state ${want}
          return "${a.state}"`);
        return out;
      }
      case 'ppt.open':
        // Already open: just its name (the run of show opens the next file ahead of time).
        return tell(`repeat with x in presentations
            if (full name of x) is ${str(a.path)} then return full name of x
          end repeat
          open (POSIX file ${str(a.path)})\ndelay 1\nreturn full name of active presentation`);
      case 'ppt.moveSlide':
        // BETA: PowerPoint for Mac's "move" (untested on a Mac).
        return tell(`set pr to missing value
          repeat with x in presentations
            if (full name of x) is ${str(a.path)} then set pr to x
          end repeat
          if pr is missing value then error "Presentation is not open"
          set n to 0
          repeat with i from 1 to (count of slides of pr)
            if (slide ID of slide i of pr) is ${Number(a.id)} then set n to i
          end repeat
          if n is 0 then error "That slide no longer exists"
          set t to ${Math.max(1, Number(a.to) || 1)}
          if t > (count of slides of pr) then set t to (count of slides of pr)
          if t > n then
            move slide n of pr to after slide t of pr
          else if t < n then
            move slide n of pr to before slide t of pr
          end if
          return t`);
      case 'ppt.save':
        return tell(`repeat with x in presentations
            if (full name of x) is ${str(a.path)} then
              save x
              return "ok"
            end if
          end repeat
          error "Presentation is not open"`);
      case 'ppt.endOthers':
        // Run of show: the shows of other files end, the one of this file keeps running.
        return tell(`repeat with i from (count of slide show windows) to 1 by -1
            set w to slide show window i
            if (full name of presentation of w) is not ${str(a.path)} then exit slide show (slide show view of w)
          end repeat
          return "ok"`);
      default:
        throw new Error(`Not available on Mac yet: ${name}`);
    }
  }

  // ---------------- background: slide list + thumbnails ----------------

  inShow(p) { return !!this.state.show && this.state.show.path === p; }

  /** The list is read whole on every scan here; nothing to force. */
  relist() {}

  startWatcher() {
    const loop = async () => {
      for (;;) {
        const p = this.focusPath();
        if (!p) { if (this.deck) { this.resetDeck(null); this.onChange(); } await sleep(1000); continue; }
        if (p !== this.deck) { this.resetDeck(p); this.onChange(); }
        const show = this.inShow(p);
        const stale = show && this.ids.length && (this.state.show.total !== this.ids.length
          || (this.state.show.slide && this.ids[this.state.show.slide - 1] !== this.state.show.slideId));
        try {
          if (!this.ids.length || stale) {
            await this.listSlides(p);                      // cheap enough to do even mid-show
          } else if (this.needExport && !show) {
            if (!this.fpBroken && this.ids.some((id) => !this.sigs.has(id))) await this.fingerprints(p, this.ids.map((_, i) => i + 1));
            await this.exportAll(p);                       // never automatically during a show
          } else if (show && Date.now() - this.lastActivity < IDLE_MS) {
            await sleep(500);
            continue;
          } else {
            await this.listSlides(p);                      // periodic check for added/removed slides
            await this.checkEdits(p, show);                // and for edited slides
            await sleep(show ? 3000 : 2000);
          }
          this.lastError = null;
        } catch (e) {
          this.lastError = e.message;
          await sleep(2000);
        }
        await sleep(300);
      }
    };
    loop();
  }

  /** Reads slide IDs, titles and hidden flags in one script. */
  async listSlides(p) {
    const t0 = Date.now();
    const out = await this.q.run('ppt.slides', `tell application "Microsoft PowerPoint"
      ${findPres(p)}
      set out to ""
      try
        set out to "R" & US & (slide width of page setup of p) & US & (slide height of page setup of p) & RS
      end try
      repeat with i from 1 to (count of slides of p)
        set s to slide i of p
        set t to ""
        repeat with sh in shapes of s
          try
            set tt to content of text range of text frame of sh
            if tt is not "" then
              set t to tt
              exit repeat
            end if
          end try
        end repeat
        set h to false
        try
          set h to hidden of slide show transition of s
        end try
        set out to out & (slide ID of s) & US & t & US & h & RS
      end repeat
      return out
    end tell`, 120000);
    this.lastScanMs = Date.now() - t0;
    if (p !== this.deck) return;
    const ids = [];
    const now = Date.now();
    const listedBefore = this.ids.length > 0;
    let changed = false;
    for (const r of records(out)) {
      if (r[0] === 'R') { const w = num(r[1]), h = num(r[2]); if (w > 0 && h > 0) this.ratio = w / h; continue; }
      const id = num(r[0]);
      const title = String(r[1] || '').replace(/[\r\n\v]+/g, ' ').trim().slice(0, 80);
      const hidden = /true/i.test(r[2] || '');
      ids.push(id);
      const old = this.info.get(id);
      if (!old && listedBefore) { this.changedAt.set(id, now); this.needExport = true; }
      if (!old || old.title !== title || old.hidden !== hidden) changed = true;
      this.info.set(id, { title, hidden });
    }
    if (ids.join(',') !== this.ids.join(',')) changed = true;
    for (const id of this.info.keys()) if (!ids.includes(id)) this.info.delete(id);
    this.ids = ids;
    if (changed) this.onChange();
  }

  /**
   * Reads a fingerprint (shapes, their positions and text) of the slides at these numbers. If
   * this PowerPoint can't answer it, edits just aren't detected (fpBroken says why).
   */
  async fingerprints(p, indexes) {
    if (this.fpBroken || !indexes.length) return;
    let out;
    try {
      out = await this.q.run('ppt.fingerprints', `tell application "Microsoft PowerPoint"
        ${findPres(p)}
        set out to ""
        repeat with i in {${indexes.join(', ')}}
          if i is less than or equal to (count of slides of p) then
            set s to slide i of p
            set fp to ""
            repeat with sh in shapes of s
              try
                set fp to fp & (name of sh) & "," & (left position of sh) & "," & (top of sh) & "," & (width of sh) & "," & (height of sh)
              end try
              try
                set fp to fp & ":" & (content of text range of text frame of sh)
              end try
              set fp to fp & ";"
            end repeat
            set out to out & (slide ID of s) & US & fp & RS
          end if
        end repeat
        return out
      end tell`, 60000);
    } catch (e) {
      this.fpBroken = e.message;
      return;
    }
    if (p !== this.deck) return;
    const now = Date.now();
    let changed = false;
    for (const r of records(out)) {
      const id = num(r[0]);
      const sig = sha1(String(r[1] || '')).slice(0, 12);
      const old = this.sigs.get(id);
      if (old && old !== sig) {
        this.changedAt.set(id, now);
        this.needExport = true;
        changed = true;
      }
      if (old !== sig) changed = true;
      this.sigs.set(id, sig);
    }
    if (changed) this.onChange();
  }

  /** Edits: the slides near the projector each time; outside a show, a few more in turn. */
  async checkEdits(p, show) {
    const n = this.ids.length;
    if (!n || this.fpBroken) return;
    const cur = show && this.state.show.slide ? this.state.show.slide : 1;
    const want = new Set();
    for (let i = cur; i <= Math.min(n, cur + 3); i++) want.add(i);
    if (!show) for (let k = 0; k < 4; k++) { this.fpCursor = (this.fpCursor % n) + 1; want.add(this.fpCursor); }
    await this.fingerprints(p, [...want]);
  }

  deckDir(p) { return path.join(CACHE_DIR, sha1(p).slice(0, 16)); }

  // ---------------- slide images from the slide-show window (see lib/programfeed.js) ----------------

  /**
   * The projected slide, if it should now be saved from the slide-show window: on screen and
   * unchanged for a while (2.5 s: the Mac doesn't report animation steps), not black/white, and
   * without an exact image for its current content yet.
   */
  captureTarget() {
    const s = this.state.show;
    if (!s || !s.slide || !s.slideId || s.path !== this.deck) return null;
    if (s.state !== 'running' && s.state !== 'paused') return null;
    if (Date.now() - (this.steadySince || 0) < 2500) return null;
    const id = s.slideId;
    const sig = this.sigs.get(id) || '';
    const have = this.caps.get(id);
    if (have && have.sig === sig && !have.draft) return null;
    if (Date.now() - (this.captureTried.get(id) || 0) < 8000) return null;
    this.captureTried.set(id, Date.now());
    // PowerPoint's own image of this content, if there is one: then the picture must match it.
    const exported = this.exportValid(id) ? this.thumb(this.deck, id, `e${this.exportVer}`) : null;
    if (have && have.sig === sig && have.draft && !exported) return null; // a draft is all we can get
    const name = `${id}-c${Date.now().toString(36)}`;
    return { name, out: path.join(this.deckDir(this.deck), name), ratio: this.ratio, deck: this.deck, id, sig, ref: exported, draft: !exported };
  }

  /** A slide-show picture was saved: kept only if the slide still has the same content. */
  captured(target) {
    if (target.deck !== this.deck || (this.sigs.get(target.id) || '') !== target.sig) return;
    const old = this.caps.get(target.id);
    if (old) for (const ext of ['.jpg', '.s.jpg']) fs.rmSync(path.join(this.deckDir(this.deck), `${target.id}-${old.v}${ext}`), { force: true });
    this.caps.set(target.id, { v: target.name.slice(String(target.id).length + 1), sig: target.sig, draft: target.draft });
    this.onChange();
  }

  /** True when the exported image of this slide still shows its current content. */
  exportValid(id) {
    if (!this.ready.has(`${id}-e${this.exportVer}`)) return false;
    if (!this.sigs.has(id) || !this.exportSigs.has(id)) return true; // no fingerprints: trust it
    return this.sigs.get(id) === this.exportSigs.get(id);
  }

  /** Exports every slide as PNG into PowerPoint's container, then copies them into the cache. */
  async exportAll(p) {
    this.needExport = false;
    const t0 = Date.now();
    const ver = this.exportVer + 1;
    const dir = path.join(EXPORT_ROOT, `export-${ver}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const ids = [...this.ids];
    const sigsAtExport = new Map(this.sigs); // what each image shows
    await this.q.run('ppt.export', `tell application "Microsoft PowerPoint"
      ${findPres(p)}
      save p in (POSIX file ${str(path.join(dir, 'slides'))}) as save as PNG
    end tell`, 15 * 60000);
    this.lastRenderMs = Date.now() - t0;
    if (p !== this.deck) return;
    // PowerPoint writes "Slide1.png", "Slide2.png"... (the word is localised), possibly in a subfolder.
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const full = path.join(d, f.name); if (f.isDirectory()) walk(full); else if (/\.png$/i.test(f.name)) files.push(full); } };
    walk(dir);
    const out = this.deckDir(p);
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(out)) if (/-e\d+\.png$/.test(f)) fs.rmSync(path.join(out, f), { force: true }); // older exports only
    this.ready.clear();
    for (const f of files) {
      const m = path.basename(f).match(/(\d+)\.png$/i);
      const id = m && ids[Number(m[1]) - 1];
      if (!id) continue;
      fs.copyFileSync(f, path.join(out, `${id}-e${ver}.png`));
      this.ready.add(`${id}-e${ver}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    // Pictures from the slide show are kept (deleting the folder above took them): the export
    // is only taken as the exact image where its content is still current.
    for (const [id, c] of this.caps) {
      const src = this.capFile(p, id, c.v);
      if (!src) this.caps.delete(id);
    }
    this.exportVer = ver;
    this.exportSigs = sigsAtExport;
    if (!files.length) this.lastError = 'PowerPoint exported no slide images';
    this.onChange();
  }

  capFile(p, id, v) { const f = path.join(this.deckDir(p), `${id}-${v}.jpg`); return fs.existsSync(f) ? f : null; }

  slidesForUi() {
    const p = this.focusPath();
    if (!p || p !== this.deck || !this.ids.length) return null;
    const now = Date.now();
    let pending = 0;
    let drafts = 0;
    const slides = this.ids.map((id, i) => {
      const e = this.info.get(id) || { title: '', hidden: false };
      // Best image for the slide's current content: an exact slide-show picture, the export, or
      // (until one of those exists) a draft slide-show picture.
      const sig = this.sigs.get(id) || '';
      const cap = this.caps.get(id);
      const capNow = cap && cap.sig === sig ? cap : null;
      let v = null; let draft = false;
      if (capNow && !capNow.draft) v = capNow.v;
      else if (this.exportValid(id)) v = `e${this.exportVer}`;
      else if (capNow) { v = capNow.v; draft = true; }
      if (!v) pending++;
      if (draft) drafts++;
      return { index: i + 1, id, title: e.title, hidden: e.hidden, v: v || `e${this.exportVer}`, thumb: !!v, draft, changed: now - (this.changedAt.get(id) || 0) < CHANGED_FOR_MS };
    });
    const waitShow = !!this.state.show && pending > 0; // the export runs after the show (or Reload all)
    return { path: p, ratio: this.ratio, slides, pending, drafts, waitShow };
  }

  /** "Reload all": export every slide again (blocks PowerPoint while it runs, even mid-show). */
  refreshThumbs() {
    if (!this.deck) return;
    const p = this.deck;
    this.exportAll(p).catch((e) => { this.lastError = e.message; });
    this.onChange();
  }

  /** Image file of a slide version: exports are PNG, slide-show pictures JPEG (with a small one). */
  thumb(presPath, id, v, small = false) {
    const base = path.join(this.deckDir(presPath), `${Number(id)}-${String(v).replace(/[^a-z0-9]/gi, '')}`);
    for (const ext of small ? ['.s.jpg', '.jpg', '.png'] : ['.jpg', '.png']) if (fs.existsSync(base + ext)) return base + ext;
    return null;
  }
}

module.exports = { PowerPointMac };
