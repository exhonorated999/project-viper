const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // Resolve a real filesystem path from a dropped File (Electron 32+ safe).
  // In Electron <32, File.path also still works in the renderer.
  getPathForFile: (file) => {
    try { return webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : (file && file.path) || ''; }
    catch (_) { return (file && file.path) || ''; }
  },

  // Storage paths
  getStoragePaths: () => ipcRenderer.invoke('get-storage-paths'),
  deleteCaseFolder: (caseNumber) => ipcRenderer.invoke('delete-case-folder', caseNumber),
  createCaseFolder: (caseNumber) => ipcRenderer.invoke('create-case-folder', caseNumber),
  caseFolderExists: (caseNumber) => ipcRenderer.invoke('case-folder-exists', caseNumber),
  saveCaseTextFile: (data) => ipcRenderer.invoke('save-case-text-file', data),
  deleteCaseEvidence: (caseNumber) => ipcRenderer.invoke('delete-case-evidence', caseNumber),

  // Per-case auto-snapshot (data-loss recovery, v2.8.4+)
  saveCaseSnapshot: (data) => ipcRenderer.invoke('save-case-snapshot', data),
  loadCaseSnapshot: (caseNumber) => ipcRenderer.invoke('load-case-snapshot', caseNumber),
  listCaseSnapshots: () => ipcRenderer.invoke('list-case-snapshots'),
  deleteCaseSnapshot: (caseNumber) => ipcRenderer.invoke('delete-case-snapshot', caseNumber),

  // Backup & Restore
  selectBackupDirectory: () => ipcRenderer.invoke('select-backup-directory'),
  createBackup: (data) => ipcRenderer.invoke('create-backup', data),
  createBackupZip: (data) => ipcRenderer.invoke('create-backup-zip', data),
  selectBackupFile: () => ipcRenderer.invoke('select-backup-file'),
  restoreBackup: (data) => ipcRenderer.invoke('restore-backup', data),
  restoreBackupZip: (data) => ipcRenderer.invoke('restore-backup-zip', data),

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

  // GenLogs API Proxy
  genlogsRequest: (opts) => ipcRenderer.invoke('genlogs-request', opts),

  // Google Warrant Parser
  googleWarrantScan: (data) => ipcRenderer.invoke('google-warrant-scan', data),
  googleWarrantImport: (data) => ipcRenderer.invoke('google-warrant-import', data),
  googleWarrantPickFile: () => ipcRenderer.invoke('google-warrant-pick-file'),

  // META Warrant Parser
  metaWarrantScan: (data) => ipcRenderer.invoke('meta-warrant-scan', data),
  metaWarrantImport: (data) => ipcRenderer.invoke('meta-warrant-import', data),
  metaWarrantPickFile: () => ipcRenderer.invoke('meta-warrant-pick-file'),
  metaWarrantReadMedia: (data) => ipcRenderer.invoke('meta-warrant-read-media', data),

  // KIK Warrant Parser
  kikWarrantScan: (data) => ipcRenderer.invoke('kik-warrant-scan', data),
  kikWarrantImport: (data) => ipcRenderer.invoke('kik-warrant-import', data),
  kikWarrantPickFile: () => ipcRenderer.invoke('kik-warrant-pick-file'),
  kikWarrantReadMedia: (data) => ipcRenderer.invoke('kik-warrant-read-media', data),

  // Snapchat Warrant Parser
  snapchatWarrantScan: (data) => ipcRenderer.invoke('snapchat-warrant-scan', data),
  snapchatWarrantImport: (data) => ipcRenderer.invoke('snapchat-warrant-import', data),
  snapchatWarrantPickFile: () => ipcRenderer.invoke('snapchat-warrant-pick-file'),
  snapchatWarrantReadMedia: (data) => ipcRenderer.invoke('snapchat-warrant-read-media', data),

  // Discord Warrant Parser
  discordWarrantScan: (data) => ipcRenderer.invoke('discord-warrant-scan', data),
  discordWarrantImport: (data) => ipcRenderer.invoke('discord-warrant-import', data),
  discordWarrantPickFile: () => ipcRenderer.invoke('discord-warrant-pick-file'),
  discordWarrantReadMedia: (data) => ipcRenderer.invoke('discord-warrant-read-media', data),

  // Datapilot mobile-forensic CSV export parser
  datapilotScan: (data) => ipcRenderer.invoke('datapilot-scan', data),
  datapilotPickFolder: () => ipcRenderer.invoke('datapilot-pick-folder'),
  datapilotImport: (data) => ipcRenderer.invoke('datapilot-import', data),
  datapilotReadMedia: (data) => ipcRenderer.invoke('datapilot-read-media', data),
  datapilotGetMediaUrl: (data) => ipcRenderer.invoke('datapilot-get-media-url', data),
  datapilotExportFlagsBundle: (data) => ipcRenderer.invoke('datapilot-export-flags-bundle', data),
  datapilotReadBundleFile: (data) => ipcRenderer.invoke('datapilot-read-bundle-file', data),
  datapilotBundleMediaUrl: (data) => ipcRenderer.invoke('datapilot-bundle-media-url', data),

  // Generic Warrant Flag-to-Evidence (shared by Discord, Google, Meta, KIK, Snapchat, Aperture)
  warrantExportFlagsBundle: (data) => ipcRenderer.invoke('warrant-export-flags-bundle', data),
  warrantReadBundleFile: (data) => ipcRenderer.invoke('warrant-read-bundle-file', data),
  datapilotFolderSize: (data) => ipcRenderer.invoke('datapilot-folder-size', data),
  datapilotFolderExists: (data) => ipcRenderer.invoke('datapilot-folder-exists', data),
  datapilotCopyToEvidence: (data) => ipcRenderer.invoke('datapilot-copy-to-evidence', data),
  datapilotOnCopyProgress: (cb) => {
    const listener = (_e, payload) => { try { cb(payload); } catch (_) {} };
    ipcRenderer.on('datapilot-copy-progress', listener);
    return () => ipcRenderer.removeListener('datapilot-copy-progress', listener);
  },

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
  securityLock: (opts) => ipcRenderer.invoke('security-lock', opts),

  // Audit log
  auditLogRead: (opts) => ipcRenderer.invoke('audit-log-read', opts),
  auditLogExport: () => ipcRenderer.invoke('audit-log-export'),
  auditLogVerify: () => ipcRenderer.invoke('audit-log-verify'),
  auditLogSetEventForwarding: (enabled) => ipcRenderer.invoke('audit-log-set-event-forwarding', enabled),
  auditLogWrite: (payload) => ipcRenderer.invoke('audit-log-write', payload),

  // Evidence file storage
  selectEvidenceFiles: (data) => ipcRenderer.invoke('select-evidence-files', data),
  copyEvidenceFile: (data) => ipcRenderer.invoke('copy-evidence-file', data),
  saveEvidenceFile: (data) => ipcRenderer.invoke('save-evidence-file', data),
  readEvidenceFile: (filePath) => ipcRenderer.invoke('read-evidence-file', filePath),

  // Warrant file storage
  saveWarrantFile: (data) => ipcRenderer.invoke('save-warrant-file', data),
  readWarrantFile: (filePath) => ipcRenderer.invoke('read-warrant-file', filePath),
  selectProductionZip: (data) => ipcRenderer.invoke('select-production-zip', data),

  // Ops Plan file storage (photos/documents — bypass localStorage quota)
  saveOpsPlanFile: (data) => ipcRenderer.invoke('save-opsplan-file', data),
  readOpsPlanFile: (filePath) => ipcRenderer.invoke('read-opsplan-file', filePath),
  deleteOpsPlanFile: (filePath) => ipcRenderer.invoke('delete-opsplan-file', filePath),

  // CDR dumps (per-case JSON on disk — bypass localStorage quota)
  saveCdrDumps: (data) => ipcRenderer.invoke('save-cdr-dumps', data),
  readCdrDumps: (data) => ipcRenderer.invoke('read-cdr-dumps', data),

  // Department badge (single agency-wide image under userData/branding/)
  saveDeptBadge: (data) => ipcRenderer.invoke('save-dept-badge', data),
  readDeptBadge: () => ipcRenderer.invoke('read-dept-badge'),

  // HTML → PDF (no print dialog) for reports
  saveHtmlAsPdf: (data) => ipcRenderer.invoke('save-html-as-pdf', data),

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

  // Vigilant Solutions / Motorola VehicleManager LPR (persistent BrowserView)
  vigilantSetBounds: (bounds) => ipcRenderer.send('vigilant-set-bounds', bounds),
  vigilantSetVisible: (visible) => ipcRenderer.send('vigilant-set-visible', visible),
  vigilantSearchPlate: (params) => ipcRenderer.invoke('vigilant-search-plate', params),
  vigilantReset: () => ipcRenderer.invoke('vigilant-reset'),

  // ICAC Data System (persistent BrowserView)
  icacDataSystemSetBounds: (bounds) => ipcRenderer.send('icac-data-system-set-bounds', bounds),
  icacDataSystemSetVisible: (visible) => ipcRenderer.send('icac-data-system-set-visible', visible),

  // ICACCOPS (persistent BrowserView)
  icacCopsSetBounds: (bounds) => ipcRenderer.send('icac-cops-set-bounds', bounds),
  icacCopsSetVisible: (visible) => ipcRenderer.send('icac-cops-set-visible', visible),

  // Gridcop (persistent BrowserView)
  gridcopSetBounds: (bounds) => ipcRenderer.send('gridcop-set-bounds', bounds),
  gridcopSetVisible: (visible) => ipcRenderer.send('gridcop-set-visible', visible),

  // Resource Hub generic per-BV zoom factor (0.5 .. 2.0)
  rhSetZoom: (resId, factor) => ipcRenderer.send('rh-set-zoom', { resId, factor }),
});
