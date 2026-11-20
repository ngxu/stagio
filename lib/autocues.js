// Auto cues: a cue can run by itself when the show arrives at a slide.
//   - bound in the cue editor: cue.auto = { deck, slideId, slide }. The slide is followed by its
//     ID, so the cue stays on the right slide when others insert, delete or move slides;
//   - or named in that slide's speaker notes: [cue: Break] or [cue 2] (the second cue button),
//     which lets whoever is building the slides place the cues.
// Rules that keep this safe in a live show:
//   - only on arriving going forward, or when the show starts on that slide: stepping back to
//     re-read a slide does not start the music again;
//   - the slide has to stay up for a moment, so paging quickly through the deck fires nothing;
//   - a cue never fires twice within a few seconds, and not while it is already running.

const DWELL_MS = 500;
const COOLDOWN_MS = 3000;

const deckName = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase();

/** Cues named in speaker notes: [cue: name] (the start of the name is enough) or [cue 3]. */
function cuesInNotes(notes, cues) {
  const out = [];
  const re = /[[【]\s*cue\s*[:：]?\s*([^\]】\r\n]{1,60})[\]】]/gi;
  let m;
  while ((m = re.exec(String(notes || '')))) {
    const want = m[1].trim().toLowerCase();
    if (!want) continue;
    const cue = cues.find((c) => String(c.name).toLowerCase() === want)
      || (/^\d+$/.test(want) ? cues[Number(want) - 1] : null)
      || cues.find((c) => String(c.name).toLowerCase().startsWith(want));
    if (cue && !out.includes(cue)) out.push(cue);
  }
  return out;
}

/** The cues that belong to the slide now showing (`show` is the show state: path, slideId, notes). */
function cuesForSlide(show, cues) {
  const bound = cues.filter((c) => c.auto && Number(c.auto.slideId) === show.slideId
    && (!c.auto.deck || deckName(c.auto.deck) === deckName(show.path)));
  return [...new Set([...bound, ...cuesInNotes(show.notes, cues)])];
}

class AutoCues {
  /**
   * cues():      the current cue list
   * enabled():   the master switch
   * current():   the show state right now (null when no show)
   * isRunning(id), run(cue) -> errors[], onFire(): tell the consoles
   */
  constructor({ cues, enabled, current, isRunning, run, onFire, dwellMs = DWELL_MS, cooldownMs = COOLDOWN_MS }) {
    Object.assign(this, { cues, enabled, current, isRunning, run, onFire, dwellMs, cooldownMs });
    this.timer = null;
    this.ranAt = new Map(); // cue id -> when it last ran (by itself or from its button)
    this.last = null;       // { id, name, slide, at, errors } — what the consoles announce
  }

  /** A cue was run by hand; don't auto-run the same one right behind it. */
  noteRun(id) { this.ranAt.set(id, Date.now()); }

  /** Called whenever a different slide is on the projector, or a show starts or ends. */
  onSlideChange(before, after, first) {
    clearTimeout(this.timer);
    this.timer = null;
    if (first || !after || !after.slideId || !this.enabled()) return;
    const sameShow = before && before.path === after.path;
    if (sameShow && !(after.slide > before.slide)) return; // went back
    if (!cuesForSlide(after, this.cues()).length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire(after).catch((e) => console.error(e));
    }, this.dwellMs);
    this.timer.unref?.();
  }

  async fire(arrived) {
    const now = this.current();
    if (!now || now.path !== arrived.path || now.slideId !== arrived.slideId || !this.enabled()) return;
    for (const cue of cuesForSlide(now, this.cues())) {
      const at = Date.now();
      if (this.isRunning(cue.id) || at - (this.ranAt.get(cue.id) || 0) < this.cooldownMs) continue;
      this.ranAt.set(cue.id, at);
      const note = { id: cue.id, name: cue.name, slide: now.slide, at, errors: [] };
      this.last = note;
      this.onFire();
      let errors;
      try { errors = await this.run(cue); } catch (e) { errors = [e.message]; }
      if (errors.length) {
        note.errors = errors;
        this.last = { ...note };
        this.onFire();
      }
    }
  }

  stop() { clearTimeout(this.timer); this.timer = null; }
}

module.exports = { AutoCues, cuesInNotes, cuesForSlide, deckName };
