// Which Stagio this is: Lite, Standard or Extra. One program, three editions, each with its own
// download, name and version number (editions.json). They share one data folder, so moving from
// one to another keeps the settings, PIN, cues and runs of show.
//
//   Lite      people presenting their own slides: slides, notes, timer, phone remote
//   Standard  one person running slides, music and the projector (the Stagio of 0.x)
//   Extra     Standard + the whole event: run of show, opening countdown, stage display
//
// Where the edition comes from, first found wins:
//   STAGIO_EDITION / STAGIO_VERSION      set by the desktop app, or by hand for testing
//   <resources>/edition.json              written by the Windows installer
//   package.json "edition" / "version"    set when the Mac app is built (electron-builder)
//   standard                              running from the source folder
const fs = require('fs');
const path = require('path');

const EDITIONS = require('../editions.json');

// What each edition shows. Everything not listed is in all three (slides, notes, timer, phone
// remote, pre-event check, speed-up, backup connections).
const FEATURES = {
  // preview: headphone preview (basic in Standard); previewPro: its full settings (Extra)
  lite: { music: false, audio: false, displayMode: false, cues: false, run: false, stage: false, preview: false, previewPro: false },
  standard: { music: true, audio: true, displayMode: true, cues: true, run: false, stage: false, preview: true, previewPro: false },
  extra: { music: true, audio: true, displayMode: true, cues: true, run: true, stage: true, preview: true, previewPro: true },
};

function readEditionFile() {
  if (!process.resourcesPath) return null; // plain Node (running from the source folder)
  try {
    const j = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'edition.json'), 'utf8'));
    if (j && FEATURES[j.edition]) return j;
  } catch { /* not there */ }
  return null;
}

/** "1.0.0-beta" → "Beta 1.0"; "1.2.1-beta" → "Beta 1.2.1"; "1.0.0" → "1.0"; "0.8.1" → "0.8.1". */
function versionLabel(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)[.\d]*)?$/i.exec(String(v || ''));
  if (!m) return String(v || '');
  const [, major, minor, patch, pre] = m;
  const num = Number(major) >= 1 && patch === '0' ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
  return pre ? `${pre[0].toUpperCase()}${pre.slice(1).toLowerCase()} ${num}` : num;
}

function current() {
  let pkg = {};
  try { pkg = require('../package.json'); } catch { /* keep defaults */ }
  const file = readEditionFile();
  const id = [process.env.STAGIO_EDITION, file?.edition, pkg.edition, 'standard'].find((x) => x && FEATURES[x]);
  const version = process.env.STAGIO_VERSION || (file?.edition === id ? file.version : '') || pkg.version || '';
  return {
    id,
    name: EDITIONS[id]?.name || `Stagio ${id}`,
    version,
    label: versionLabel(version),
    features: { ...FEATURES[id] },
  };
}

module.exports = { current, versionLabel, FEATURES, EDITIONS };
