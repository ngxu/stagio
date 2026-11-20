// Bridge to a long-running PowerShell process (ps/helper.ps1).
// Each Helper instance owns one process and processes commands one at a time,
// so slow work (thumbnail export) gets its own instance and never blocks slide control.
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

// In the installed app the code lives inside app.asar, which PowerShell can't read; the script is
// unpacked next to it (see "asarUnpack" in package.json).
const SCRIPT = path.join(__dirname, '..', 'ps', 'helper.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

class Helper {
  /**
   * @param recycleAfter  if set, the process is replaced by a fresh one (while idle) after this
   *                      many commands. Bounds memory growth in long-running COM-heavy helpers.
   */
  constructor(name, { timeoutMs = 10000, recycleAfter = 0 } = {}) {
    this.name = name;
    this.timeoutMs = timeoutMs;
    this.recycleAfter = recycleAfter;
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
    this.ready = null;
    this.stopped = false;
    this.restarts = 0;  // unexpected exits
    this.recycles = 0;  // planned replacements
    this.calls = 0;     // commands answered by the current process
    this.stats = {};    // cmd -> { n, totalMs, maxMs, lastMs }
  }

  start() {
    if (this.proc) return this.ready;
    const proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.calls = 0;
    let resolveReady, rejectReady;
    const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    ready.catch(() => {}); // a helper that dies before it is ready is handled by 'exit'
    this.ready = ready;

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); // byte-order mark on the first line
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) { resolveReady(); return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error || 'helper error'));
      if (proc === this.proc) {
        this.calls++;
        if (this.recycleAfter && this.calls >= this.recycleAfter && this.pending.size === 0) this.recycle();
      }
    });
    // Writing to a helper that just died raises EPIPE on stdin; the 'exit' handler below
    // already fails the pending calls and restarts it, so the error itself is ignored.
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error(`[helper:${this.name}] ${s}`);
    });
    proc.on('exit', (code) => {
      rejectReady(new Error('helper exited'));
      if (proc !== this.proc) return; // a recycled process finishing; its replacement is already running
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Background helper stopped unexpectedly and is restarting')); }
      this.pending.clear();
      this.proc = null;
      if (this.stopped) return; // Stagio is quitting
      console.warn(`[helper:${this.name}] exited (${code}), restarting`);
      this.restarts++;
      setTimeout(() => this.start().catch(() => {}), 100);
    });
    return this.ready;
  }

  /** Swap in a fresh process. Only called while idle, so no command is lost. */
  recycle() {
    const old = this.proc;
    this.proc = null;
    this.recycles++;
    this.start().catch(() => {});
    old.stdin.end(); // the old helper's read loop ends and it exits by itself
  }

  async call(cmd, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin.writable) {
        reject(new Error('Background helper is restarting, try again in a moment'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} timed out`));
      }, timeoutMs);
      // Per-command timing (queue wait + execution), shown in /api/debug.
      const t0 = Date.now();
      const done = () => {
        const st = (this.stats[cmd] ||= { n: 0, totalMs: 0, maxMs: 0, lastMs: 0 });
        const ms = Date.now() - t0;
        st.n++; st.totalMs += ms; st.lastMs = ms; st.maxMs = Math.max(st.maxMs, ms);
      };
      this.pending.set(id, { resolve: (v) => { done(); resolve(v); }, reject: (e) => { done(); reject(e); }, timer });
      // `exp`: the helper drops a command it only gets to after this time (it queued behind a
      // slow one). By then the caller has been told it timed out; running it late would surprise.
      this.proc.stdin.write(JSON.stringify({ id, cmd, args, exp: Date.now() + timeoutMs }) + '\n');
    });
  }

  stop() {
    this.stopped = true;
    if (this.proc) this.proc.kill();
  }
}

module.exports = { Helper };
