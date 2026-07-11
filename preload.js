const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  // Synchronous: true when running an unpackaged dev build (npm start).
  isDevBuild: () => { try { return ipcRenderer.sendSync('get-is-dev'); } catch { return false; } },
  platform: process.platform,  // 'win32' | 'darwin' | 'linux' — for telemetry & UA-aware code
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // Resolve a real filesystem path from a dropped File (Electron 32+ safe).
  // In Electron <32, File.path also still works in the renderer.
  getPathForFile: (file) => {
    try { return webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : (file && file.path) || ''; }
    catch (_) { return (file && file.path) || ''; }
  },

  // Storage paths
  getStoragePaths: () => ipcRenderer.invoke('get-storage-paths'),

  // Storage location overrides (Settings → Storage Locations)
  getStorageOverrides: () => ipcRenderer.invoke('get-storage-overrides'),
  chooseDirectory: (opts) => ipcRenderer.invoke('choose-directory', opts || {}),
  setCasesPath: (newPath) => ipcRenderer.invoke('set-cases-path', newPath),
  setUserDataPath: (newPath) => ipcRenderer.invoke('set-userdata-path', newPath),
  resetStoragePath: (which) => ipcRenderer.invoke('reset-storage-path', which),
  migrateCases: (opts) => ipcRenderer.invoke('migrate-cases', opts),
  onMigrateProgress: (cb) => {
    const handler = (_e, payload) => { try { cb(payload); } catch (_) {} };
    ipcRenderer.on('migrate-cases-progress', handler);
    return () => ipcRenderer.removeListener('migrate-cases-progress', handler);
  },
  migrateUserData: (opts) => ipcRenderer.invoke('migrate-userdata', opts),
  onMigrateUserDataProgress: (cb) => {
    const handler = (_e, payload) => { try { cb(payload); } catch (_) {} };
    ipcRenderer.on('migrate-userdata-progress', handler);
    return () => ipcRenderer.removeListener('migrate-userdata-progress', handler);
  },
  restartApp: () => ipcRenderer.invoke('restart-app'),

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

  // Note attachments — saved to cases/{caseNumber}/Notes/ on disk,
  // automatically included in the DA Export ZIP.
  noteSaveAttachment: (data) => ipcRenderer.invoke('note-save-attachment', data),
  noteReadAttachment: (data) => ipcRenderer.invoke('note-read-attachment', data),
  noteDeleteAttachment: (data) => ipcRenderer.invoke('note-delete-attachment', data),
  noteListAttachments: (caseNumber) => ipcRenderer.invoke('note-list-attachments', caseNumber),
  notesExportMergeAttachments: (data) => ipcRenderer.invoke('notes-export-merge-attachments', data),

  // Backup & Restore
  selectBackupDirectory: () => ipcRenderer.invoke('select-backup-directory'),
  createBackup: (data) => ipcRenderer.invoke('create-backup', data),
  createBackupZip: (data) => ipcRenderer.invoke('create-backup-zip', data),
  selectBackupFile: () => ipcRenderer.invoke('select-backup-file'),
  restoreBackup: (data) => ipcRenderer.invoke('restore-backup', data),
  restoreBackupZip: (data) => ipcRenderer.invoke('restore-backup-zip', data),

  // Diagnostic Report (diagnostic-edition builds)
  isDiagnosticMode: () => ipcRenderer.invoke('is-diagnostic-mode'),
  generateDiagnosticReport: () => ipcRenderer.invoke('generate-diagnostic-report'),
  showItemInFolder: (p) => ipcRenderer.invoke('show-item-in-folder', p),

  // RMS PDF Import
  openReportWindow: (caseNumber) => ipcRenderer.invoke('open-report-window', caseNumber),
  reportGet: (caseNumber) => ipcRenderer.invoke('report-get', caseNumber),
  reportSave: (caseNumber, content, lastSaved) => ipcRenderer.invoke('report-save', caseNumber, content, lastSaved),
  selectRmsFiles: () => ipcRenderer.invoke('select-rms-files'),
  selectDmvFile: () => ipcRenderer.invoke('select-dmv-file'),
  extractPdfText: (filePath) => ipcRenderer.invoke('extract-pdf-text', filePath),
  readFileAsDataUrl: (filePath) => ipcRenderer.invoke('read-file-as-data-url', filePath),
  resolveWarrantPath: (data) => ipcRenderer.invoke('resolve-warrant-path', data),
  viewWarrantExternal: (filePath) => ipcRenderer.invoke('view-warrant-external', filePath),
  deleteWarrantFiles: (opts) => ipcRenderer.invoke('delete-warrant-files', opts),

  // Parser Submission — structural sample of unsupported warrant format
  parserSamplePickFolder: () => ipcRenderer.invoke('parser-sample-pick-folder'),
  parserSamplePickZip: () => ipcRenderer.invoke('parser-sample-pick-zip'),
  parserSamplePickFile: () => ipcRenderer.invoke('parser-sample-pick-file'),
  parserSampleBuild: (opts) => ipcRenderer.invoke('parser-sample-build', opts),
  parserSampleSubmit: (opts) => ipcRenderer.invoke('parser-sample-submit', opts),
  onParserSampleProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_evt, payload) => { try { cb(payload); } catch {} };
    ipcRenderer.on('parser-sample-progress', handler);
    return () => ipcRenderer.removeListener('parser-sample-progress', handler);
  },

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
  googleWarrantReadMedia: (data) => ipcRenderer.invoke('google-warrant-read-media', data),
  googleWarrantGetMediaUrl: (data) => ipcRenderer.invoke('google-warrant-get-media-url', data),

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
  xWarrantScan: (data) => ipcRenderer.invoke('x-warrant-scan', data),
  xWarrantImport: (data) => ipcRenderer.invoke('x-warrant-import', data),
  xWarrantPickFile: () => ipcRenderer.invoke('x-warrant-pick-file'),
  xWarrantReadMedia: (data) => ipcRenderer.invoke('x-warrant-read-media', data),

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

  // v3.8.7 — Field Security Recovery
  securityRecoveryCreateSession: (data) => ipcRenderer.invoke('security-recovery-create-session', data),
  securityRecoveryScan: (data) => ipcRenderer.invoke('security-recovery-scan', data),
  securityRecoveryPreflight: (data) => ipcRenderer.invoke('security-recovery-preflight', data),
  securityRecoveryDecryptAll: (data) => ipcRenderer.invoke('security-recovery-decrypt-all', data),
  securityRecoveryDispose: (data) => ipcRenderer.invoke('security-recovery-dispose', data),
  securityRecoveryPickConfig: () => ipcRenderer.invoke('security-recovery-pick-config'),
  securityRecoveryPickWorkingDir: () => ipcRenderer.invoke('security-recovery-pick-working-dir'),
  securityRecoveryPickSearchRoot: () => ipcRenderer.invoke('security-recovery-pick-search-root'),
  securityRecoverySearchConfig: (data) => ipcRenderer.invoke('security-recovery-search-config', data),
  securityRecoverySearchOnProgress: (cb) => {
    const handler = (_evt, p) => { try { cb(p); } catch (_) {} };
    ipcRenderer.on('security-recovery-search-progress', handler);
    return () => ipcRenderer.removeListener('security-recovery-search-progress', handler);
  },
  securityScanEncryptedSummary: () => ipcRenderer.invoke('security-scan-encrypted-summary'),
  securityRecoveryOnProgress: (cb) => {
    const handler = (_evt, p) => { try { cb(p); } catch (_) {} };
    ipcRenderer.on('security-recovery-progress', handler);
    return () => ipcRenderer.removeListener('security-recovery-progress', handler);
  },
  securityDisableOnProgress: (cb) => {
    const handler = (_evt, p) => { try { cb(p); } catch (_) {} };
    ipcRenderer.on('security-disable-progress', handler);
    return () => ipcRenderer.removeListener('security-disable-progress', handler);
  },

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

  // ── Whisper on-device transcription (Faster-Whisper-XXL) ──
  whisperStatus: () => ipcRenderer.invoke('whisper-status'),
  whisperTranscribe: (opts) => ipcRenderer.invoke('whisper-transcribe', opts),
  whisperCancel: (jobId) => ipcRenderer.invoke('whisper-cancel', jobId),
  whisperDownloadModel: (opts) => ipcRenderer.invoke('whisper-download-model', opts),
  onWhisperProgress: (callback) => {
    const listener = (_evt, payload) => { try { callback(payload); } catch (e) { console.error(e); } };
    ipcRenderer.on('whisper-progress', listener);
    return () => ipcRenderer.removeListener('whisper-progress', listener);
  },

  // ── Dictation (record → transcribe → Reports editor) ──
  // Batch mode: renderer records the mic, then hands the audio bytes here for
  // one-shot Whisper transcription (cleaner/more accurate than live streaming).
  dictationTranscribe: (opts) => ipcRenderer.invoke('dictation-transcribe', opts),
  // Live streaming handlers (retained; not used by the batch UI).
  dictationStatus: () => ipcRenderer.invoke('dictation-status'),
  dictationStart: (opts) => ipcRenderer.invoke('dictation-start', opts),
  dictationStop: () => ipcRenderer.invoke('dictation-stop'),
  onDictationPartial: (callback) => {
    const listener = (_evt, payload) => { try { callback(payload); } catch (e) { console.error(e); } };
    ipcRenderer.on('dictation-partial', listener);
    return () => ipcRenderer.removeListener('dictation-partial', listener);
  },
  onDictationFinal: (callback) => {
    const listener = (_evt, payload) => { try { callback(payload); } catch (e) { console.error(e); } };
    ipcRenderer.on('dictation-final', listener);
    return () => ipcRenderer.removeListener('dictation-final', listener);
  },
  onDictationEnded: (callback) => {
    const listener = (_evt, payload) => { try { callback(payload); } catch (e) { console.error(e); } };
    ipcRenderer.on('dictation-ended', listener);
    return () => ipcRenderer.removeListener('dictation-ended', listener);
  },

  // ── On-demand Whisper engine manager (download / install / remove) ──
  // The Whisper engines are not bundled in the installer; they are fetched on
  // demand from Settings and installed into <userData>/engines. See
  // electron-main.js whisper-engine-* handlers.
  whisperEngineStatus: () => ipcRenderer.invoke('whisper-engine-status'),
  whisperEngineDownload: (opts) => ipcRenderer.invoke('whisper-engine-download', opts),
  whisperEngineInstallFile: (opts) => ipcRenderer.invoke('whisper-engine-install-file', opts),
  whisperEngineRemove: () => ipcRenderer.invoke('whisper-engine-remove'),
  onWhisperEngineProgress: (callback) => {
    const listener = (_evt, payload) => { try { callback(payload); } catch (e) { console.error(e); } };
    ipcRenderer.on('whisper-engine-progress', listener);
    return () => ipcRenderer.removeListener('whisper-engine-progress', listener);
  },

  // Resource Hub download interception — route downloads from Flock /
  // ICACCOPS / ICAC Data System / etc. straight into a case's Evidence
  // or Warrants/Production folder instead of bouncing through Downloads.
  onResourceHubDownloadReady: (callback) => {
    const listener = (_evt, payload) => { try { callback(payload); } catch (e) { console.error(e); } };
    ipcRenderer.on('rh-download-ready', listener);
    return () => ipcRenderer.removeListener('rh-download-ready', listener);
  },
  resourceHubRouteDownload: (payload) => ipcRenderer.invoke('rh-download-route', payload),
  resourceHubCapturePdf: (payload) => ipcRenderer.invoke('rh-capture-pdf', payload),
  resourceHubCaptureHtml: (payload) => ipcRenderer.invoke('rh-capture-html', payload),

  // Warrant file storage
  saveWarrantFile: (data) => ipcRenderer.invoke('save-warrant-file', data),
  readWarrantFile: (filePath) => ipcRenderer.invoke('read-warrant-file', filePath),
  selectProductionZip: (data) => ipcRenderer.invoke('select-production-zip', data),

  // Forensic Devices (Device Exams) file storage
  saveForensicsFile: (data) => ipcRenderer.invoke('save-forensics-file', data),
  readForensicsFile: (filePath) => ipcRenderer.invoke('read-forensics-file', filePath),

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

  // Cellebrite (Mobile Forensics) — new v3.6.0 parser module
  cellebritePickBundle: () => ipcRenderer.invoke('cellebrite-pick-bundle'),
  cellebriteScanBundle: (data) => ipcRenderer.invoke('cellebrite-scan-bundle', data),
  cellebriteImport: (data) => ipcRenderer.invoke('cellebrite-import', data),
  cellebriteReadParsed: (data) => ipcRenderer.invoke('cellebrite-read-parsed', data),
  cellebriteDeleteImport: (data) => ipcRenderer.invoke('cellebrite-delete-import', data),
  cellebriteCancelImport: (data) => ipcRenderer.invoke('cellebrite-cancel-import', data),
  cellebriteMediaRead: (data) => ipcRenderer.invoke('cellebrite-media-read', data),
  onCellebriteImportProgress: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('cellebrite-import-progress', handler);
    return () => ipcRenderer.removeListener('cellebrite-import-progress', handler);
  },

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
  // Floating media player — main pushes updated bounds after drag/resize so
  // each open window can persist the user-chosen position to localStorage.
  onMediaBoundsChanged: (callback) => ipcRenderer.on('media-bounds-changed', (_e, b) => callback(b)),

  // CargoNet Theft Alert ingest (folder watcher → parsed alerts)
  cargonetGetStatus:    () => ipcRenderer.invoke('cargonet-get-status'),
  cargonetStart:        () => ipcRenderer.invoke('cargonet-start'),
  cargonetStop:         () => ipcRenderer.invoke('cargonet-stop'),
  cargonetPickFolder:   () => ipcRenderer.invoke('cargonet-pick-folder'),
  cargonetOpenFolder:   () => ipcRenderer.invoke('cargonet-open-folder'),
  cargonetList:         () => ipcRenderer.invoke('cargonet-list'),
  cargonetGet:          (id) => ipcRenderer.invoke('cargonet-get', id),
  cargonetMarkRead:     (id) => ipcRenderer.invoke('cargonet-mark-read', id),
  cargonetMarkAllRead:  () => ipcRenderer.invoke('cargonet-mark-all-read'),
  cargonetDelete:       (id) => ipcRenderer.invoke('cargonet-delete', id),
  cargonetRescan:       () => ipcRenderer.invoke('cargonet-rescan'),
  onCargonetNewAlert:   (callback) => ipcRenderer.on('cargonet-new-alert', (_e, payload) => callback(payload)),

  // Warrant Author (Multi-Business ESP Warrants)
  // Drafts live on disk under cases/{caseNumber}/Warrants/Drafts/{warrantId}/
  // manifest.json (VIPENC when Field Security enabled+unlocked).
  warrantAuthorListDrafts:               (casePath) => ipcRenderer.invoke('warrant-author-list-drafts', { casePath }),
  warrantAuthorGetDraft:                 (casePath, warrantId) => ipcRenderer.invoke('warrant-author-get-draft', { casePath, warrantId }),
  warrantAuthorSaveDraft:                (casePath, warrantId, draft) => ipcRenderer.invoke('warrant-author-save-draft', { casePath, warrantId, draft }),
  warrantAuthorDeleteDraft:              (casePath, warrantId) => ipcRenderer.invoke('warrant-author-delete-draft', { casePath, warrantId }),
  warrantAuthorGenerate:                 (payload) => ipcRenderer.invoke('warrant-author-generate', payload),
  warrantAuthorOpenGenerated:            (casePath, warrantId, format) => ipcRenderer.invoke('warrant-author-open-generated', { casePath, warrantId, format }),
  warrantAuthorPickProviderDir:          () => ipcRenderer.invoke('warrant-author-pick-provider-dir'),
  warrantAuthorReadProviderRegistry:     () => ipcRenderer.invoke('warrant-author-read-provider-registry'),
  warrantAuthorMarkAddendumServed:       (casePath, warrantId, addendumId, servedAt) => ipcRenderer.invoke('warrant-author-mark-addendum-served', { casePath, warrantId, addendumId, servedAt }),
  warrantAuthorMarkAddendumReturned:     (casePath, warrantId, addendumId, returnedAt, linkedReturnId) => ipcRenderer.invoke('warrant-author-mark-addendum-returned', { casePath, warrantId, addendumId, returnedAt, linkedReturnId }),
  warrantAuthorListBoilerplate:          () => ipcRenderer.invoke('warrant-author-list-boilerplate'),
  warrantAuthorSaveBoilerplate:          (paragraphs) => ipcRenderer.invoke('warrant-author-save-boilerplate', { paragraphs }),
  warrantAuthorResetBoilerplate:         () => ipcRenderer.invoke('warrant-author-reset-boilerplate'),
  warrantAuthorOpenDraftFolder:          (casePath, warrantId) => ipcRenderer.invoke('warrant-author-open-draft-folder', { casePath, warrantId }),
  onWarrantAuthorChange:                 (callback) => ipcRenderer.on('warrant-author-change', (_e, payload) => callback(payload)),

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
  whoosterSetBounds: (bounds) => ipcRenderer.send('whooster-set-bounds', bounds),
  whoosterSetVisible: (visible) => ipcRenderer.send('whooster-set-visible', visible),
  whoosterSearchPerson: (params) => ipcRenderer.invoke('whooster-search-person', params),
  whoosterReset: () => ipcRenderer.invoke('whooster-reset'),

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

  // Callyo (persistent BrowserView)
  callyoSetBounds: (bounds) => ipcRenderer.send('callyo-set-bounds', bounds),
  callyoSetVisible: (visible) => ipcRenderer.send('callyo-set-visible', visible),

  // Resource Hub generic per-BV zoom factor (0.5 .. 2.0)
  rhSetZoom: (resId, factor) => ipcRenderer.send('rh-set-zoom', { resId, factor }),

  // ── Supervisor Link (Push to V.I.P.E.R. — Supervisor Edition) ──────────
  // Discover online supervisor machines on the LAN and push datasets /
  // OPS plan PDFs for digital approval. Identity is read from localStorage
  // by the renderer and passed through on each call.
  supervisorLink: {
    status: (opts) => ipcRenderer.invoke('supervisor-link:status', opts || {}),
    discover: (opts) => ipcRenderer.invoke('supervisor-link:discover', opts || {}),
    scan: (opts) => ipcRenderer.invoke('supervisor-link:scan', opts || {}),
    diagnostics: (opts) => ipcRenderer.invoke('supervisor-link:diagnostics', opts || {}),
    push: (opts) => ipcRenderer.invoke('supervisor-link:push', opts || {}),
    buildOpsPdf: (ops) => ipcRenderer.invoke('supervisor-link:build-ops-pdf', ops || {}),
    resetPin: (opts) => ipcRenderer.invoke('supervisor-link:reset-pin', opts || {}),
    disconnect: () => ipcRenderer.invoke('supervisor-link:disconnect'),
    // ICAC assignment loop (supervisor -> investigator receive/acknowledge).
    listen: (opts) => ipcRenderer.invoke('supervisor-link:listen', opts || {}),
    stopListen: () => ipcRenderer.invoke('supervisor-link:stop-listen'),
    icacAck: (opts) => ipcRenderer.invoke('supervisor-link:icac-ack', opts || {}),
    icacAssignments: (opts) => ipcRenderer.invoke('supervisor-link:icac-assignments', opts || {}),
    onEvent: (cb) => {
      const handler = (_e, evt) => { try { cb(evt); } catch (_) {} };
      ipcRenderer.on('supervisor-link:event', handler);
      return () => ipcRenderer.removeListener('supervisor-link:event', handler);
    },
    onState: (cb) => {
      const handler = (_e, evt) => { try { cb(evt); } catch (_) {} };
      ipcRenderer.on('supervisor-link:state', handler);
      return () => ipcRenderer.removeListener('supervisor-link:state', handler);
    },
  },
});
