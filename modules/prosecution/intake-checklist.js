/**
 * modules/prosecution/intake-checklist.js — the Intake / Discovery Checklist
 * that goes with a case to the prosecutor.
 *
 * Optional and per case: it exists only once someone clicks "Add Intake
 * Checklist" on the case's Prosecution tab, and lives inside the case's
 * prosecution record as `intakeChecklist`:
 *
 *   { version: 1, createdAt, updatedAt,
 *     header:   { defendants, agency, agencyCaseNumber, assistingAgencies, caseNumbers },
 *     checks:   { <checkItemId>: true },
 *     statuses: { <statusItemId>: { status: 'na'|'in_file'|'requested'|'other', detail } },
 *     notes:    '',
 *     lastExport: { fileName, destination, at } | null }
 *
 * The wording is deliberately generic (no state rules cited, no agency named);
 * the agency comes from the officer's Settings profile.
 *
 * Loads in the renderer (window.ViperIntakeChecklist) and under node (tests,
 * the PDF builder in the main process).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root && root.document) root.ViperIntakeChecklist = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const VERSION = 1;
    const TITLE = 'Intake / Discovery Checklist';

    // Header lines across the top of the form.
    const HEADER_FIELDS = Object.freeze([
        { id: 'defendants', label: 'Defendant(s)', hint: 'Last, First — separate several with ;', max: 400 },
        { id: 'agency', label: 'Agency', hint: 'From Settings → agency profile', max: 160 },
        { id: 'agencyCaseNumber', label: 'Agency case number', hint: '', max: 120 },
        { id: 'assistingAgencies', label: 'Assisting agency', hint: '', max: 300 },
        { id: 'caseNumbers', label: 'Court case number(s)', hint: '', max: 200 },
    ]);

    // kind 'check'  → a tick box (sent / not sent)
    // kind 'status' → N/A | In File | Requested | Other
    const SECTIONS = Object.freeze([
        { id: 'general', title: 'General Requirements', kind: 'check', items: [
            { id: 'witnessList', label: 'Witness list, including parent/guardian information, DOBs, and addresses' },
            { id: 'caseSummary', label: 'Prosecution report / case summary' },
            { id: 'criminalHistory', label: 'NCIC / state criminal history' },
            { id: 'arrestAffidavit', label: 'Affidavit in support of warrantless arrest or arrest warrant' },
            { id: 'confirmatoryId', label: 'Confirmatory ID' },
        ] },
        { id: 'reportsVideo', title: 'Police Reports and Video', kind: 'check', items: [
            { id: 'bodyCamUploaded', label: 'Body-worn camera footage uploaded' },
            { id: 'reportsShared', label: 'Reports electronically shared' },
        ] },
        { id: 'interview', title: 'Interview', kind: 'status', items: [
            { id: 'victimInterview', label: 'Victim interview(s)' },
            { id: 'defendantInterview', label: 'Defendant interview' },
            { id: 'codefInterview', label: 'Co-defendant interview(s)' },
            { id: 'forensicInterview', label: 'Forensic interview(s)' },
            { id: 'writtenStatements', label: 'Written statement(s)' },
            { id: 'mirandaWaivers', label: 'Miranda waiver(s)' },
        ] },
        { id: 'misc', title: 'Miscellaneous', kind: 'status', items: [
            { id: 'proofOfValue', label: 'Proof of value (theft, criminal mischief, etc.)' },
            { id: 'courtOrders', label: 'Court orders' },
            { id: 'searchWarrants', label: 'Search warrants' },
            { id: 'priorConvictions', label: 'Prior convictions' },
        ] },
        { id: 'otherLe', title: 'Other Law Enforcement', kind: 'status', items: [
            { id: 'originalTheftReport', label: 'Original report of theft' },
            { id: 'assistingAgencyReports', label: 'Assisting agency reports and electronic discovery' },
            { id: 'priorReports', label: 'Prior reports / calls for service' },
        ] },
        { id: 'digital', title: 'Digital Evidence', kind: 'status', items: [
            { id: 'photos', label: 'Photos' },
            { id: 'surveillanceVideo', label: 'Surveillance video' },
            { id: 'call911', label: '911 call' },
            { id: 'cadReport', label: 'CAD report' },
            { id: 'radioTraffic', label: 'Radio traffic' },
            { id: 'otherDigital', label: 'Other digital evidence (phone extractions, CDRs, etc.)' },
        ] },
        { id: 'medical', title: 'Medical Records', kind: 'status', items: [
            { id: 'medicalReleases', label: 'Medical release(s)' },
            { id: 'sbiForms', label: 'SBI form(s)' },
            { id: 'medicalRecords', label: 'Medical records' },
            { id: 'saneReport', label: 'FNE / SANE report and photos' },
        ] },
        { id: 'expert', title: 'Expert / Scientific Reports', kind: 'status', items: [
            { id: 'csiReports', label: 'Crime scene / CSI reports' },
            { id: 'bloodBreath', label: 'Blood / breath test' },
            { id: 'drugTests', label: 'Drug test results' },
            { id: 'otherForensic', label: 'Other forensic tests (DNA, firearms, fingerprints, etc.)' },
        ] },
    ].map(s => Object.freeze(Object.assign({}, s, { items: Object.freeze(s.items.map(i => Object.freeze(i))) }))));

    const STATUSES = Object.freeze([
        { id: 'na', label: 'N/A' },
        { id: 'in_file', label: 'In File' },
        { id: 'requested', label: 'Requested' },
        { id: 'other', label: 'Other' },
    ]);
    const STATUS_IDS = new Set(STATUSES.map(s => s.id));

    // Generic on purpose — no jurisdiction's rules are cited.
    const DISCOVERY_NOTE = 'Discovery is ongoing. The prosecution\'s disclosure obligations reach everything in the '
        + 'possession or control of the investigating agency, including any information that tends to negate '
        + 'guilt, reduce punishment, or impeach a witness. Provide all discovery to the prosecutor as soon as it '
        + 'is in the agency\'s possession, and forward anything new, including material obtained after charges '
        + 'are filed, without waiting to be asked.';

    const LIMITS = Object.freeze({ detail: 300, notes: 8000 });

    const CHECK_IDS = new Set();
    const STATUS_ITEM_IDS = new Set();
    for (const s of SECTIONS) for (const i of s.items) (s.kind === 'check' ? CHECK_IDS : STATUS_ITEM_IDS).add(i.id);

    const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const clip = (v, n) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, n);
    const oneLine = (v, n) => clip(v, n * 2).replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, n);
    const isoOr = (v, d) => (typeof v === 'string' && !isNaN(Date.parse(v)) ? v : d);

    function statusLabel(id) {
        const s = STATUSES.find(x => x.id === id);
        return s ? s.label : '';
    }

    /** A clean checklist from whatever was stored (unknown keys dropped, text capped). */
    function normalize(raw, now) {
        const r = isObj(raw) ? raw : {};
        const stamp = (now instanceof Date ? now : new Date()).toISOString();
        const header = {};
        const h = isObj(r.header) ? r.header : {};
        for (const f of HEADER_FIELDS) header[f.id] = oneLine(h[f.id], f.max);
        const checks = {};
        if (isObj(r.checks)) for (const id of CHECK_IDS) if (r.checks[id] === true) checks[id] = true;
        const statuses = {};
        if (isObj(r.statuses)) {
            for (const id of STATUS_ITEM_IDS) {
                const v = r.statuses[id];
                if (!isObj(v) || !STATUS_IDS.has(v.status)) continue;
                const entry = { status: v.status };
                const detail = oneLine(v.detail, LIMITS.detail);
                if (detail) entry.detail = detail;
                statuses[id] = entry;
            }
        }
        let lastExport = null;
        if (isObj(r.lastExport) && typeof r.lastExport.fileName === 'string' && r.lastExport.fileName) {
            lastExport = {
                fileName: oneLine(r.lastExport.fileName, 255),
                destination: r.lastExport.destination === 'export' ? 'export' : 'case',
                at: isoOr(r.lastExport.at, stamp),
            };
        }
        return {
            version: VERSION,
            createdAt: isoOr(r.createdAt, stamp),
            updatedAt: isoOr(r.updatedAt, stamp),
            header,
            checks,
            statuses,
            notes: clip(r.notes, LIMITS.notes),
            lastExport,
        };
    }

    /** A new checklist; prefill { defendants, agency, agencyCaseNumber, ... }. */
    function create(prefill, now) {
        const p = isObj(prefill) ? prefill : {};
        const header = {};
        for (const f of HEADER_FIELDS) header[f.id] = p[f.id];
        return normalize({ header }, now);
    }

    /** "Last, First" for each suspect record (records as stored on the case). */
    function defendantNames(suspects) {
        const out = [];
        for (const s of Array.isArray(suspects) ? suspects : []) {
            if (!isObj(s)) continue;
            let first = oneLine(s.firstName, 80), last = oneLine(s.lastName, 80);
            if (!first && !last) {
                const full = oneLine(s.name, 160);
                if (!full) continue;
                if (full.includes(',')) { out.push(full); continue; }
                const parts = full.split(' ');
                last = parts.length > 1 ? parts.pop() : full;
                first = parts.length ? parts.join(' ') : '';
                if (first === last) first = '';
            }
            out.push(last && first ? `${last}, ${first}` : (last || first));
        }
        return [...new Set(out)].join('; ');
    }

    /** First defendant's last name, for the file name. */
    function nameHint(cl) {
        const d = cl && cl.header ? String(cl.header.defendants || '') : '';
        const first = d.split(';')[0].trim();
        return first.split(',')[0].trim().slice(0, 40);
    }

    /**
     * Where the checklist stands.
     * done: ticked, or N/A / In File / Other.  requested: waiting on someone.
     * open: nothing chosen yet.
     */
    function progress(cl) {
        const c = cl || {};
        let total = 0, done = 0, requested = 0;
        for (const s of SECTIONS) {
            for (const i of s.items) {
                total++;
                if (s.kind === 'check') { if (c.checks && c.checks[i.id] === true) done++; continue; }
                const st = c.statuses && c.statuses[i.id] && c.statuses[i.id].status;
                if (st === 'requested') requested++;
                else if (STATUS_IDS.has(st)) done++;
            }
        }
        return { total, done, requested, open: total - done - requested };
    }

    /** Items still marked Requested, with their section titles (for reminders). */
    function outstanding(cl) {
        const out = [];
        for (const s of SECTIONS) {
            if (s.kind !== 'status') continue;
            for (const i of s.items) {
                const v = cl && cl.statuses && cl.statuses[i.id];
                if (v && v.status === 'requested') out.push({ section: s.title, id: i.id, label: i.label, detail: v.detail || '' });
            }
        }
        return out;
    }

    // Immutable edits — each returns a new checklist with updatedAt bumped.
    function touch(cl, mutate, now) {
        const next = normalize(cl, now);
        mutate(next);
        next.updatedAt = (now instanceof Date ? now : new Date()).toISOString();
        return normalize(next, now);
    }
    function setHeader(cl, field, value, now) {
        if (!HEADER_FIELDS.some(f => f.id === field)) return normalize(cl, now);
        return touch(cl, n => { n.header[field] = value; }, now);
    }
    function setCheck(cl, id, on, now) {
        if (!CHECK_IDS.has(id)) return normalize(cl, now);
        return touch(cl, n => { if (on) n.checks[id] = true; else delete n.checks[id]; }, now);
    }
    function setStatus(cl, id, status, now) {
        if (!STATUS_ITEM_IDS.has(id)) return normalize(cl, now);
        return touch(cl, n => {
            if (!STATUS_IDS.has(status)) { delete n.statuses[id]; return; }
            const prev = n.statuses[id] || {};
            n.statuses[id] = { status, detail: prev.detail || '' };
        }, now);
    }
    function setDetail(cl, id, detail, now) {
        if (!STATUS_ITEM_IDS.has(id)) return normalize(cl, now);
        return touch(cl, n => {
            const prev = n.statuses[id];
            n.statuses[id] = { status: prev ? prev.status : 'other', detail };
        }, now);
    }
    function setNotes(cl, notes, now) { return touch(cl, n => { n.notes = notes; }, now); }
    function setLastExport(cl, info, now) {
        return touch(cl, n => {
            n.lastExport = { fileName: info && info.fileName, destination: info && info.destination, at: (now instanceof Date ? now : new Date()).toISOString() };
        }, now);
    }

    return {
        VERSION, TITLE, HEADER_FIELDS, SECTIONS, STATUSES, DISCOVERY_NOTE, LIMITS,
        statusLabel, normalize, create, defendantNames, nameHint, progress, outstanding,
        setHeader, setCheck, setStatus, setDetail, setNotes, setLastExport,
    };
}));
