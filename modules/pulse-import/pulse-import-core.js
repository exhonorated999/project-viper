// pulse-import-core.js — PULSE (.pulse) → VIPER case translation (pure Node)
// =====================================================================
// ICAC P.U.L.S.E. is being sunset; this lets its users import their cases
// into VIPER. A .pulse file is an AES-256-CBC encrypted ZIP:
//     [salt:32][iv:16][ciphertext]   key = PBKDF2(pw, salt, 100000, 32, sha256)
//   plaintext ZIP = manifest.json (gatherCaseData) + files/<subtree>
//
// This module is dependency-light (crypto + adm-zip only, both already in
// VIPER) and Electron-FREE so it can run in the main process AND in a plain
// Node test harness. It translates PULSE's relational schema into a VIPER
// per-case snapshot ({caseMetadata, moduleData, sharedData, tasks}) that
// VIPER's case-snapshot.js recover() ingests natively, plus a file plan the
// caller extracts to disk.
// =====================================================================

const crypto = require('crypto');
let AdmZip = null;
try { AdmZip = require('adm-zip'); } catch (_) { /* resolved by caller env */ }

// ── Crypto / container ───────────────────────────────────────────────
function decryptPulse(buffer, password) {
  const salt = buffer.slice(0, 32);
  const iv = buffer.slice(32, 48);
  const enc = buffer.slice(48);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function openPulse(buffer, password) {
  if (!AdmZip) AdmZip = require('adm-zip');
  let zipBuf;
  try {
    zipBuf = decryptPulse(buffer, password);
  } catch (e) {
    throw new Error('Decryption failed. Incorrect password or corrupted file.');
  }
  let zip;
  try {
    zip = new AdmZip(zipBuf);
  } catch (e) {
    throw new Error('Decryption succeeded but the archive is unreadable (wrong password?).');
  }
  const manEntry = zip.getEntry('manifest.json');
  if (!manEntry) throw new Error('Invalid PULSE file: manifest.json not found.');
  let manifest;
  try {
    manifest = JSON.parse(zip.readAsText('manifest.json'));
  } catch (e) {
    throw new Error('Invalid PULSE file: manifest.json is not valid JSON.');
  }
  if (!manifest || !manifest.export_metadata || !manifest.data) {
    throw new Error('Invalid PULSE file: incomplete manifest.');
  }
  return { zip, manifest };
}

// ── Small helpers ────────────────────────────────────────────────────
function toArr(x) { return Array.isArray(x) ? x : []; }
function s(x) { return (x == null) ? '' : String(x); }
function nz(x) { return (x == null) ? '' : x; }

// PULSE stores timestamps as "YYYY-MM-DD HH:MM:SS" (SQLite) or ISO.
// Normalize to ISO 8601; fall back to the original string if unparseable.
function isoDate(v) {
  if (!v) return '';
  const raw = String(v);
  let d = new Date(raw);
  if (isNaN(d.getTime())) d = new Date(raw.replace(' ', 'T'));
  if (isNaN(d.getTime())) d = new Date(raw.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? raw : d.toISOString();
}

// PULSE status → VIPER status (index.html: active/inactive/closed/closed-arrest/transferred)
function mapStatus(pulseStatus) {
  switch (s(pulseStatus).toLowerCase()) {
    case 'open': return 'active';
    case 'active': return 'active';
    case 'arrest': return 'closed-arrest';
    case 'closed-arrest': return 'closed-arrest';
    case 'closed': return 'closed';
    case 'inactive': return 'inactive';
    case 'referred':
    case 'transferred': return 'transferred';
    default: return 'active';
  }
}

// A base64 data URL from a zip entry (for inlining suspect photos).
function fileToDataUrl(zip, zipRelPath, mime) {
  try {
    const entry = zip.getEntry(zipRelPath);
    if (!entry) return '';
    const buf = entry.getData();
    if (!buf || !buf.length) return '';
    const ext = zipRelPath.split('.').pop().toLowerCase();
    const type = mime || ({
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp'
    }[ext] || 'application/octet-stream');
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (_) { return ''; }
}

// ── Main translation ─────────────────────────────────────────────────
// translate(zip, manifest, { newCaseId }) →
//   { caseNumber, newId, snapshot, filePlan, modules, warnings, stats }
// snapshot mirrors case-snapshot.js buildSnapshot() output shape.
function translate(zip, manifest, opts) {
  opts = opts || {};
  const data = manifest.data || {};
  const pcase = data.case || {};
  const caseNumber = s(pcase.case_number || manifest.export_metadata.case_number);
  if (!caseNumber) throw new Error('PULSE manifest has no case number.');

  const newId = opts.newCaseId || (Date.now() + Math.floor(Math.random() * 1000));
  const warnings = [];
  const modules = new Set();          // module ids → drives tab visibility
  const moduleData = {};              // Pattern 2 (base → value), keyed by case.id
  const sharedData = {};              // Pattern 1 (viperCaseX → value), keyed by caseNumber
  let tasks = [];                     // viperTasks entries (flat, caseId=caseNumber)
  const filePlan = [];               // { zipPath, destRel } for the caller to extract

  // ---- File plan: losslessly mirror the PULSE files/ subtree ----------
  // PULSE keeps case files at casesPath/<caseNumber>/<subdir>/...; here they
  // ship under files/<subdir>/... We reproduce the same subtree under the
  // VIPER case folder so evidence/warrant/report references stay coherent.
  const inventory = toArr(manifest.file_inventory);
  for (const f of inventory) {
    if (!f || !f.path) continue;
    const rel = String(f.path).replace(/\\/g, '/').replace(/^\/+/, '');
    filePlan.push({ zipPath: 'files/' + rel, destRel: rel, size: f.size, checksum: f.checksum });
  }

  // ---- Case record (viperCases entry) ---------------------------------
  const createdAt = isoDate(pcase.created_at) || new Date().toISOString();
  const lastModified = isoDate(pcase.updated_at) || createdAt;
  const caseMetadata = {
    id: newId,
    caseNumber,
    synopsis: '',
    cybertipNumber: '',
    status: mapStatus(pcase.status),
    priority: 0,
    modules: [],                      // filled at end from `modules`
    tabOrder: ['overview'],           // filled at end
    createdAt,
    createdBy: s(data.exportedBy || manifest.export_metadata.exporting_officer || 'PULSE Import'),
    lastModified,
    // Provenance (harmless extras; also surfaced in the import banner)
    importedFromPulse: true,
    pulseCaseType: s(pcase.case_type),
    pulseVersion: s(manifest.export_metadata.pulse_version),
    importedAt: new Date().toISOString()
  };

  // ---- caseTypeData (cybertip / p2p / chat / other) -------------------
  const ctd = data.caseTypeData || {};
  const typeNotes = [];   // synthesized notes for types without a native VIPER module
  if (s(pcase.case_type) === 'cybertip') {
    caseMetadata.cybertipNumber = s(ctd.cybertip_number);
    modules.add('cyberTips');
    moduleData['cyberTips'] = [{
      id: newId,
      cyberTipNumber: s(ctd.cybertip_number),
      reportingCompany: s(ctd.reporting_company),
      priorityLevel: s(ctd.priority_level),
      reportDate: s(ctd.report_date),
      occurrenceDate: nz(ctd.occurrence_date),
      dateReceivedUtc: nz(ctd.date_received_utc),
      ncmecFolderPath: nz(ctd.ncmec_folder_path),
      identifiers: toArr(ctd.identifiers),
      files: toArr(ctd.files),
      importedFromPulse: true
    }];
  } else if (s(pcase.case_type) === 'p2p') {
    const lines = [
      `Platform: ${s(ctd.platform)}`,
      `Download date: ${s(ctd.download_date)}`,
      `Suspect IP: ${s(ctd.suspect_ip)}`,
      `IP provider: ${s(ctd.ip_provider)}`,
      ctd.download_folder_path ? `Download folder: ${s(ctd.download_folder_path)}` : ''
    ].filter(Boolean);
    typeNotes.push({ title: 'P2P Investigation Details', body: lines.join('\n') });
  } else if (s(pcase.case_type) === 'chat') {
    const idents = toArr(ctd.identifiers);
    const lines = [
      `Platform: ${s(ctd.platform)}`,
      `Initial contact date: ${s(ctd.initial_contact_date)}`
    ];
    if (idents.length) {
      lines.push('Identifiers:');
      idents.forEach(i => lines.push('  • ' + JSON.stringify(i)));
    }
    typeNotes.push({ title: 'Chat Investigation Details', body: lines.join('\n') });
  } else if (ctd && Object.keys(ctd).length) {
    typeNotes.push({ title: 'Case Details', body: JSON.stringify(ctd, null, 2) });
  }

  // ---- Notes (viperCaseNotes, Pattern 1) ------------------------------
  const notes = [];
  toArr(data.notes).forEach(n => {
    notes.push({
      id: n.id || (Date.now() + Math.floor(Math.random() * 100000)),
      text: s(n.content != null ? n.content : (n.note != null ? n.note : n.text)),
      createdAt: isoDate(n.created_at) || createdAt,
      attachments: [],
      importedFromPulse: true
    });
  });
  // Synthesized type notes (p2p/chat/other)
  typeNotes.forEach(tn => {
    notes.push({
      id: Date.now() + Math.floor(Math.random() * 100000),
      text: `${tn.title}\n\n${tn.body}`,
      createdAt,
      attachments: [],
      importedFromPulse: true
    });
  });
  if (notes.length) { sharedData['viperCaseNotes'] = notes; modules.add('notes'); }

  // ---- Suspect (+ weapons, photos) → suspects_<id> (Pattern 2) --------
  const suspect = data.suspect;
  if (suspect && (suspect.first_name || suspect.last_name || suspect.name || suspect.address)) {
    const fullName = s(suspect.name) ||
      [s(suspect.first_name), s(suspect.last_name)].filter(Boolean).join(' ').trim();
    // Inline photos from files/suspect/{suspect_*,residence_*,vehicle_*}
    let photo = '', residencePhoto = '', vehiclePhoto = '';
    for (const f of inventory) {
      const rel = String(f.path || '').replace(/\\/g, '/');
      if (!rel.toLowerCase().startsWith('suspect/')) continue;
      const base = rel.split('/').pop().toLowerCase();
      const dataUrl = fileToDataUrl(zip, 'files/' + rel);
      if (!dataUrl) continue;
      if (base.startsWith('suspect_') && !photo) photo = dataUrl;
      else if (base.startsWith('residence_') && !residencePhoto) residencePhoto = dataUrl;
      else if (base.startsWith('vehicle_') && !vehiclePhoto) vehiclePhoto = dataUrl;
      else if (!photo) photo = dataUrl;
    }
    const weapons = toArr(data.weapons);
    const suspectObj = {
      id: suspect.id || newId,
      name: fullName,
      firstName: s(suspect.first_name),
      lastName: s(suspect.last_name),
      dob: s(suspect.dob),
      driversLicense: s(suspect.drivers_license),
      licensePlate: s(suspect.license_plate),
      address: s(suspect.address),
      height: s(suspect.height),
      weight: s(suspect.weight),
      hairColor: s(suspect.hair_color),
      eyeColor: s(suspect.eye_color),
      scarsMarksTattoos: s(suspect.scars_marks_tattoos),
      phone: s(suspect.phone),
      phoneCarrier: s(suspect.phone_carrier),
      phoneLineType: s(suspect.phone_line_type),
      workplace: s(suspect.workplace || suspect.place_of_work),
      criminalHistory: s(suspect.criminal_history),
      firearmsInfo: s(suspect.firearms_info),
      hasWeapons: !!(suspect.has_weapons) || weapons.length > 0,
      latitude: suspect.latitude != null ? suspect.latitude : '',
      longitude: suspect.longitude != null ? suspect.longitude : '',
      vehicle: {
        make: s(suspect.vehicle_make),
        model: s(suspect.vehicle_model),
        color: s(suspect.vehicle_color),
        photo: vehiclePhoto
      },
      weapons: weapons.map(w => ({
        id: w.id || (Date.now() + Math.floor(Math.random() * 100000)),
        type: s(w.type || w.weapon_type),
        make: s(w.make),
        model: s(w.model),
        caliber: s(w.caliber),
        serial: s(w.serial || w.serial_number),
        notes: s(w.notes || w.description)
      })),
      photo,
      residencePhoto,
      importedFromPulse: true
    };
    moduleData['suspects'] = [suspectObj];
    modules.add('suspects');
    if (weapons.length) modules.add('firearms');
  }

  // ---- Timeline events → timelineEvents_<id> (Pattern 2) --------------
  const timeline = toArr(data.timelineEvents).map(t => ({
    id: t.id || (Date.now() + Math.floor(Math.random() * 100000)),
    timestamp: isoDate(t.timestamp) || createdAt,
    endTimestamp: t.end_timestamp ? isoDate(t.end_timestamp) : null,
    title: s(t.title),
    description: s(t.description),
    lane: s(t.lane || 'incident'),
    category: s(t.category || 'custom'),
    significance: s(t.significance || 'minor'),
    entityLink: nz(t.entity_link),
    sourceType: s(t.source_type || 'import:pulse'),
    sourceId: s(t.source_id),
    createdAt: isoDate(t.created_at) || createdAt
  }));
  // Provenance event so the case history shows the import.
  timeline.push({
    id: Date.now() + Math.floor(Math.random() * 100000),
    timestamp: new Date().toISOString(),
    endTimestamp: null,
    title: 'Imported from PULSE',
    description: `Case imported from ICAC P.U.L.S.E. (v${s(manifest.export_metadata.pulse_version)}), ` +
                 `exported ${isoDate(manifest.export_metadata.export_date)} by ` +
                 `${s(manifest.export_metadata.exporting_officer)}.`,
    lane: 'incident',
    category: 'custom',
    significance: 'major',
    entityLink: null,
    sourceType: 'import:pulse',
    sourceId: String(newId),
    createdAt: new Date().toISOString()
  });
  if (timeline.length) moduleData['timelineEvents'] = timeline;

  // ---- Ops plan (+ entry team, other residents) → opsplan_<id> --------
  const opsPlan = data.opsPlan;
  const opsEntryTeam = toArr(data.opsEntryTeam);
  const opsOtherResidents = toArr(data.opsOtherResidents);
  if (opsPlan || opsEntryTeam.length || opsOtherResidents.length) {
    const op = opsPlan || {};
    moduleData['opsplan'] = {
      date: s(op.date), time: s(op.time),
      reportNumber: s(op.report_number),
      caseAgent: s(op.case_agent),
      operationType: s(op.operation_type),
      location: s(op.location),
      suspectInfo: s(op.suspect_info),
      caseSummary: s(op.case_summary),
      tacticalPlan: s(op.tactical_plan),
      contingencyPlan: s(op.contingency_plan),
      medicalPlan: s(op.medical_plan),
      hospitalName: s(op.hospital_name),
      rallyPoint: s(op.rally_point),
      briefingLocation: s(op.briefing_location),
      entryTeam: opsEntryTeam.map(m => ({
        name: s(m.name), role: s(m.role || m.assignment),
        badge: s(m.badge), phone: s(m.phone), notes: s(m.notes)
      })),
      otherResidents: opsOtherResidents.map(r => ({
        name: s(r.name), dob: s(r.dob),
        relationship: s(r.relationship), notes: s(r.notes)
      })),
      importedFromPulse: true
    };
    modules.add('opsplan');
  }

  // ---- Prosecution → prosecution_<id> + viperCaseProsecution ----------
  const pros = data.prosecution;
  if (pros && Object.keys(pros).length) {
    const prosObj = {
      courtCaseNumber: s(pros.court_case_number || pros.court_case),
      court: s(pros.court),
      daAssigned: s(pros.da_assigned || pros.prosecutor),
      daEmail: s(pros.da_email),
      daPhone: s(pros.da_phone),
      disposition: s(pros.disposition),
      sentenceNotes: s(pros.sentence_notes || pros.sentence),
      charges: toArr(pros.charges),
      courtDates: toArr(pros.court_dates),
      importedFromPulse: true
    };
    moduleData['prosecution'] = prosObj;
    sharedData['viperCaseProsecution'] = prosObj;
    modules.add('prosecution');
  }

  // ---- Probable cause → note ------------------------------------------
  if (data.probableCause && Object.keys(data.probableCause).length) {
    const pc = data.probableCause;
    const body = s(pc.statement || pc.text || pc.content) || JSON.stringify(pc, null, 2);
    const arr = sharedData['viperCaseNotes'] || [];
    arr.push({
      id: Date.now() + Math.floor(Math.random() * 100000),
      text: 'Probable Cause Statement\n\n' + body,
      createdAt, attachments: [], importedFromPulse: true
    });
    sharedData['viperCaseNotes'] = arr;
    modules.add('notes');
  }

  // ---- Evidence → viperCaseEvidence (Pattern 1) -----------------------
  const evidence = toArr(data.evidence).map(ev => {
    let files = [];
    try { files = ev.files_json ? JSON.parse(ev.files_json) : []; } catch (_) { files = []; }
    let meta = {};
    try { meta = ev.meta_json ? JSON.parse(ev.meta_json) : {}; } catch (_) { meta = {}; }
    return {
      id: ev.id || (Date.now() + Math.floor(Math.random() * 100000)),
      description: s(ev.description),
      type: s(ev.type),
      category: s(ev.category),
      tag: s(ev.tag),
      filePath: s(ev.file_path),
      storageMode: s(ev.storage_mode),
      fileCount: ev.file_count || files.length,
      totalSize: ev.total_size || 0,
      files,
      meta,
      createdAt: isoDate(ev.uploaded_at) || createdAt,
      importedFromPulse: true
    };
  });
  if (evidence.length) { sharedData['viperCaseEvidence'] = evidence; modules.add('evidence'); }

  // ---- Warrants → viperCaseWarrants (Pattern 1) -----------------------
  const warrants = toArr(data.warrants).map(w => ({
    id: w.id || ('w_' + (Date.now() + Math.floor(Math.random() * 100000))),
    type: s(w.type || w.warrant_type),
    issuedTo: s(w.issued_to || w.provider),
    referenceNumber: s(w.reference_number),
    description: s(w.description),
    dateSigned: s(w.date_signed || w.issue_date),
    dateServed: s(w.date_served),
    dueDate: s(w.due_date || w.return_date),
    judge: s(w.judge),
    courtReturnDate: s(w.court_return_date),
    returnReceived: !!w.return_received,
    createdAt: isoDate(w.created_at) || createdAt,
    importedFromPulse: true
  }));
  if (warrants.length) { sharedData['viperCaseWarrants'] = warrants; modules.add('warrants'); }

  // ---- CDR records → analytics module (kept as raw for now) -----------
  const cdr = toArr(data.cdrRecords);
  if (cdr.length) { moduleData['cdrRecords'] = cdr; modules.add('analytics'); }

  // ---- Reports → rmsImports_<id> (best-effort) ------------------------
  if (data.report && Object.keys(data.report).length) {
    const r = data.report;
    moduleData['rmsImports'] = [{
      id: 'rms_' + newId,
      reportNumber: s(r.report_number),
      reportType: s(r.report_type || 'Incident'),
      reportDate: s(r.report_date),
      narrative: s(r.narrative || r.content || r.body),
      importedAt: new Date().toISOString(),
      importedFromPulse: true
    }];
    modules.add('rmsImport');
  }

  // ---- To-dos → viperTasks (flat, caseId = caseNumber) ----------------
  tasks = toArr(data.todos).map(t => ({
    id: t.id || (Date.now() + Math.floor(Math.random() * 100000)),
    title: s(t.title || t.text || t.task),
    date: s(t.due_date || t.date),
    time: s(t.time),
    priority: s(t.priority || 'medium'),
    notes: s(t.notes || t.description),
    caseId: caseNumber,            // NOTE: VIPER ties tasks by caseNumber string
    hasFile: false,
    fileName: null,
    completed: !!(t.completed || t.done),
    createdAt: isoDate(t.created_at) || createdAt,
    completedAt: t.completed_at ? isoDate(t.completed_at) : null
  }));

  // ---- Aperture emails / notes → file plan + apertureFlags ------------
  // The aperture module reads cases/<caseNumber>/aperture/*.json from disk.
  // Emit those files via the plan so the module picks them up.
  const apEmails = toArr(data.apertureEmails);
  const apNotes = toArr(data.apertureNotes);
  if (apEmails.length || apNotes.length) {
    modules.add('aperture');
    filePlan.push({
      inlineJson: apEmails,
      destRel: 'aperture/emails.json'
    });
    if (apNotes.length) {
      filePlan.push({
        inlineJson: { notes: apNotes },
        destRel: 'aperture/metadata.json'
      });
    }
  }

  // ---- PULSE audit log → kept as read-only history on the case --------
  const auditLog = toArr(data.auditLog);
  if (auditLog.length) {
    caseMetadata.pulseImportAudit = auditLog.map(a => ({
      seq: a.seq, eventType: s(a.event_type), eventData: s(a.event_data),
      hash: s(a.hash), prevHash: s(a.prev_hash),
      timestamp: isoDate(a.timestamp), user: s(a.user), host: s(a.host),
      appVersion: s(a.app_version)
    }));
  }

  // ---- Warrant-return imports/flags: preserved raw for P2 fidelity ----
  const wrImports = toArr(data.warrantReturnImports);
  const wrFlags = toArr(data.warrantReturnFlags);
  if (wrImports.length || wrFlags.length) {
    caseMetadata.pulseWarrantReturns = { imports: wrImports, flags: wrFlags };
    warnings.push('Warrant-return imports preserved raw (full provider reconstruction pending P2).');
  }

  // ---- Finalize modules / tabOrder ------------------------------------
  const moduleList = Array.from(modules);
  caseMetadata.modules = moduleList;
  caseMetadata.tabOrder = ['overview', ...moduleList];

  const snapshot = {
    _viperExport: true,
    _version: '1.0',
    _snapshot: true,
    _savedAt: new Date().toISOString(),
    _exportedBy: caseMetadata.createdBy,
    _importedFromPulse: true,
    caseMetadata,
    moduleData,
    sharedData,
    tasks
  };

  const stats = {
    notes: notes.length,
    suspects: moduleData['suspects'] ? 1 : 0,
    evidence: evidence.length,
    warrants: warrants.length,
    timeline: timeline.length,
    tasks: tasks.length,
    files: filePlan.filter(f => f.zipPath).length,
    auditEntries: auditLog.length
  };

  return { caseNumber, newId, snapshot, filePlan, modules: moduleList, warnings, stats };
}

module.exports = { decryptPulse, openPulse, translate, isoDate, mapStatus };
