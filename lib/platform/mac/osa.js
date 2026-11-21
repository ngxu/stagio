// Runs AppleScript through `osascript`. One script at a time per queue, because the target app
// (PowerPoint, the music app) handles Apple events one at a time anyway; queuing keeps a slide command
// from interleaving with a long background script.
//
// Scripts return text using two separators so titles and notes may contain line breaks:
//   RS (record, char 30) between records, US (unit, char 31) between fields.
const { execFile } = require('child_process');

const RS = String.fromCharCode(30);
const US = String.fromCharCode(31);
const HEADER = 'set RS to character id 30\nset US to character id 31\n';

function osa(script, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', HEADER + script], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // "execution error: Microsoft PowerPoint got an error: ... (-1728)" -> the readable part
        const msg = String(stderr || err.message).replace(/^.*?execution error:\s*/s, '').replace(/\s*\(-?\d+\)\s*$/, '').trim();
        return reject(new Error(msg || 'AppleScript failed'));
      }
      resolve(String(stdout).replace(/\n$/, ''));
    });
  });
}

class Queue {
  constructor() { this.tail = Promise.resolve(); this.stats = {}; }
  /** Runs `osa(script)` after everything queued before it. `name` is for timing stats only. */
  run(name, script, timeoutMs) {
    const t0 = Date.now();
    const job = this.tail.then(() => osa(script, timeoutMs));
    this.tail = job.catch(() => {});
    return job.finally(() => {
      const st = (this.stats[name] ||= { n: 0, totalMs: 0, maxMs: 0, lastMs: 0 });
      const ms = Date.now() - t0;
      st.n++; st.totalMs += ms; st.lastMs = ms; st.maxMs = Math.max(st.maxMs, ms);
    });
  }
}

/** AppleScript string literal. */
const str = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Splits script output into records of fields. */
const records = (text) => (text ? text.split(RS).filter((r) => r.length).map((r) => r.split(US)) : []);

/** Numbers from AppleScript may use a decimal comma depending on the Mac's region. */
const num = (s) => { const n = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

module.exports = { osa, Queue, str, records, num, RS, US };
