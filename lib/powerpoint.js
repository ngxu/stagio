// PowerPoint control through the PowerShell COM helper.
//
// Background work (slide list, change detection, thumbnails) shares PowerPoint with the running
// show, and PowerPoint handles one request at a time. On real decks it is expensive (measured on
// an 82-slide, 37 MB deck: 1–3 s to render one slide image, ~100–400 ms to read one slide's
// shapes), and while PowerPoint is busy with it, a slide change has to wait. So:
//   - During a show, background work only runs after the operator has been idle for a while,
//     in short steps with long rests. Before the show (edit mode) it runs at full speed.
//   - The slide list and titles come first, so every slide is listed within seconds.
//   - Thumbnails render one at a time, the projected slide and the next ones first, and are
//     kept on disk keyed by slide content, so they survive restarts and only changed slides
//     are re-rendered.
//   - The slides around the projector are re-checked for live edits (plus a slow rotation).
//   - Presentations that carry their own fonts (Canva exports) are rendered through a PDF export,
//     because PowerPoint's normal slide image ignores embedded fonts (see PPT-ThumbsPdf in
//     helper.ps1). That costs a few seconds per call, so neighbouring slides share one export,
//     and none run during a show. An image known to be wrong is never shown in its place.
//   - During a show, every slide that has been on the projector for a moment (all animations
//     played) is saved from the projector itself: exactly what the audience saw, at no cost to
//     PowerPoint. That image wins over a rendered one, and also corrects edits the content
//     fingerprint can't see.
//   - While someone is working in PowerPoint itself, background work pauses, so PowerPoint
//     doesn't freeze under their hands.
// The projector view itself comes from a screen capture (see programfeed.js), not from here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// PowerPoint writes the slide images itself, so this must be a folder it can reach. In testing
// it could not see a folder created under %LOCALAPPDATA%; the installed app therefore uses a
// folder in the user's home directory (STAGIO_THUMBS, set in electron/main.js).
const CACHE_DIR = process.env.STAGIO_THUMBS || path.join(__dirname, '..', 'data', 'thumbs');
const CHANGED_FOR_MS = 30000; // how long a live edit stays highlighted
const NEAR_AHEAD = 3;         // slides after the projector kept fresh first
const PDF_BATCH = 4;          // at most this many neighbouring slides per PDF export
const PDF_TARGET_MS = 8000;   // ...and about this long per export, judged by the last one
const FONT_CHECK_MS = 120000; // re-check which fonts the deck needs (not during a show)
const PDF_TARGET_FG_MS = 4000; // shorter exports while PowerPoint is the window in front
const CAPTURE_STEADY_MS = 1500; // a slide must be on the projector this long before it is saved
const USER_IDLE_MS = 4000;    // PowerPoint in front and input within this long: someone is working
// Suffix of slide images saved from the projector. Before 0.7.1 they were "c" and could be cut
// off when the projector's screen had another scaling than the PC's; those are dropped.
const CAP = 'c2';
// Suffix of a quick image of a deck with embedded fonts, made during a show so the next slides
// are never blank (its fonts may differ). It is replaced by the exact image (projector capture,
// or the PDF render) as soon as that exists.
const DRAFT = 'q';
const SHOW_PDF_MAX_MS = 1500; // during a show, exact (PDF) images only when one takes no longer
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const rm = (f) => { try { fs.rmSync(f, { force: true }); } catch { /* in use: left for the next sweep */ } };

// Pacing: [during a show, before the show]
const PACE = {
  scanEveryMs: [3000, 1500],
  scanBudgetMs: [400, 1500],
  baselinePerScan: [2, 12], // slides that get their first content signature per scan
  rest: [(ms) => Math.max(800, ms * 2), (ms) => Math.max(80, ms * 0.25)],
};

class PowerPoint {
  constructor(control, watcher) {
    this.control = control; // fast helper: show state + commands
    this.watcher = watcher; // background helper: slide list, change scans, thumbnails
    this.state = { running: false };
    this.onChange = () => {};
    this.onSlideChange = () => {};  // (before, after): the show's previous and current state
    this.startOptions = () => ({}); // extra arguments for "start show" (which display to use)
    this.startDone = () => {};      // called with those arguments once the show has started
    this.lastActivity = 0;
    this.activity = { app: '', idleMs: Infinity, at: 0 }; // foreground app + input idle (sys.activity)
    this.steadyKey = '';
    this.steadySince = 0;
    this.msPerSlide = { export: null, pdf: null };       // measured render time per slide
    this.resetDeck(null);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    this.pruneCache();
  }

