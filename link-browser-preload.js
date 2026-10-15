// Preload for the VIPER browser window's TOOLBAR page (link-browser.html).
// The web page underneath runs in its own sandboxed view with no preload at
// all — nothing here is reachable from Google Drive, OneDrive or any site.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viperLinkBrowser', {
  command: (name) => ipcRenderer.send('link-browser:cmd', String(name)),
  onState: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('link-browser:state', (_e, state) => cb(state));
  }
});
