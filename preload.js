const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // Storage paths
  getStoragePaths: () => ipcRenderer.invoke('get-storage-paths'),
  deleteCaseFolder: (caseNumber) => ipcRenderer.invoke('delete-case-folder', caseNumber),
  createCaseFolder: (caseNumber) => ipcRenderer.invoke('create-case-folder', caseNumber),
  caseFolderExists: (caseNumber) => ipcRenderer.invoke('case-folder-exists', caseNumber),
  saveCaseTextFile: (data) => ipcRenderer.invoke('save-case-text-file', data),
  deleteCaseEvidence: (caseNumber) => ipcRenderer.invoke('delete-case-evidence', caseNumber),

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
  selectDmvFile: () => ipcRenderer.invoke('select-dmv-file'),
  extractPdfText: (filePath) => ipcRenderer.invoke('extract-pdf-text', filePath),
  resolveWarrantPath: (data) => ipcRenderer.invoke('resolve-warrant-path', data),
  viewWarrantExternal: (filePath) => ipcRenderer.invoke('view-warrant-external', filePath),

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

  // FMCSA Carrier Lookup
  fmcsaLookup: (params) => ipcRenderer.invoke('fmcsa-lookup', params),

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

  // Warrant file storage
  saveWarrantFile: (data) => ipcRenderer.invoke('save-warrant-file', data),
  readWarrantFile: (filePath) => ipcRenderer.invoke('read-warrant-file', filePath),

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

  // Canvas Forms (Railway-hosted)
  canvasFormCreate: (params) => ipcRenderer.invoke('canvas-form-create', params),
  canvasFormGetInfo: (params) => ipcRenderer.invoke('canvas-form-get-info', params),
  canvasFormDownload: (params) => ipcRenderer.invoke('canvas-form-download', params),
  canvasFormDelete: (params) => ipcRenderer.invoke('canvas-form-delete', params),

  // Cellebrite Report Integration
  selectCellebriteFolder: () => ipcRenderer.invoke('select-cellebrite-folder'),
  scanCellebriteFolder: (folderPath) => ipcRenderer.invoke('scan-cellebrite-folder', folderPath),
  launchCellebriteReader: (exePath) => ipcRenderer.invoke('launch-cellebrite-reader', exePath),
  copyCellebriteFolder: (data) => ipcRenderer.invoke('copy-cellebrite-folder', data),
  onCellebriteCopyProgress: (callback) => ipcRenderer.on('cellebrite-copy-progress', (_e, data) => callback(data)),
  // Cellebrite embedded viewer (Win32)
  cellebriteLaunchEmbedded: (data) => ipcRenderer.invoke('cellebrite-launch-embedded', data),
  cellebriteSetBounds: (bounds) => ipcRenderer.send('cellebrite-set-bounds', bounds),
  cellebriteSetVisible: (visible) => ipcRenderer.send('cellebrite-set-visible', visible),
  cellebriteClose: () => ipcRenderer.invoke('cellebrite-close'),
  onCellebriteEmbedClosed: (callback) => ipcRenderer.on('cellebrite-embed-closed', callback),

  // Oversight Import
  selectOversightFile: () => ipcRenderer.invoke('select-oversight-file'),
  importOversightFile: (data) => ipcRenderer.invoke('import-oversight-file', data),
  readOversightFile: (filePath) => ipcRenderer.invoke('read-oversight-file', filePath),

  // Auto-Update
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_e, data) => callback(data)),

  // Media Player (persistent BrowserView)
  mediaSetBounds: (bounds) => ipcRenderer.send('media-set-bounds', bounds),
  mediaSetVisible: (visible) => ipcRenderer.send('media-set-visible', visible),
  onToggleMediaPlayer: (callback) => ipcRenderer.on('toggle-media-player', callback),
  onRequestMediaBounds: (callback) => ipcRenderer.on('request-media-bounds', callback),

  // Flock Safety LPR (persistent BrowserView)
  flockSetBounds: (bounds) => ipcRenderer.send('flock-set-bounds', bounds),
  flockSetVisible: (visible) => ipcRenderer.send('flock-set-visible', visible),
  flockSearchPlate: (params) => ipcRenderer.invoke('flock-search-plate', params),
  flockReset: () => ipcRenderer.invoke('flock-reset'),

  // TLO / TransUnion (persistent BrowserView)
  tloSetBounds: (bounds) => ipcRenderer.send('tlo-set-bounds', bounds),
  tloSetVisible: (visible) => ipcRenderer.send('tlo-set-visible', visible),
  tloSearchPerson: (params) => ipcRenderer.invoke('tlo-search-person', params),
  tloReset: () => ipcRenderer.invoke('tlo-reset'),
  accurintSetBounds: (bounds) => ipcRenderer.send('accurint-set-bounds', bounds),
  accurintSetVisible: (visible) => ipcRenderer.send('accurint-set-visible', visible),
  accurintSearchPerson: (params) => ipcRenderer.invoke('accurint-search-person', params),
  accurintReset: () => ipcRenderer.invoke('accurint-reset'),
});
