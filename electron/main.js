// Stagio desktop app: runs the Stagio server inside the app and shows the console in a window.
// Phones and other computers still connect to it over Wi-Fi as before.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Lite, Standard or Extra (lib/edition.js). Read here first: the server reads the same.
const edition = require('../lib/edition').current();
process.env.STAGIO_EDITION = edition.id;
process.env.STAGIO_VERSION = edition.version;

// All three editions share one data folder (settings, PIN, cues, runs of show, this window's
// place), the one Stagio has always used, so moving to another edition keeps everything. Sharing
// it also makes them one app to Windows/macOS for "only one at a time": a second Stagio of any
// edition reaches the running one (see 'second-instance') instead of starting.
app.setPath('userData', path.join(app.getPath('appData'), 'OneDesk'));

if (!app.requestSingleInstanceLock({ edition: edition.id, name: edition.name, exe: process.execPath })) {
  app.quit(); // already running: the first copy brings its window forward, or offers to switch
} else {
  // Settings, PIN and cues live in the user's app-data folder (the install folder is read-only).
  process.env.STAGIO_DATA ||= app.getPath('userData');
  // Thumbnails: PowerPoint on Windows could not export into folders under AppData, so use the home folder.
  if (process.platform === 'win32') process.env.STAGIO_THUMBS ||= path.join(os.homedir(), '.onedesk', 'thumbs');

  // There is no console window in the installed app; keep a log for troubleshooting.
  const logFile = path.join(process.env.STAGIO_DATA, 'stagio.log');
  try {
    fs.mkdirSync(process.env.STAGIO_DATA, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`);
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    for (const level of ['log', 'warn', 'error']) {
      const orig = console[level].bind(console);
      console[level] = (...args) => {
        orig(...args);
        log.write(`${new Date().toISOString()} ${level.toUpperCase()} ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}\n`);
      };
    }
  } catch { /* logging is best effort */ }

  let win = null;
  let server = null;
  let consoleOrigin = '';

  // ---- Extra: the opening countdown on the projector ----
  // Full screen on the screen Stagio's window is not on, above PowerPoint's slide show (the run
  // of show closes it once the next part is up). With only one screen (or Duplicate) it opens as
  // an ordinary window instead, so it can be checked without covering the console.
  let cdWin = null;
  let cdMode = 'off'; // 'full' | 'window' | 'off'
  const otherScreen = () => {
    const all = screen.getAllDisplays();
    if (all.length < 2) return null;
    const mine = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
    return all.find((d) => d.id !== mine.id) || null;
  };
  const countdownScreen = {
    show() {
      const proj = otherScreen();
      const want = proj ? 'full' : 'window';
      if (cdWin && !cdWin.isDestroyed() && cdMode === want) { cdWin.showInactive(); return; }
      if (cdWin && !cdWin.isDestroyed()) cdWin.destroy();
      const area = screen.getPrimaryDisplay().workArea;
      const b = proj ? proj.bounds : { x: area.x + Math.round((area.width - 960) / 2), y: area.y + Math.round((area.height - 540) / 2), width: 960, height: 540 };
      cdWin = new BrowserWindow({
        ...b,
        show: false,
        frame: !proj,
        resizable: !proj,
        skipTaskbar: !!proj,
        focusable: !proj, // full screen it never takes the keyboard from the console
        alwaysOnTop: !!proj,
        backgroundColor: '#000000',
        title: `${edition.name} · countdown`,
        icon: fs.existsSync(icon) ? icon : undefined,
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      if (proj) { cdWin.setAlwaysOnTop(true, 'screen-saver'); cdWin.setBounds(proj.bounds); }
      cdMode = want;
      cdWin.on('closed', () => { cdWin = null; cdMode = 'off'; });
      cdWin.webContents.on('will-navigate', (e) => e.preventDefault());
      cdWin.on('page-title-updated', (e) => e.preventDefault()); // keeps "Stagio Extra · countdown"
      cdWin.once('ready-to-show', () => cdWin?.showInactive());
      cdWin.loadURL(new URL('countdown.html', server.url).href);
    },
    hide() {
      if (cdWin && !cdWin.isDestroyed()) cdWin.destroy();
      cdWin = null;
      cdMode = 'off';
    },
    // After the run of show ends one file's show, PowerPoint's own window comes up on this screen,
    // over Stagio. With two screens the console is brought back in front; with one screen (or
    // Duplicate) nothing is done, since that would cover the slides on the projector.
    focusConsole() {
      if (!win || win.isDestroyed() || !otherScreen()) return;
      win.setAlwaysOnTop(true);
      win.show();
      win.focus();
      setTimeout(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); }, 400);
    },
    mode: () => cdMode,
  };

  // The console's "Open…" button: the normal Windows/Mac file window. Answers only the console
  // page in Stagio's own window.
  const DECK_TYPES = ['pptx', 'ppt', 'pptm', 'ppsx', 'pps', 'ppsm', 'potx', 'pot', 'potm', 'odp'];
  ipcMain.handle('stagio:pick-deck', async (e) => {
    let from = '';
    try { from = new URL(e.senderFrame.url).origin; } catch { /* no frame: refuse below */ }
    if (!win || e.sender !== win.webContents || from !== consoleOrigin) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'Open presentation',
      properties: ['openFile'],
      filters: [{ name: 'PowerPoint presentations', extensions: DECK_TYPES }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? null : (r.filePaths[0] || null);
  });

  const icon = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

  // The window opens where it was last time, the size it had (if that place is still on a screen);
  // the first time, as large as the screen allows (maximized on a laptop-sized screen).
  const boundsFile = path.join(process.env.STAGIO_DATA, 'window.json');
  function savedBounds() {
    try {
      const b = JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
      const area = screen.getDisplayMatching(b).workArea;
      const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 && b.y >= area.y - 10 && b.y < area.y + area.height - 100;
      return visible ? b : null;
    } catch { return null; }
  }
  function saveBounds() {
    if (!win) return;
    try { fs.writeFileSync(boundsFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* best effort */ }
  }

  function openWindow(url) {
    const saved = savedBounds();
    const area = screen.getPrimaryDisplay().workAreaSize;
    const small = area.width < 1440 || area.height < 900;
    win = new BrowserWindow({
      ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: Math.min(1440, area.width), height: Math.min(900, area.height) }),
      minWidth: 900,
      minHeight: 600,
      backgroundColor: '#0b0c0d',
      title: edition.name,
      icon: fs.existsSync(icon) ? icon : undefined,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
    });
    if (saved ? saved.maximized : small) win.maximize();
    consoleOrigin = new URL(url).origin;
    win.loadURL(url);
    // A file dropped outside the console's own drop handling would otherwise replace the console
    // with that file; the window only ever shows web pages (the console).
    win.webContents.on('will-navigate', (e, target) => {
      if (!/^https?:\/\//i.test(target)) e.preventDefault();
    });
    // Web links (the guide, the source code) open in the normal browser (web links only).
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//i.test(target)) shell.openExternal(target);
      return { action: 'deny' };
    });
    // Closing the window quits Stagio, which cuts off the phone remotes and the cues. Mid-show
    // that is almost always a slip, so ask first. The question doesn't hold Stagio up: the
    // server runs in this same process, and phones and cues keep working while it is open.
    win.on('close', (e) => {
      saveBounds();
      if (switching || quitConfirmed) return; // already decided (switch edition / Quit Stagio)
      let st = null;
      try { st = server?.status(); } catch { /* server not up: nothing to protect */ }
      if (!st || (!st.live && !st.remotes && !st.job)) return;
      let message;
      let detail;
      if (st.job) {
        // Quitting half-way through a speed-up: nothing is lost (the file is only changed in the
        // last step, and the copy is only kept when finished), but the work so far is.
        message = st.job.mode === 'restore'
          ? `Stagio is putting an earlier version of ${st.job.file} back right now.`
          : st.job.applying
            ? `Stagio is saving the sped-up ${st.job.file} right now.`
            : `Stagio is speeding up ${st.job.file} (${st.job.done} of ${st.job.total || '…'} slides).`;
        detail = st.job.applying
          ? 'Wait a few seconds until it has finished, then quit.'
          : 'If you quit now, that stops and nothing is changed. You can start it again later.';
      } else {
        message = st.live ? 'A slide show is running.' : `${st.remotes} remote device${st.remotes === 1 ? ' is' : 's are'} connected.`;
        detail = 'Quitting Stagio stops the phone remotes and the cues. The slide show itself keeps running in PowerPoint.';
      }
      e.preventDefault();
      if (asking) return;
      asking = true;
      dialog.showMessageBox(win, {
        type: 'warning', title: edition.name, message, detail,
        buttons: ['Keep Stagio open', 'Quit Stagio'],
        defaultId: 0,
        cancelId: 0,
      }).then(({ response }) => {
        asking = false;
        if (response === 1 && win && !win.isDestroyed()) { quitConfirmed = true; win.close(); }
      }, () => { asking = false; });
    });
    win.on('closed', () => { win = null; });
  }
  let asking = false;        // a question is on screen (one at a time)
  let quitConfirmed = false; // "Quit Stagio" was chosen

  // Another Stagio was started while this one runs. The same edition: bring this window forward.
  // Another edition: only one can run (both would drive the same PowerPoint, on the same port), so
  // ask whether to switch. Switching closes this one and starts the other; the data is shared.
  let switching = false;
  app.on('second-instance', async (event, argv, cwd, other) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (!other?.edition || other.edition === edition.id || !other.exe || switching || asking) return;
    let st = null;
    try { st = server?.status(); } catch { /* not up */ }
    const busy = st && (st.live || st.remotes || st.job);
    // Asked without holding Stagio up: during a show the phones and cues keep working meanwhile.
    asking = true;
    const choice = await dialog.showMessageBox(win, {
      type: busy ? 'warning' : 'question',
      title: edition.name,
      message: `Switch to ${other.name || 'the other Stagio'}?`,
      detail: `Only one Stagio can be open at a time. ${edition.name} closes and ${other.name || 'the other one'} opens, with the same settings, cues and PIN.` +
        (busy ? `

${st.live ? 'A slide show is running: it keeps running in PowerPoint, but phones and cues stop for a few seconds.' : st.job ? 'A speed-up is in progress: it stops and nothing is changed.' : 'Phones connected to Stagio reconnect by themselves.'}` : ''),
      buttons: [`Keep ${edition.name}`, `Switch to ${other.name || 'it'}`],
      defaultId: 0,
      cancelId: 0,
    }).then((r) => r.response, () => 0);
    asking = false;
    if (choice !== 1 || !win || win.isDestroyed()) return;
    switching = true;
    app.relaunch({ execPath: other.exe, args: [] });
    app.quit();
  });

  // Windows groups a running window with its pinned shortcut by this ID; Standard keeps the one
  // Stagio always had, so an existing pinned shortcut still matches.
  app.setAppUserModelId({ lite: 'app.onedesk.lite', extra: 'app.onedesk.extra' }[edition.id] || 'app.onedesk.console');

  app.whenReady().then(async () => {
    // Windows: no menu bar. Mac: keep the standard app menu (copy/paste, quit).
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    try {
      server = require('../server.js');
      server.setScreenHost?.(countdownScreen);
      openWindow(await server.ready);
    } catch (e) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        title: edition.name,
        message: 'Stagio could not start its console.',
        detail: `${e.message}\n\nAnother copy of Stagio (for example "Start Stagio.bat") may already be running and using port 7300. You can open that one, or close it and start Stagio again.`,
        buttons: ['Open the running Stagio', 'Quit'],
        defaultId: 0,
      });
      if (choice === 0) openWindow('http://127.0.0.1:7300/');
      else app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { try { server?.stop(); } catch { /* already stopped */ } });
}
