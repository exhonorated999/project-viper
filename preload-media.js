const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mediaAPI', {
  popOutMediaPlayer: (url) => ipcRenderer.invoke('pop-out-media-player', url),
  onPopoutClosed: (cb) => ipcRenderer.on('media-popout-closed', cb),
});
