/*
 * Field Work — desktop tab tests.
 *
 * Run: node modules\field-work\__tests__\field-work-ui.test.js
 * (pure module + a hand-rolled DOM stub; no native deps, no Electron)
 *
 * WHY THIS EXISTS
 *
 * The tab itself is markup and can be looked at. These tests cover the
 * parts that are NOT visible, and every one of them is here because it
 * either went wrong during the build or would be silent if it did:
 *
 *   - A form record holds `mediaKey`, and that key is the ONLY copy on
 *     this machine of the thing that can decrypt what the officer's phone
 *     uploaded (the other copy is in the URL fragment on the phone).
 *     Deleting the record is irreversible data loss. The first draft
 *     deleted it on ANY failure of the count refresh — including "the
 *     laptop has no signal", which is the normal state of a car. The
 *     relay now reports `gone` separately from `success`, and only `gone`
 *     may delete.
 *
 *   - `discoverable` is read by the DA export. The first draft had the
 *     flag plumbed end to end and NO control to set it, so the officer
 *     had a withholding mechanism they could not operate.
 *
 *   - The Connection Board renders image/video/audio and dispatches on
 *     `fieldWorkFile`. Field Work's own vocabulary is
 *     photo/video/audio/document. Handing a 'photo' over untranslated
 *     falls through the board's if/else chain and renders a photograph as
 *     an <audio> control.
 *
 *   - File names are the only identity a field work attachment has — the
 *     module addresses them by NAME, not path, because the main process
 *     owns the folder. Two files that generate the same name collide.
 */
const path = require('path');

/* ── A DOM small enough to read ──────────────────────────────────────── *
 * Only what the module actually touches. Deliberately NOT jsdom: the
 * point is that a reader can see exactly what is being faked.
 */
function fakeEl(id) {
    return {
        id: id || '',
        innerHTML: '',
        value: '',
        disabled: false,
        textContent: '',
        querySelectorAll: () => [],
        querySelector: () => null
    };
}
const DOM = { byId: {} };
globalThis.document = {
    getElementById: (id) => DOM.byId[id] || null,
    querySelectorAll: () => [],
    querySelector: () => null,
    body: { insertAdjacentHTML: () => {} },
    createElement: () => fakeEl()
};
const STORE = {};
globalThis.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(STORE, k) ? STORE[k] : null),
    setItem: (k, v) => { STORE[k] = String(v); },
    removeItem: (k) => { delete STORE[k]; }
};
globalThis.window = globalThis;