  resetDeck(p) {
    this.deck = p;
    this.ids = [];             // slide IDs in show order
    this.ratio = 16 / 9;
    this.info = new Map();     // id -> { title, hidden, sig|null }
    this.ready = new Set();    // "id-sig" names whose images are on disk
    this.changedAt = new Map();
    this.cursor = 0;
    this.lastScanAt = 0;
    this.sweepDue = true;
    // { pdf, missing, embedded, at }: fonts the deck uses that this PC lacks. `pdf` = render
    // through PDF. Unknown (null) until checked; nothing is rendered before that.
    this.fonts = null;
    this.pdfFailures = 0;
    this.captureTried = new Map(); // image name -> when a projector capture was last attempted
    if (p) {
      const dir = this.deckDir(p);
      fs.mkdirSync(dir, { recursive: true });
      // "<id>-<ver>.jpg" is the large image; it is written after the small one, so it marks a
      // complete pair.
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(new RegExp(`^(\\d+-[0-9a-f]+(?:p|${CAP}|${DRAFT})?)\\.jpg$`));
        if (m) this.ready.add(m[1]);
      }
      try { const now = new Date(); fs.utimesSync(dir, now, now); } catch { /* only used for pruning */ }
    }
  }

  deckDir(p) { return path.join(CACHE_DIR, sha1(p).slice(0, 16)); }

  /**
   * The image to show for a slide's current content, or null if there is no right one yet.
   * Versions: "<sig>c" saved from the projector (exactly what the audience saw), "<sig>p" from
   * the PDF renderer (decks with embedded fonts), "<sig>" from the normal renderer (all other
   * decks). For a deck with embedded fonts the normal image has the wrong fonts and is never used.
   */
  best(id, e) {
    if (!e?.sig) return null;
    if (this.ready.has(`${id}-${e.sig}${CAP}`)) return `${e.sig}${CAP}`;
    if (!this.fonts) return null; // not known yet which rendering is the right one
    const v = this.exactV(e.sig);
    if (this.ready.has(`${id}-${v}`)) return v;
    // Until the exact image exists, the quick draft: a slide with a picture beats a blind box.
    if (this.fonts.pdf && this.ready.has(`${id}-${e.sig}${DRAFT}`)) return `${e.sig}${DRAFT}`;
    return null;
  }

  /** Version name of the exact image for content `sig` (PDF-rendered for decks with embedded fonts). */
  exactV(sig) { return this.fonts?.pdf ? `${sig}p` : sig; }

  hasExact(id, e) {
    return this.ready.has(`${id}-${e.sig}${CAP}`) || (!!this.fonts && this.ready.has(`${id}-${this.exactV(e.sig)}`));
  }

  /** True when a PDF image is quick enough on this deck to be made during a show. */
  pdfInShow() { return (this.msPerSlide.pdf ?? Infinity) <= SHOW_PDF_MAX_MS; }

  /** True if PowerPoint should render this slide now. */
  needsRender(id, e, show) {
    if (!e?.sig || !this.fonts || this.hasExact(id, e)) return false;
    // A deck with embedded fonts needs PDF exports for exact images. During a show they are made
    // only if quick on this deck (a slide change would wait behind one); otherwise the slide gets
    // one quick draft now, and the exact image after the show or from the projector.
    if (show && this.fonts.pdf && !this.pdfInShow()) return !this.ready.has(`${id}-${e.sig}${DRAFT}`);
    return true;
  }

  /**
   * During a show, how long the slides must stay put before PowerPoint is asked for an image:
   * short on a deck whose images are quick, so the next slides are ready before they are needed;
   * longer on a slow one, so a slide change never has to wait behind an image.
   */
  showIdleMs() {
    const kind = this.fonts?.pdf && this.pdfInShow() ? 'pdf' : 'export';
    const per = this.msPerSlide[kind] ?? 600;
    return per <= 400 ? 1200 : per <= 1500 ? 2500 : 6000;
  }

  /** True while someone works in PowerPoint itself (it is in front and they typed or clicked lately). */
  userInPowerPoint() {
    const a = this.activity;
    return Date.now() - a.at < 6000 && /^powerpnt$/i.test(a.app) && a.idleMs < USER_IDLE_MS;
  }

  /**
   * The projected slide, if it should now be saved from the projector: on screen and unchanged
   * for a moment, every animation played, not black/white. The capture itself checks that the
   * picture is still (no transition or video running) and that nothing covers it.
   */
  captureTarget() {
    const s = this.state.show;
    if (!s || !s.slide || !s.slideId || s.path !== this.deck || this.state.busy) return null;
    if (s.state !== 'running' && s.state !== 'paused') return null;
    if (s.clicks > 0 && s.click < s.clicks) return null;
    if (Date.now() - this.steadySince < CAPTURE_STEADY_MS) return null;
    const e = this.info.get(s.slideId);
    if (!e?.sig) return null;
    const name = `${s.slideId}-${e.sig}${CAP}`;
    if (this.ready.has(name) || Date.now() - (this.captureTried.get(name) || 0) < 8000) return null;
    this.captureTried.set(name, Date.now());
    // PowerPoint's own image of this content, if made already: the copy must look like it.
    const rendered = this.fonts ? `${s.slideId}-${this.fonts.pdf ? `${e.sig}p` : e.sig}` : null;
    const ref = rendered && this.ready.has(rendered) ? path.join(this.deckDir(this.deck), `${rendered}.jpg`) : null;
    return { name, out: path.join(this.deckDir(this.deck), name), ratio: this.ratio, deck: this.deck, id: s.slideId, sig: e.sig, ref };
  }

  /** A projector capture was saved. Kept only if the slide still has the same content. */
  captured(target) {
    if (target.deck !== this.deck || this.info.get(target.id)?.sig !== target.sig) return;
    this.ready.add(target.name);
    this.sweepDue = true;
    this.onChange();
  }

  /** Drops cached thumbnails of decks not opened for 30 days. */
  pruneCache() {
    const cutoff = Date.now() - 30 * 86400000;
    for (const d of fs.readdirSync(CACHE_DIR)) {
      const full = path.join(CACHE_DIR, d);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true }); } catch { /* in use */ }
    }
  }

  /** Called on every operator action, so background work stays out of the way. */
  noteActivity() { this.lastActivity = Date.now(); }

  /** Which presentation the console should focus on: the running show, else the chosen/active one. */
  focusPath() {
    if (this.state.show?.path) return this.state.show.path;
    const open = this.state.presentations || [];
    if (this.focus && open.some((p) => p.path === this.focus)) return this.focus;
    return this.state.active || null;
  }

  /**
   * Refreshes the show state. Calls that arrive while a refresh is still waiting to start
   * share it, so a burst of button presses doesn't queue one refresh per press.
   */
  poll() {
    if (this.queuedPoll) return this.queuedPoll;
    const run = (this.runningPoll || Promise.resolve()).then(() => {
      this.queuedPoll = null;
      return this.doPoll();
    });
    this.queuedPoll = run;
    this.runningPoll = run;
    return run;
  }

  async doPoll() {
    const before = this.state.show;
    try {
      this.state = await this.control.call('ppt.state');
    } catch (e) {
      // A failed read means "can't tell right now" (PowerPoint is busy with a dialog or a heavy
      // slide, or the helper is restarting), not "PowerPoint was closed" — the helper reports
      // that explicitly. Keep what is known and flag it, instead of blanking the console.
      this.state = this.state.running
        ? { ...this.state, busy: true, error: e.message }
        : { running: false, error: e.message };
    }
    // Slide changes made with a clicker straight into PowerPoint count as activity too.
    const after = this.state.show;
    const steady = after ? `${after.path}|${after.slideId}|${after.click}|${after.state}` : '';
    if (steady !== this.steadyKey) { this.steadyKey = steady; this.steadySince = Date.now(); }
    if (after && (!before || before.slide !== after.slide || before.state !== after.state)) this.noteActivity();
    // A different slide on the projector, or a show starting/ending (auto cues, recent files).
    // `first` marks the very first reading: a show found already running when Stagio starts
    // is not a slide the operator just went to.
    const first = !this.polledOnce;
    this.polledOnce = true;
    if ((before?.slideId || 0) !== (after?.slideId || 0) || before?.path !== after?.path) {
      try { this.onSlideChange(before || null, after || null, first); } catch (e) { console.error(e); }
    }
    return this.state;
  }

  async cmd(name, args = {}) {
    this.noteActivity();
    if (name !== 'ppt.start' && name !== 'ppt.open') return this.control.call(name, args);
    // Opening a file or starting a show may first have to launch PowerPoint (15–30 s cold).
    const extra = name === 'ppt.start' ? this.startOptions() : {};
    const result = await this.control.call(name, { ...extra, ...args }, { timeoutMs: 60000 });
    if (name === 'ppt.start') this.startDone(extra);
    return result;
  }

  inShow(p) { return !!this.state.show && this.state.show.path === p; }

  /** Read the whole slide list on the next scan (after Stagio moved a slide). */
  relist() { this.forceList = true; this.lastListAt = 0; }

  /** Slide on the projector for this deck (1 when not showing). */
  currentSlide(p) {
    return this.inShow(p) && this.state.show.slide ? this.state.show.slide : 1;
  }

  /** Slide indexes ordered by how soon the operator needs them. */
  priorityOrder(p) {
    const n = this.ids.length;
    const cur = this.currentSlide(p);
    const order = [];
    for (let i = cur; i <= Math.min(n, cur + NEAR_AHEAD); i++) order.push(i);
    if (cur > 1) order.push(cur - 1);
    for (let d = 1; d < n; d++) {
      if (cur + d <= n) order.push(cur + d);
      if (cur - d >= 1) order.push(cur - d);
    }
    return [...new Set(order)];
  }

  // ---------------- background loop ----------------

  startWatcher() {
    const loop = async () => {
      for (;;) {
        const p = this.focusPath();
        if (!p) { if (this.deck) { this.resetDeck(null); this.onChange(); } await sleep(500); continue; }
        if (p !== this.deck) { this.resetDeck(p); this.onChange(); }
        // A long job (the faster copy) has PowerPoint to itself for now.
        if (this.pauseBackground) { await sleep(500); continue; }
        const show = this.inShow(p);
        const m = show ? 0 : 1;
        // Slides added or removed live: re-read the slide list right away, even while the
        // operator is busy. Listing IDs is cheap, and a stale list would show the wrong slides.
        if (this.listIsStale(p)) {
          try { await this.scanStep(p, m, { idsOnly: true }); } catch (e) { this.lastError = e.message; }
          await sleep(200);
          continue;
        }
        // During a show, stay off PowerPoint while the operator is changing slides (the slide list
        // is still read once, so the console isn't empty). How long depends on how quick this
        // deck's images are (showIdleMs).
        if (show && this.ids.length && Date.now() - this.lastActivity < this.showIdleMs()) { await sleep(200); continue; }
        // Someone is working in PowerPoint itself: don't make it stall under their hands. The
        // slides are listed and the fonts checked first, so the console is never empty.
        if (!show && this.ids.length && this.fonts && this.userInPowerPoint()) { await sleep(500); continue; }
        const t0 = Date.now();
        let worked = false;
        try {
          // Scans and renders take turns: on slow machines a scan plus its rest can take longer
          // than the scan interval, and scans alone would then never leave room for a render.
          const scanDue = !this.ids.length || this.hasUnknown() || Date.now() - this.lastScanAt >= PACE.scanEveryMs[m];
          const scan = async () => { await this.scanStep(p, m); this.lastScanAt = Date.now(); return 'scan'; };
          let did = null;
          // Which renderer the deck needs is settled once the slides are listed, before any image.
          if (this.ids.length && this.fontCheckDue(show)) { await this.checkFonts(p); did = 'fonts'; }
          else if (scanDue && this.lastStep !== 'scan') did = await scan();
          else if (await this.renderStep(p)) did = 'render';
          else if (scanDue) did = await scan();
          if (did) this.lastStep = did;
          worked = !!did;
          this.lastError = null;
          if (!worked) this.sweep(p);
        } catch (e) { this.lastError = e.message; /* PowerPoint busy (e.g. a co-author's edit is merging); retry later */ }
        const spent = Date.now() - t0;
        await sleep(worked ? PACE.rest[m](spent) : 400);
      }
    };
    loop();
  }

  hasUnknown() { return this.ids.some((id) => !this.info.has(id)); }

  /** First time for every deck; again now and then before the show (a co-author may paste in text in another font). */
  fontCheckDue(show) {
    if (!this.fonts) return true;
    return !show && Date.now() - this.fonts.at > FONT_CHECK_MS;
  }

  async checkFonts(p) {
    const r = await this.watcher.call('ppt.fonts', { path: p });
    if (p !== this.deck) return;
    const was = this.fonts;
    // After repeated PDF failures the deck stays on the normal renderer (wrong fonts beat no images).
    const failed = this.pdfFailures >= 3 ? (was?.failed || 'PDF export failed') : undefined;
    const pdf = (r.embedded || []).length > 0 && !failed;
    this.fonts = { pdf, missing: r.missing || [], embedded: r.embedded || [], at: Date.now(), failed };
    if (!was || was.pdf !== pdf || String(was.embedded) !== String(this.fonts.embedded)) {
      this.sweepDue = true;
      this.onChange();
    }
  }

  /** True when the show's slide count or current slide doesn't match the list we hold. */
  listIsStale(p) {
    const s = this.state.show;
    if (!s || s.path !== p || !this.ids.length) return false;
    if (this.forceList || s.total !== this.ids.length) return true;
    return !!(s.slide && s.slideId && this.ids[s.slide - 1] !== s.slideId);
  }

  /** Reads the slide list; checks content of slides near the projector plus a few others. */
  async scanStep(p, m, { idsOnly = false } = {}) {
    const firstScan = !this.ids.length;
    // Slide numbers to check, most urgent first; the helper works down the list until its
    // time budget is used. Until every slide has a title, the budget goes to titles only.
    const want = new Set();
    if (!firstScan && !idsOnly && !this.hasUnknown()) {
      const order = this.priorityOrder(p);
      const hasSig = (i) => this.info.get(this.ids[i - 1])?.sig != null;
      const cur = this.currentSlide(p);
      const n = this.ids.length;
      for (const i of order.slice(0, NEAR_AHEAD + 3)) if (!hasSig(i)) want.add(i); // near, never checked
      // Re-check the preview and the projector first, then the next few slides in turn: on heavy
      // decks the budget may only cover one or two slides per scan.
      if (cur < n) want.add(cur + 1);
      want.add(cur);
      const ahead = [];
      for (let i = cur + 2; i <= Math.min(n, cur + NEAR_AHEAD); i++) ahead.push(i);
      this.nearTurn = (this.nearTurn || 0) + 1;
      for (let k = 0; k < ahead.length; k++) want.add(ahead[(k + this.nearTurn) % ahead.length]);
      let added = 0;
      for (const i of order) {                                                     // the rest, nearest first
        if (added >= PACE.baselinePerScan[m]) break;
        if (!hasSig(i) && !want.has(i)) { want.add(i); added++; }
      }
      if (!added) {                                                                // all checked: rotate
        this.cursor = (this.cursor % this.ids.length) + 1;
        want.add(this.cursor);
      }
    }

    // Listing every slide costs ~3 cross-process calls per slide, so during a show it is only done
    // when needed: first time, titles missing, slides added/removed (see listIsStale), or every 30 s
    // to catch slides being reordered. Otherwise only the wanted slides are read.
    const listAll = firstScan || idsOnly || this.hasUnknown() || !this.inShow(p)
      || Date.now() - (this.lastListAt || 0) > 30000;
    const t0 = Date.now();
    const r = await this.watcher.call('ppt.slides', {
      path: p, want: [...want], known: listAll ? [...this.info.keys()] : [], listAll,
      budget: idsOnly ? 150 : PACE.scanBudgetMs[m],
    });
    this.lastScanMs = Date.now() - t0;
    if (p !== this.deck) return;
    if (listAll) { this.lastListAt = Date.now(); this.forceList = false; }

    const now = Date.now();
    if (!listAll) {
      // A slide no longer at the number we expected means the list moved under us: re-list next.
      const moved = r.slides.some((s) => this.ids[s.index - 1] !== s.id);
      if (moved) { this.forceList = true; return; }
      r.ids = this.ids;
    }
    let changed = firstScan || r.ids.join(',') !== this.ids.join(',');
    const listedBefore = this.ids.length > 0;
    for (const s of r.slides) {
      const old = this.info.get(s.id);
      const entry = old || { title: '', hidden: false, sig: null };
      // A slide that appears after the deck was listed was inserted live.
      if (!old && listedBefore && !this.ids.includes(s.id)) this.changedAt.set(s.id, now);
      if (!old || entry.title !== s.title || entry.hidden !== s.hidden) changed = true;
      entry.title = s.title;
      entry.hidden = s.hidden;
      if (s.sig) {
        if (entry.sig && entry.sig !== s.sig) { this.changedAt.set(s.id, now); changed = true; }
        if (entry.sig !== s.sig) changed = true;
        entry.sig = s.sig;
      }
      this.info.set(s.id, entry);
    }
    // Whole list read: the hidden marks of every slide (hidden or shown again in PowerPoint).
    if (Array.isArray(r.hiddenIds)) {
      const hidden = new Set(r.hiddenIds);
      for (const [id, e] of this.info) {
        if (e.hidden !== hidden.has(id)) { e.hidden = hidden.has(id); changed = true; }
      }
    }
    const alive = new Set(r.ids);
    for (const id of this.info.keys()) if (!alive.has(id)) this.info.delete(id);
    this.ids = r.ids;
    this.ratio = r.ratio || this.ratio;
    if (changed) { this.sweepDue = true; this.onChange(); }
  }

  /** Renders the most urgent missing thumbnail(s). Returns false if there is nothing to do. */
  async renderStep(p) {
    if (!this.fonts) return false; // not known yet which way this deck has to be rendered
    // During a show only the slides around the projector are worth PowerPoint's time.
    const show = this.inShow(p);
    const order = this.priorityOrder(p);
    const missing = (i) => this.needsRender(this.ids[i - 1], this.info.get(this.ids[i - 1]), show);
    const first = (show ? order.slice(0, NEAR_AHEAD + 3) : order).find(missing);
    if (!first) return false;
    const dir = this.deckDir(p);
    const name = (i, suffix) => `${this.ids[i - 1]}-${this.info.get(this.ids[i - 1]).sig}${suffix}`;
    const t0 = Date.now();
    let done;
    // During a show a deck with embedded fonts gets a quick draft when its PDF images are slow.
    const draft = show && this.fonts.pdf && !this.pdfInShow();
    if (!this.fonts.pdf || draft) {
      // The helper writes <name>.s.jpg (strip) and <name>.jpg (monitors).
      const suffix = draft ? DRAFT : '';
      await this.watcher.call('ppt.thumb', { path: p, id: this.ids[first - 1], out: path.join(dir, name(first, suffix)) });
      done = [name(first, suffix)];
      this.notePace('export', Date.now() - t0, 1);
    } else {
      // Neighbouring slides share one export (it has a fixed cost of its own), as many as fit in
      // about PDF_TARGET_MS at the speed measured so far (less with PowerPoint in front, where
      // someone may start working any moment). During a show: one slide at a time.
      const target = /^powerpnt$/i.test(this.activity.app) ? PDF_TARGET_FG_MS : PDF_TARGET_MS;
      const max = show ? 1 : Math.max(1, Math.min(PDF_BATCH, Math.round(target / (this.msPerSlide.pdf || target / 2))));
      const batch = [first];
      while (batch.length < max && first + batch.length <= this.ids.length && missing(first + batch.length)) batch.push(first + batch.length);
      const names = new Map(batch.map((i) => [this.ids[i - 1], name(i, 'p')]));
      const items = batch.map((i) => ({ id: this.ids[i - 1], out: path.join(dir, name(i, 'p')) }));
      try {
        const r = await this.watcher.call('ppt.thumbsPdf', { path: p, items, pdf: path.join(dir, 'render.pdf') }, { timeoutMs: 60000 + 30000 * items.length });
        done = (r.done || []).map((id) => names.get(id)).filter(Boolean);
        this.notePace('pdf', Date.now() - t0, items.length);
        this.pdfFailures = 0;
      } catch (e) {
        if (++this.pdfFailures >= 3 && this.fonts) { this.fonts = { ...this.fonts, pdf: false, failed: e.message }; this.onChange(); }
        throw e;
      }
    }
    this.lastRenderMs = Date.now() - t0;
    if (p !== this.deck) return true;
    for (const n of done) this.ready.add(n);
    this.sweepDue = true;
    this.onChange();
    return true;
  }

  /** Running average of how long one slide image takes (for the time estimate and PDF batches). */
  notePace(kind, ms, slides) {
    const per = ms / Math.max(1, slides);
    const old = this.msPerSlide[kind];
    this.msPerSlide[kind] = old == null ? per : old * 0.7 + per * 0.3;
  }

  /**
   * Deletes images that no longer belong to any slide (older versions of edited slides, deleted
   * slides, images of the wrong kind). Only once every slide's content and the deck's fonts are
   * known: before that, an image may still be needed.
   */
  sweep(p) {
    if (!this.sweepDue || !this.ids.length || !this.fonts) return;
    const keep = new Set();
    for (const id of this.ids) {
      const e = this.info.get(id);
      const sig = e?.sig;
      if (!sig) return;
      const vs = [this.exactV(sig), `${sig}${CAP}`];
      if (this.fonts.pdf && !this.hasExact(id, e)) vs.push(`${sig}${DRAFT}`); // the draft, until the exact one exists
      for (const v of vs) { keep.add(`${id}-${v}.jpg`); keep.add(`${id}-${v}.s.jpg`); }
    }
    this.sweepDue = false;
    const dir = this.deckDir(p);
    for (const f of fs.readdirSync(dir)) {
      if (keep.has(f)) continue;
      rm(path.join(dir, f));
      this.ready.delete(f.replace(/\.jpg$/, ''));
    }
  }

  /**
   * Slides for the UI. `v` names the best image there is (`thumb` false: none yet); `pending`
   * counts slides still waiting for the image they should have.
   */
  slidesForUi() {
    const p = this.focusPath();
    if (!p || p !== this.deck || !this.ids.length) return null;
    const now = Date.now();
    const show = this.inShow(p);
    let pending = 0;
    let drafts = 0;
    const slides = this.ids.map((id, i) => {
      const e = this.info.get(id) || { title: '', hidden: false, sig: null };
      const best = this.best(id, e);
      const draft = !!best && best.endsWith(DRAFT);
      if (!best) pending++;
      if (draft) drafts++;
      return {
        index: i + 1, id, title: e.title, hidden: e.hidden, v: best || e.sig || '', thumb: !!best, draft,
        changed: now - (this.changedAt.get(id) || 0) < CHANGED_FOR_MS,
      };
    });
    const fonts = this.fonts && (this.fonts.embedded.length || this.fonts.failed)
      ? { pdf: this.fonts.pdf, embedded: this.fonts.embedded, failed: !!this.fonts.failed }
      : null;
    // Rough time left for the missing images (render time measured so far, plus the rests).
    const per = this.fonts ? this.msPerSlide[this.fonts.pdf && !(show && !this.pdfInShow()) ? 'pdf' : 'export'] : null;
    const waitShow = false; // since 0.7.3 every slide gets an image during the show too (a draft if need be)
    const etaSec = pending && per ? Math.round((pending * per * 1.3) / 1000) : null;
    return { path: p, ratio: this.ratio, slides, pending, drafts, fonts, etaSec, waitShow, paused: !show && this.userInPowerPoint() };
  }

  /** "Reload all": forget every thumbnail of this deck and re-check every slide's content. */
  refreshThumbs() {
    if (!this.deck) return;
    const dir = this.deckDir(this.deck);
    for (const f of fs.readdirSync(dir)) rm(path.join(dir, f));
    this.ready.clear();
    for (const e of this.info.values()) e.sig = null;
    this.captureTried.clear();
    // If the PDF renderer had given up on this deck, check the fonts again and give it another go.
    if (this.fonts?.failed) this.fonts = null;
    this.pdfFailures = 0;
    this.onChange();
  }

  /** Path of a rendered thumbnail (small = strip size), or null if it isn't rendered (yet). */
  thumb(presPath, id, v, small = false) {
    const name = `${Number(id)}-${String(v).replace(/[^a-z0-9]/gi, '')}${small ? '.s' : ''}.jpg`;
    const f = path.join(this.deckDir(presPath), name);
    return fs.existsSync(f) ? f : null;
  }
}

module.exports = { PowerPoint };
