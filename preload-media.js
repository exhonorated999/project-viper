const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mediaAPI', {
  popOutMediaPlayer: (url) => ipcRenderer.invoke('pop-out-media-player', url),
  onPopoutClosed: (cb) => ipcRenderer.on('media-popout-closed', cb),

  // Floating mode — drag / resize the BrowserView from inside its own renderer.
  // offsetX/Y for drag = mouse position relative to the BV when the drag began,
  // used by the main process to keep the same grab point under the cursor.
  dragStart: (offset) => ipcRenderer.send('media-drag-start', offset),
  dragEnd:   ()       => ipcRenderer.send('media-drag-end'),
  resizeStart: () => ipcRenderer.send('media-resize-start'),
  resizeEnd:   () => ipcRenderer.send('media-resize-end'),
});