const S = require(path.join(__dirname, '..', 'field-work-schema.js'));
const UI = require(path.join(__dirname, '..', 'field-work-ui.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};
const flush = () => new Promise(r => setTimeout(r, 0));

/* ── Host double ─────────────────────────────────────────────────────── */
const CID = 'case-abc';
const CNUM = '26-0001';
const H = {
    toasts: [], audits: [], evidence: [], boardSyncs: 0, rerenders: 0,
    confirmAnswer: true, confirmPrompts: []
};
function wireHost(extra) {
    UI.configure(Object.assign({
        getCaseId: () => CID,
        getCaseNumber: () => CNUM,
        getCaseRef: () => CNUM,
        toast: (m, k) => H.toasts.push((k || 'info') + ': ' + m),
        confirm: (m) => { H.confirmPrompts.push(m); return Promise.resolve(H.confirmAnswer); },
        rerender: () => { H.rerenders++; },
        addEvidence: (r) => { H.evidence.push(r); return r.id; },
        syncBoard: () => { H.boardSyncs++; return true; },
        audit: (e, d) => { H.audits.push({ e, d }); }
    }, extra || {}));
}

function seed(entries, forms) {
    STORE['fieldwork_' + CID] = JSON.stringify(entries || []);
    STORE['fieldworkForms_' + CID] = JSON.stringify(forms || []);
    wireHost();
    // configure() only resets when the case id changes, because the host
    // calls it on every tab render and wiping state each time made the
    // detail view unreachable. In the app a fresh page load is what gets
    // you a fresh read; this suite reseeds the same case over and over, so
    // it has to invalidate the marker itself.
    UI._setState({ loadedFor: null });
}

/* ====================================================================== *
 * the module loads the way the renderer needs it to
 * ====================================================================== */
console.log('\n[the module loads]');

ok('module.exports carries the API', typeof UI.renderTab === 'function');
ok('the global is assigned too, not just module.exports',
    globalThis.FieldWorkUI === UI);
ok('  — which is the UMD trap: `module` is defined in VIPER\'s renderer',
    typeof module === 'object' && !!module.exports);
ok('the schema resolved', typeof S.makeEntry === 'function');

/* ====================================================================== *
 * file names
 *
 * The module addresses attachments by NAME. The main process owns the
 * folder and refuses to overwrite (exclusive create), so two files that
 * generate the same name do not silently replace each other — but one of
 * them fails to save, which is just as bad for the officer. And a
 * document whose extension is lost will not open for anybody.
 * ====================================================================== */
console.log('\n[file names]');

const D = '2026-10-05T14:22:00Z';
ok('a photo is numbered, dated and labelled',
    UI.fileNameFor({ kind: 'photo', mime: 'image/jpeg', label: '3200 Las Vegas Trl', index: 2, date: D })
    === 'Field Work 2026-10-05 3200-Las-Vegas-Trl photo 2.jpg');
ok('two photos in the same entry do not collide',
    UI.fileNameFor({ kind: 'photo', mime: 'image/jpeg', label: 'x', index: 1, date: D })
    !== UI.fileNameFor({ kind: 'photo', mime: 'image/jpeg', label: 'x', index: 2, date: D }));

const docName = UI.fileNameFor({
    kind: 'document', mime: 'application/pdf', label: 'Interview of J Doe',
    originalName: 'Signed Statement.pdf', index: 1, date: D
});
ok('a document keeps the stem the officer recognises', docName.indexOf('Signed-Statement') !== -1, docName);
ok('a document is NOT numbered — its own name is the identity',
    /Signed-Statement\.pdf$/.test(docName), docName);
ok('  — because "document 1.pdf" tells a DA nothing',
    docName.indexOf('document 1') === -1);

ok('a document extension comes from its own file name, not the mime',
    /\.docx$/.test(UI.fileNameFor({
        kind: 'document', mime: 'application/octet-stream',
        label: 'x', originalName: 'Statement.docx', index: 1, date: D
    })));
ok('  — which matters because a phone sends octet-stream for real types',
    /\.bin$/.test(UI.fileNameFor({
        kind: 'document', mime: 'application/octet-stream',
        label: 'x', originalName: 'noextension', index: 1, date: D
    })));

ok('two documents with the SAME original name still collide — by design, the writer refuses',
    UI.fileNameFor({ kind: 'document', mime: 'application/pdf', label: 'x', originalName: 'a.pdf', index: 1, date: D })
    === UI.fileNameFor({ kind: 'document', mime: 'application/pdf', label: 'x', originalName: 'a.pdf', index: 2, date: D }));

ok('a nameless document does not become the literal word "entry"',
    UI.fileNameFor({ kind: 'document', mime: 'application/pdf', label: 'Scene', originalName: '', index: 3, date: D })
        .indexOf('document-3') !== -1);

ok('an unlabelled entry still produces a usable name',
    UI.fileNameFor({ kind: 'audio', mime: 'audio/webm', label: '', index: 1, date: D })
    === 'Field Work 2026-10-05 entry audio 1.weba');
ok('  — and audio/webm maps to .weba, the same as Area Canvas does',
    UI.fileNameFor({ kind: 'audio', mime: 'audio/webm', label: 'x', index: 1, date: D }).slice(-5) === '.weba');
ok('  — while video/webm stays .webm; the two must not be confused',
    UI.fileNameFor({ kind: 'video', mime: 'video/webm', label: 'x', index: 1, date: D }).slice(-5) === '.webm');
ok('a bad date falls back to today rather than "Invalid Date"',
    /^Field Work \d{4}-\d{2}-\d{2} /.test(
        UI.fileNameFor({ kind: 'photo', mime: 'image/jpeg', label: 'x', index: 1, date: 'not-a-date' })));
ok('a path separator in the label cannot escape the folder',
    UI.fileNameFor({ kind: 'photo', mime: 'image/jpeg', label: '../../etc', index: 1, date: D })
        .indexOf('/') === -1);

/* ====================================================================== *
 * Discovery Status
 *
 * The flag the DA export reads. It was plumbed before it was settable.
 * ====================================================================== */
console.log('\n[discovery status]');

function twoFileEntry() {
    return S.makeEntry({
        id: 'e1', preset: 'interview', timestamp: D,
        fields: { location: { street: '1100 Commerce St', city: 'Fort Worth', state: 'TX' }, notes: 'n' },
        media: [
            { fileName: 'a.jpg', kind: 'photo', mime: 'image/jpeg', bytes: 10, discoverable: true },
            { fileName: 'b.pdf', kind: 'document', mime: 'application/pdf', bytes: 20, discoverable: true }
        ]
    });
}

seed([twoFileEntry()]);
UI.renderTab();
ok('everything is discoverable until somebody says otherwise',
    UI.nonDiscoverableFileNames(CID).length === 0);

H.audits = [];
UI.toggleDiscoverable(0, 1);
ok('toggling withholds the file', UI.nonDiscoverableFileNames(CID).join() === 'b.pdf');
ok('the change is written to the store, not just the screen',
    JSON.parse(STORE['fieldwork_' + CID])[0].media[1].discoverable === false);
ok('withholding a file is audited', H.audits.some(a => a.e === 'fieldwork_discovery_status_changed'));
ok('the audit names the file', H.audits.some(a => a.d && a.d.fileName === 'b.pdf'));

UI.toggleDiscoverable(0, 1);
ok('toggling back hands it over again', UI.nonDiscoverableFileNames(CID).length === 0);

UI.toggleDiscoverable(0, 99);
ok('a bad index is a no-op, not a crash', UI.nonDiscoverableFileNames(CID).length === 0);

ok('nonDiscoverableFileNames accepts a case id and reads the STORE',
    (() => { UI.toggleDiscoverable(0, 0); UI.reset(); wireHost();
        return UI.nonDiscoverableFileNames(CID).join() === 'a.jpg'; })());
ok('  — because an export can run without the tab ever being opened',
    UI._state().entries.length === 0);
ok('nonDiscoverableFileNames also accepts a plain list',
    UI.nonDiscoverableFileNames(JSON.parse(STORE['fieldwork_' + CID])).join() === 'a.jpg');
ok('nonDiscoverableFileNames of nothing is an empty list, not a throw',
    UI.nonDiscoverableFileNames().length === 0);
ok('an unknown case id yields nothing rather than the open case',
    UI.nonDiscoverableFileNames('case-does-not-exist').length === 0);

/* ====================================================================== *
 * the Connection Board contract
 * ====================================================================== */
console.log('\n[connection board]');

function boardFixture() {
    return [
        S.makeEntry({
            id: 'e1', preset: 'surveillance', timestamp: D,
            fields: {
                location: { street: '3200 Las Vegas Trl', city: 'Fort Worth', state: 'TX', zip: '76116' },
                subject: 'Silver Altima', followUp: true, notes: 'Arrived 1422.'
            },
            media: [
                { fileName: 'p.jpg', kind: 'photo', mime: 'image/jpeg', bytes: 1 },
                { fileName: 'v.mp4', kind: 'video', mime: 'video/mp4', bytes: 2, evidenceTag: 'Surv 10-05' },
                { fileName: 'd.pdf', kind: 'document', mime: 'application/pdf', bytes: 3 }
            ]
        }),
        // No address — nothing to geocode, so nothing to pin.
        S.makeEntry({ id: 'e2', preset: 'custom', timestamp: D, fields: { notes: 'Phone call.' } })
    ];
}
seed(boardFixture());

const pins = UI.boardPins(CID, CNUM);
ok('only entries with an address are pinned', pins.length === 1, pins.length);
ok('  — an entry with no location is kept in the tab, just off the map',
    UI.entryCount(CID) === 2);
ok('the pin carries the board\'s own type vocabulary', pins[0].type === 'location');
ok('the pin is keyed on the entry id so it can be reconciled later',
    pins[0].sourceType === 'auto:fieldwork' && pins[0].sourceId === 'e1');
ok('the pin carries the address string the board geocodes',
    pins[0].address.indexOf('3200 Las Vegas Trl') === 0);
ok('the label says what kind of work it was', pins[0].label.indexOf('Surveillance') === 0);
ok('a follow-up pin is coloured as one', pins[0].color === '#a855f7');

const pm = pins[0].data.media;
ok('a photo is translated to the board\'s "image"', pm[0].kind === 'image');
ok('  — because an untranslated "photo" renders as an <audio> control',
    pm.every(m => ['image', 'video', 'audio'].indexOf(m.kind) !== -1), pm.map(m => m.kind));
ok('a document is left off the board — there is no inline viewer for a PDF',
    pm.length === 2, pm.map(m => m.name));
ok('media is addressed by fieldWorkFile, not path',
    pm.every(m => m.fieldWorkFile && !m.path));
ok('  — which is the discriminator the board dispatches on, and NOT canvasFile',
    pm.every(m => m.canvasFile === undefined));
ok('every descriptor carries the case number it lives under',
    pm.every(m => m.caseNumber === CNUM));
ok('a preserved file says so, so the board can mark it',
    pm[1].preserved === true && pm[0].preserved === false);
ok('boardPins falls back to the host case number when none is passed',
    UI.boardPins(CID)[0].data.media[0].caseNumber === CNUM);

/* ====================================================================== *
 * the roll-ups the host reads
 * ====================================================================== */
console.log('\n[roll-ups]');

const st = UI.supervisorStats(CID);
ok('the supervisor roll-up counts entries, not pins', st.entries === 2);
ok('it counts follow-ups', st.followUp === 1);
ok('it counts every attachment, document included', st.attachments === 3);
ok('it counts what has been preserved as evidence', st.preservedAsEvidence === 1);
ok('the roll-up is integers only — no case content on the wire',
    Object.keys(st).every(k => typeof st[k] === 'number'));

const tl = UI.timelineEvents(CID);
ok('every entry reaches the timeline, address or not', tl.length === 2);
ok('timeline events are tagged so the host can link back to the tab',
    tl.every(e => e.sourceType === 'auto:fieldwork'));
ok('timeline ids are stable across renders',
    UI.timelineEvents(CID)[0].id === tl[0].id);
ok('a timeline date is a real date', tl.every(e => !isNaN(new Date(e.date).getTime())));

const rows = UI.exportRows(CID);
ok('every entry is exported', rows.length === 2);
ok('export rows are flat — the exporter never sees the entry schema',
    rows.every(r => Object.values(r).every(v => typeof v !== 'object')));
ok('the export says whether follow-up is outstanding', rows[0].followUp === 'Yes');
ok('the export counts attachments and how many went to evidence',
    rows[0].attachments === 3 && rows[0].preserved === 1);

ok('entryCount reads the store for a case that is not open',
    UI.entryCount('case-not-open') === 0);

/* ====================================================================== *
 * form records and the media key
 *
 * THE most destructive thing in this module. Read the header comment.
 * ====================================================================== */
console.log('\n[form records and the media key]');

function formFixture() {
    const now = Date.now();
    return [
        { formId: 'reachable', title: 'A', preset: 'surveillance', mediaKey: 'k1',
          formUrl: 'https://x/fieldwork/reachable#k=k1', qrDataUrl: '',
          createdAt: new Date(now - 3600e3).toISOString(),
          expiresAt: new Date(now + 40 * 3600e3).toISOString(),
          fields: ['location'], captures: [], entryCount: 0 },
        { formId: 'offline', title: 'B', preset: 'interview', mediaKey: 'k2',
          formUrl: 'https://x/fieldwork/offline#k=k2', qrDataUrl: '',
          createdAt: new Date(now - 3600e3).toISOString(),
          expiresAt: new Date(now + 40 * 3600e3).toISOString(),
          fields: ['location'], captures: [], entryCount: 0 },
        { formId: 'deleted', title: 'C', preset: 'custom', mediaKey: 'k3',
          formUrl: 'https://x/fieldwork/deleted#k=k3', qrDataUrl: '',
          createdAt: new Date(now - 3600e3).toISOString(),
          expiresAt: new Date(now + 40 * 3600e3).toISOString(),
          fields: ['location'], captures: [], entryCount: 0 }
    ];
}

function relayStub(answers) {
    globalThis.window.electronAPI = {
        fieldWorkFormCreate: () => Promise.resolve({}),
        fieldWorkFormGetInfo: ({ formId }) => Promise.resolve(answers[formId]),
        fieldWorkFormDelete: () => Promise.resolve({ success: true }),
        fieldWorkFormDownload: () => Promise.resolve({ success: true, entries: [] }),
        fieldWorkFetchMedia: () => Promise.resolve({ success: false }),
        fieldWorkReadMedia: () => Promise.resolve({ success: false }),
        fieldWorkSaveMedia: () => Promise.resolve({ success: true }),
        fieldWorkDeleteMedia: () => Promise.resolve({ success: true }),
        fieldWorkMediaToEvidence: () => Promise.resolve({ success: true, files: [] })
    };
}

(async function run() {
    DOM.byId.fieldWorkFormsSection = fakeEl('fieldWorkFormsSection');

    relayStub({
        reachable: { success: true, gone: false, entry_count: 4 },
        offline:   { success: false, gone: false, error: 'Request timeout' },
        deleted:   { success: false, gone: true, error: 'Form not found' }
    });
    seed([], formFixture());
    wireHost({ apiCall: (fn) => fn('APIKEY') });

    UI.renderTab();
    UI.afterRender();
    await flush(); await flush(); await flush(); await flush();

    const kept = JSON.parse(STORE['fieldworkForms_' + CID]).map(f => f.formId);
    ok('a form the relay answered for is kept', kept.indexOf('reachable') !== -1, kept);
    ok('its live count is taken from the relay, not from memory',
        UI._state().forms.filter(f => f.formId === 'reachable')[0].entryCount === 4);

    ok('AN UNREACHABLE RELAY DOES NOT DELETE THE FORM', kept.indexOf('offline') !== -1, kept);
    ok('  — because the record holds the only copy of the decryption key',
        (JSON.parse(STORE['fieldworkForms_' + CID]).filter(f => f.formId === 'offline')[0] || {}).mediaKey === 'k2');
    ok('  — and the card admits the count is unconfirmed rather than showing a confident 0',
        UI._state().forms.filter(f => f.formId === 'offline')[0]._unreachable === true);

    ok('a form the relay says is GONE is dropped', kept.indexOf('deleted') === -1, kept);
    ok('  — only "gone" deletes; every other failure waits', kept.length === 2);

    /* ---- a form with attachments still parked against it ---- */
    const parked = S.makeEntry({
        id: 'p1', preset: 'surveillance', timestamp: D,
        fields: { location: { street: '1 Main St', city: 'FW', state: 'TX' } }
    });
    parked.relayFormId = 'deleted';
    parked.relayPending = [{ mediaId: 7, kind: 'photo', mime: 'image/jpeg' }];
    seed([parked], formFixture());
    wireHost({ apiCall: (fn) => fn('APIKEY') });

    UI.renderTab();
    UI.afterRender();
    await flush(); await flush(); await flush(); await flush();

    const kept2 = JSON.parse(STORE['fieldworkForms_' + CID]).map(f => f.formId);
    ok('a GONE form is still kept while attachments are parked against it',
        kept2.indexOf('deleted') !== -1, kept2);
    ok('  — dropping it would strand a file the entry says exists',
        UI._state().entries[0].relayPending.length === 1);

    /* ---- closing a form deliberately ---- */
    H.confirmPrompts = []; H.audits = []; H.confirmAnswer = true;
    UI.closeForm('deleted');
    await flush(); await flush(); await flush();

    ok('closing a form names the attachments it abandons',
        H.confirmPrompts.join().indexOf('1 attachment(s)') !== -1, H.confirmPrompts);
    ok('  — stated plainly, because the key dies with the form',
        /cannot be undone/i.test(H.confirmPrompts.join()));
    ok('the form record is gone after a confirmed close',
        JSON.parse(STORE['fieldworkForms_' + CID]).map(f => f.formId).indexOf('deleted') === -1);
    ok('the entry stops offering a retry that can no longer succeed',
        JSON.parse(STORE['fieldwork_' + CID])[0].relayPending === undefined);
    ok('closing a form is audited with the count it abandoned',
        H.audits.some(a => a.e === 'fieldwork_form_closed' && a.d.abandonedAttachments === 1), H.audits);

    H.confirmAnswer = false;
    const before = JSON.parse(STORE['fieldworkForms_' + CID]).length;
    UI.closeForm('reachable');
    await flush(); await flush();
    ok('declining the confirm leaves the form alone',
        JSON.parse(STORE['fieldworkForms_' + CID]).length === before);

    /* ---- deleting an entry ---- */
    H.confirmAnswer = true; H.audits = [];
    seed([twoFileEntry()]);
    UI.renderTab();
    UI.deleteEntry(0);
    await flush(); await flush(); await flush();
    ok('deleting an entry removes it from the store',
        JSON.parse(STORE['fieldwork_' + CID]).length === 0);
    ok('deleting an entry is audited with what went with it',
        H.audits.some(a => a.e === 'fieldwork_entry_deleted' && a.d.filesDeleted === 2), H.audits);

    /* ---- a case switch must not leak the previous case's data ---- */
    seed([twoFileEntry()]);
    UI.renderTab();
    ok('the open case has entries', UI._state().entries.length === 1);
    UI.configure({ getCaseId: () => 'other-case' });
    ok('configure() clears what belonged to the old case', UI._state().entries.length === 0);
    wireHost();
    UI.renderTab();
    ok('  — and the old case\'s data is still on disk, not destroyed',
        JSON.parse(STORE['fieldwork_' + CID]).length === 1);

    /* ---- the detail view has to survive the repaint that opens it ---- */
    console.log('\n[opening an entry]');
    // The reported case: a surveillance entry carrying BOTH an identity
    // field and notes. summaryLine prefers the vehicle, so the card shows
    // that and the notes exist only in the detail view.
    seed([S.makeEntry({
        id: 'e-open', preset: 'surveillance', timestamp: D,
        fields: {
            location: { street: '17005 Upland Ave', city: 'Fontana', state: 'CA', zip: '92336' },
            vehicle: 'Black Toyota 4Runner',
            notes: 'Watched the driveway for two hours.'
        }
    })]);
    const listed = UI.renderTab();
    ok('the card shows the identity field, not the notes',
        listed.indexOf('Black Toyota 4Runner') !== -1 &&
        listed.indexOf('Watched the driveway') === -1);
    UI.openEntry(0);
    // What the host actually does on rerender: configure() first, THEN
    // renderTab(). An unconditional reset inside configure() wiped
    // viewIndex here, so the click appeared to do nothing at all and the
    // notes — which only the detail view renders — were unreachable.
    wireHost();
    const detail = UI.renderTab();
    ok('clicking an entry opens the detail view',
        detail.indexOf('All field work') !== -1);
    ok('  — configure() on every repaint must not throw viewIndex away',
        UI._state().viewIndex === 0, UI._state().viewIndex);
    ok('THE DETAIL VIEW SHOWS THE NOTES THE CARD HAS NO ROOM FOR',
        detail.indexOf('Watched the driveway for two hours.') !== -1);
    ok('  — once, not also repeated as a field row',
        detail.split('Watched the driveway').length - 1 === 1);
    UI.backToList();
    wireHost();
    ok('going back returns to the list',
        UI.renderTab().indexOf('All field work') === -1);

    /* ---- rendering does not throw on anything it might be handed ---- */
    console.log('\n[rendering survives bad data]');
    const junk = [null, {}, { id: 'x', media: null }, { id: 'y', fields: null, media: [null] }];
    STORE['fieldwork_' + CID] = JSON.stringify(junk);
    UI.reset(); wireHost();
    let threw = null;
    try { UI.renderTab(); } catch (e) { threw = e.message; }
    ok('a store full of junk renders rather than throwing', threw === null, threw);
    ok('the roll-ups survive it too',
        (() => { try { UI.supervisorStats(CID); UI.boardPins(CID, CNUM);
            UI.timelineEvents(CID); UI.exportRows(CID); return true; } catch (_) { return false; } })());

    STORE['fieldwork_' + CID] = 'not json at all';
    UI.reset(); wireHost();
    let threw2 = null;
    try { UI.renderTab(); } catch (e) { threw2 = e.message; }
    ok('a corrupt store renders an empty tab rather than throwing', threw2 === null, threw2);

    console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})();
