// Talks to the Mac helper (mac/helper/main.swift, built into build/mac-helper/stagio-mac-helper
// and packaged as Resources/mac-helper/stagio-mac-helper): JSON lines over stdin/stdout, the same
// call() shape as lib/helper.js so the shared code (program feed, Bluetooth) can use either.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

function findBinary() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'mac-helper', 'stagio-mac-helper'), // the app
    path.join(__dirname, '..', '..', '..', 'build', 'mac-helper', 'stagio-mac-helper'),          // from source
  ].filter(Boolean);
  return candidates.find((f) => fs.existsSync(f)) || null;
}

class Native {
  constructor(bin = findBinary()) {
    this.bin = bin && fs.existsSync(bin) ? bin : null;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.restarts = 0;
    this.calls = 0;
  }

  get available() { return !!this.bin; }

  start() {
    if (this.proc || !this.bin) return;
    const proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error || 'Mac helper error'));
    });
    proc.stderr.on('data', () => {});
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Mac helper stopped')); }
      this.pending.clear();
      this.restarts++;
    });
  }

  call(cmd, args = {}, { timeoutMs = 10000 } = {}) {
    if (!this.bin) return Promise.reject(new Error('Not available: the Mac helper is missing'));
    this.start();
    this.calls++;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.proc.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  stop() { if (this.proc) { try { this.proc.stdin.end(); } catch { /* gone */ } this.proc = null; } }
}

module.exports = { Native, findBinary };
