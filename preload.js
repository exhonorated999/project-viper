const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Storage paths
  getStoragePaths: () => ipcRenderer.invoke('get-storage-paths'),

  // Backup & Restore
  selectBackupDirectory: () => ipcRenderer.invoke('select-backup-directory'),
  createBackup: (data) => ipcRenderer.invoke('create-backup', data),
  selectBackupFile: () => ipcRenderer.invoke('select-backup-file'),
  restoreBackup: (data) => ipcRenderer.invoke('restore-backup', data),

  // RMS PDF Import
  openReportWindow: (caseNumber) => ipcRenderer.invoke('open-report-window', caseNumber),
  reportGet: (caseNumber) => ipcRenderer.invoke('report-get', caseNumber),
  reportSave: (caseNumber, content, lastSaved) => ipcRenderer.invoke('report-save', caseNumber, content, lastSaved),
  selectRmsFiles: () => ipcRenderer.invoke('select-rms-files'),
  extractPdfText: (filePath) => ipcRenderer.invoke('extract-pdf-text', filePath),

  // Case Export / Import
  saveCaseExport: (data) => ipcRenderer.invoke('save-case-export', data),
  openCaseImport: () => ipcRenderer.invoke('open-case-import'),
  saveDAExport: (data) => ipcRenderer.invoke('save-da-export', data),

  // Offense Reference Export / Import
  saveOffenseExport: (data) => ipcRenderer.invoke('save-offense-export', data),
  openOffenseImport: () => ipcRenderer.invoke('open-offense-import'),

  // Identifier Lookups
  arinLookup: (ipAddress) => ipcRenderer.invoke('arin-lookup', ipAddress),
  verifyEmail: (email) => ipcRenderer.invoke('verify-email', email),

  // Field Security
  securityCheck: () => ipcRenderer.invoke('security-check'),
  securitySetup: (data) => ipcRenderer.invoke('security-setup', data),
  securityUnlock: (data) => ipcRenderer.invoke('security-unlock', data),
  securityRecover: (data) => ipcRenderer.invoke('security-recover', data),
  securityChangePassword: (data) => ipcRenderer.invoke('security-change-password', data),
  securityNewRecoveryKey: () => ipcRenderer.invoke('security-new-recovery-key'),
  securityDisable: () => ipcRenderer.invoke('security-disable'),
  securityNavigateApp: () => ipcRenderer.invoke('security-navigate-app'),
  securitySaveVault: (data) => ipcRenderer.invoke('security-save-vault', data),
  securityLock: () => ipcRenderer.invoke('security-lock'),

  // Evidence file storage
  saveEvidenceFile: (data) => ipcRenderer.invoke('save-evidence-file', data),
  readEvidenceFile: (filePath) => ipcRenderer.invoke('read-evidence-file', filePath),

  // External app launch
  launchAperture: (caseData) => ipcRenderer.invoke('launch-aperture', caseData),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),

  // Aperture: data loading
  apertureLoadEmails: (caseId) => ipcRenderer.invoke('aperture-load-emails', caseId),
  apertureLoadSources: (caseId) => ipcRenderer.invoke('aperture-load-sources', caseId),

  // Aperture: importing
  apertureImportMbox: (data) => ipcRenderer.invoke('aperture-import-mbox', data),
  apertureImportEmailFile: (data) => ipcRenderer.invoke('aperture-import-email-file', data),

  // Aperture: update/flag
  apertureUpdateEmail: (data) => ipcRenderer.invoke('aperture-update-email', data),

  // Aperture: evidence scanning
  apertureScanEvidence: (data) => ipcRenderer.invoke('aperture-scan-evidence', data),

  // Aperture: notes
  apertureGetNotes: (data) => ipcRenderer.invoke('aperture-get-notes', data),
  apertureAddNote: (data) => ipcRenderer.invoke('aperture-add-note', data),
  apertureDeleteNote: (data) => ipcRenderer.invoke('aperture-delete-note', data),

  // Aperture: IP lookup
  apertureLookupIp: (data) => ipcRenderer.invoke('aperture-lookup-ip', data),

  // Aperture: attachments
  apertureOpenAttachment: (data) => ipcRenderer.invoke('aperture-open-attachment', data),
  apertureGetAttachmentData: (data) => ipcRenderer.invoke('aperture-get-attachment-data', data),

  // Aperture: report generation
  apertureGenerateReport: (data) => ipcRenderer.invoke('aperture-generate-report', data),

  // Media Player (persistent BrowserView)
  mediaSetBounds: (bounds) => ipcRenderer.send('media-set-bounds', bounds),
  mediaSetVisible: (visible) => ipcRenderer.send('media-set-visible', visible),
  onToggleMediaPlayer: (callback) => ipcRenderer.on('toggle-media-player', callback),
  onRequestMediaBounds: (callback) => ipcRenderer.on('request-media-bounds', callback),
});
