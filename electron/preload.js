// Bridge between the console page and the desktop app: the native "Open" window, and the real
// path of a file dropped onto the window (a web page alone never learns where a file lives).
// Only the console page on this PC gets it; anything else loaded in the window does not.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

if (['127.0.0.1', 'localhost'].includes(location.hostname)) {
  contextBridge.exposeInMainWorld('stagioApp', {
    /** Shows the Open window; resolves with the chosen file's path, or null if cancelled. */
    pickDeck: () => ipcRenderer.invoke('stagio:pick-deck'),
    /** Full path of a dropped file ('' if it is not a file on disk). */
    pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  });
}
