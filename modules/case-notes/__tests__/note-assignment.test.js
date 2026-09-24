/**
 * Notes <-> people assignment.
 *
 * The logic lives inline in case-detail-with-analytics.html, so this test
 * LIFTS the shipping block out of the page and runs it in a vm context
 * against fake storage and a fake DOM. A copied block would be the thing
 * that drifts; a lifted one fails the moment the page changes shape.
 *
 * Run: set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *      modules\case-notes\__tests__\note-assignment.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = path.join(__dirname, '..', '..', '..', 'case-detail-with-analytics.html');
// The page is CRLF on disk. Normalise so multi-line anchors below do not
// silently miss.
const SRC = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ---------------------------------------------------------------- lift

const START = '// \u2500\u2500\u2500 Notes \u2194 people';
const END = 'async function exportNotesToPDF';
const a = SRC.indexOf(START);
const b = SRC.indexOf(END);
if (a < 0 || b < 0 || b <= a) {
    console.error('Could not locate the notes/people block in the page. Anchors moved?');
    process.exit(1);
}
const BLOCK = SRC.slice(a, b);

// `const NOTE_PERSON_ROLES` is lexical, so it never lands on the sandbox
// global the way a function declaration does. Append a test-only hook that
// republishes the block's API rather than restructuring shipping code.
const EXPORTS = [
    'NOTE_PERSON_ROLES', '_noteRoleLabel', '_notePersonAccess', '_persistCaseNotes',
    '_ensurePersonNoteUid', '_buildPersonNoteIndex', '_findPersonByNoteUid',
    '_noteAssignments', '_notesForPersonUid', 'openPersonFromNote',
    '_renderNoteAssignPicker', '_syncNoteAssignBoxes', '_collectNoteAssignments',
    '_noteAssigneeChips', 'renderPersonNotesCard', 'openPersonNoteEditor',
    'closePersonNoteEditor', 'savePersonNote', 'deleteNoteFromProfile',
    'unassignNoteFromPerson'
];
const HOOK = '\n;Object.assign(globalThis, {' + EXPORTS.join(', ') + '});\n';

// ------------------------------------------------------- fake platform

function makeStorage() {
    const data = {};
    return {
        _data: data,
        getItem: k => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: k => { delete data[k]; }
    };
}

/** Minimal element good enough for querySelectorAll on the picker. */
function makeCheckbox(role, index, uid) {
    return {
        checked: false,
        _attrs: { 'data-role': role, 'data-index': String(index), 'data-uid': uid || '' },
        getAttribute(k) { return this._attrs[k]; }
    };
}

function buildSandbox(state) {
    const localStorage = makeStorage();
    const toasts = [];
    const rendered = [];

    const sandbox = {
        console,
        localStorage,
        Date,
        Math,
        JSON,
        isNaN,
        parseInt,
        // --- host state (top-level `let` in the real page) ---
        currentCase: { id: 'case-1', caseNumber: '25-55555' },
        caseNotes: state.caseNotes,
        suspects: state.suspects || [],
        victims: state.victims || [],
        witnesses: state.witnesses || [],
        involvedPersons: state.involvedPersons || [],
        missingPersons: state.missingPersons || [],
        currentSuspectView: null,
        currentVictimView: null,
        currentWitnessView: null,
        currentInvolvedPersonView: null,
        currentMissingPersonView: null,
        // --- host helpers ---
        _lsParse(key, fallback) {
            try { return JSON.parse(localStorage.getItem(key)) || fallback; }
            catch (_) { return fallback; }
        },
        _escapeHtml: s => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        _escapeAttr: s => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
        _formatBytes: n => n + ' B',
        _noteResolveHtml: n => (n && n.contentHtml) || '',
        _noteRenderHtml: n => (n && n.contentHtml) || '',
        _noteAttachmentList: () => '',
        viperToast: (m, k) => toasts.push({ m, k }),
        ensureCaseModule: () => {},
        renderTabs: () => {},
        renderTabContent: t => rendered.push(t),
        requestAnimationFrame: fn => fn(),
        document: {
            _boxes: [],
            getElementById(id) {
                if (id === 'noteAssignList') {
                    const boxes = this._boxes;
                    return { querySelectorAll: () => ({ forEach: fn => boxes.forEach(fn) }) };
                }
                return null;
            },
            body: { insertAdjacentHTML: () => {} }
        },
        // --- party list accessors the block calls by name ---
        loadSuspects() { sandbox.suspects = sandbox._lsParse('suspects_case-1', sandbox.suspects); },
        saveSuspects() { localStorage.setItem('suspects_case-1', JSON.stringify(sandbox.suspects)); },
        loadVictims() { sandbox.victims = sandbox._lsParse('victims_case-1', sandbox.victims); },
        saveVictims() { localStorage.setItem('victims_case-1', JSON.stringify(sandbox.victims)); },
        loadWitnesses() { sandbox.witnesses = sandbox._lsParse('witnesses_case-1', sandbox.witnesses); },
        saveWitnesses() { localStorage.setItem('witnesses_case-1', JSON.stringify(sandbox.witnesses)); },
        loadInvolvedPersons() { sandbox.involvedPersons = sandbox._lsParse('involvedPersons_case-1', sandbox.involvedPersons); },
        saveInvolvedPersons() { localStorage.setItem('involvedPersons_case-1', JSON.stringify(sandbox.involvedPersons)); },
        loadMissingPersons() { sandbox.missingPersons = sandbox._lsParse('missingpersons_case-1', sandbox.missingPersons); },
        saveMissingPersons() { localStorage.setItem('missingpersons_case-1', JSON.stringify(sandbox.missingPersons)); },
        // captured for assertions
        __toasts: toasts,
        __rendered: rendered
    };
    sandbox.window = sandbox;      // renderer-style self reference
    vm.createContext(sandbox);
    // Seed storage so the load* accessors round-trip rather than wiping.
    sandbox.saveSuspects();
    sandbox.saveVictims();
    sandbox.saveWitnesses();
    sandbox.saveInvolvedPersons();
    sandbox.saveMissingPersons();
    vm.runInContext(BLOCK + HOOK, sandbox);
    return sandbox;
}

// ================================================================ tests

section('the block lifts and runs');
const s0 = buildSandbox({
    caseNotes: [],
    suspects: [{ name: 'Jane Roe' }, { name: 'John Doe' }],
    victims: [{ name: 'Pat Smith' }],
    witnesses: [],
    involvedPersons: [],
    missingPersons: []
});
check('NOTE_PERSON_ROLES covers all five party lists', s0.NOTE_PERSON_ROLES.length === 5);
check('roles are the real tab ids',
    s0.NOTE_PERSON_ROLES.map(d => d.role).join(',') ===
    'suspects,victims,witnesses,involvedPersons,missingpersons');
check('_noteRoleLabel maps a known role', s0._noteRoleLabel('victims') === 'Victim');
check('_noteRoleLabel degrades for an unknown role', s0._noteRoleLabel('aliens') === 'Person');

section('a uid is only minted when something is filed');
check('opening a profile does not stamp a uid',
    s0.renderPersonNotesCard('suspects', 0).length > 0 && !s0.suspects[0].noteUid);
const uid0 = s0._ensurePersonNoteUid('suspects', 0);
check('_ensurePersonNoteUid returns a non-empty id', !!uid0 && typeof uid0 === 'string');
check('the uid is persisted onto the person record', s0.suspects[0].noteUid === uid0);
check('the uid survives a reload from storage',
    JSON.parse(s0.localStorage.getItem('suspects_case-1'))[0].noteUid === uid0);
check('calling it again is idempotent', s0._ensurePersonNoteUid('suspects', 0) === uid0);
const uid1 = s0._ensurePersonNoteUid('suspects', 1);
check('a second person gets a different uid', uid1 !== uid0);
check('an out-of-range index yields no uid', s0._ensurePersonNoteUid('suspects', 99) === '');
check('an unknown role yields no uid', s0._ensurePersonNoteUid('aliens', 0) === '');

section('the uid index resolves people across every list');
const vUid = s0._ensurePersonNoteUid('victims', 0);
const idx = s0._buildPersonNoteIndex();
check('the suspect is in the index', idx[uid0] && idx[uid0].role === 'suspects');
check('the index carries the display name', idx[uid0].name === 'Jane Roe');
check('the victim is in the index', idx[vUid] && idx[vUid].label === 'Victim');
check('_findPersonByNoteUid finds a live person', s0._findPersonByNoteUid(vUid).index === 0);
check('_findPersonByNoteUid returns null for a stranger', s0._findPersonByNoteUid('nope') === null);
check('_findPersonByNoteUid returns null for an empty uid', s0._findPersonByNoteUid('') === null);

section('a note can be filed against a person and read back');
const s1 = buildSandbox({
    caseNotes: [],
    suspects: [{ name: 'Jane Roe' }],
    victims: [{ name: 'Pat Smith' }]
});
s1.document._boxes = [
    makeCheckbox('suspects', 0, ''),
    makeCheckbox('victims', 0, '')
];
s1.document._boxes[0].checked = true;
const links = s1._collectNoteAssignments();
check('only the ticked person comes back', links.length === 1);
check('the link carries the role', links[0].role === 'suspects');
check('the link carries a name snapshot', links[0].name === 'Jane Roe');
check('ticking stamps the uid', !!s1.suspects[0].noteUid);
check('the link uid matches the record', links[0].uid === s1.suspects[0].noteUid);

s1.caseNotes.push({
    id: 1, contentHtml: '<p>Knocked, no answer</p>',
    createdAt: '2026-09-24T10:00:00.000Z', editHistory: [], attachments: [],
    assignedTo: links
});
s1.caseNotes.push({
    id: 2, contentHtml: '<p>Unrelated</p>',
    createdAt: '2026-09-24T11:00:00.000Z', editHistory: [], attachments: []
});
const mine = s1._notesForPersonUid(links[0].uid);
check('only the assigned note comes back', mine.length === 1 && mine[0].id === 1);
check('an unassigned note is excluded',
    s1._notesForPersonUid(links[0].uid).every(n => n.id !== 2));
check('an unknown uid returns nothing', s1._notesForPersonUid('ghost').length === 0);

s1.caseNotes.push({
    id: 3, contentHtml: '<p>Later</p>',
    createdAt: '2026-09-24T12:00:00.000Z', assignedTo: links
});
check('a person\'s notes come back newest first',
    s1._notesForPersonUid(links[0].uid).map(n => n.id).join(',') === '3,1');

section('the note is never copied - one record, two surfaces');
check('the note object on the profile IS the note in caseNotes',
    s1._notesForPersonUid(links[0].uid)[0] === s1.caseNotes.find(n => n.id === 3));
check('nothing was written to a second store',
    Object.keys(s1.localStorage._data).filter(k => /note/i.test(k) && k !== 'viperCaseNotes').length === 0);

section('an unpicked picker leaves assignments alone');
const s2 = buildSandbox({ caseNotes: [], suspects: [{ name: 'A' }] });
s2.document._boxes = [];
check('a mounted-but-empty picker returns an empty list',
    Array.isArray(s2._collectNoteAssignments()) && s2._collectNoteAssignments().length === 0);
// The real page returns null when the picker element is absent, so saveNote
// knows to leave an existing note's assignments untouched.
s2.document.getElementById = () => null;
check('an absent picker returns null (do not clobber existing links)',
    s2._collectNoteAssignments() === null);

section('_noteAssignments is defensive about shape');
const s3 = buildSandbox({ caseNotes: [], suspects: [{ name: 'A' }] });
check('a note with no assignedTo reads as empty', s3._noteAssignments({ id: 1 }).length === 0);
check('a non-array assignedTo reads as empty',
    s3._noteAssignments({ id: 1, assignedTo: 'x' }).length === 0);
check('entries without a uid are dropped',
    s3._noteAssignments({ id: 1, assignedTo: [{ role: 'suspects' }, { uid: 'u1' }] }).length === 1);
check('a null note reads as empty', s3._noteAssignments(null).length === 0);

section('chips');
const s4 = buildSandbox({ caseNotes: [], suspects: [{ name: 'Jane Roe' }] });
const u4 = s4._ensurePersonNoteUid('suspects', 0);
const chipNote = { id: 1, assignedTo: [{ uid: u4, role: 'suspects', name: 'Jane Roe' }] };
const chips = s4._noteAssigneeChips(chipNote);
check('a live person renders a clickable chip', chips.indexOf('openPersonFromNote(') !== -1);
check('the chip shows the current name, not the snapshot', chips.indexOf('Jane Roe') !== -1);
check('the chip shows the role', chips.indexOf('Suspect') !== -1);
check('a note with no links renders no chip row', s4._noteAssigneeChips({ id: 2 }) === '');

// A deleted person must not silently vanish from the note - the record has
// to stay honest about who it was filed against.
const ghostChips = s4._noteAssigneeChips({ id: 3, assignedTo: [{ uid: 'gone', name: 'Old Name' }] });
check('a removed person is still shown', ghostChips.indexOf('Old Name') !== -1);
check('a removed person is marked as removed', ghostChips.indexOf('removed') !== -1);
check('a removed person is not clickable', ghostChips.indexOf('openPersonFromNote(') === -1);

section('names are escaped on the way out');
const s5 = buildSandbox({ caseNotes: [], suspects: [{ name: '<img src=x onerror=alert(1)>' }] });
const u5 = s5._ensurePersonNoteUid('suspects', 0);
const evil = s5._noteAssigneeChips({ id: 1, assignedTo: [{ uid: u5 }] });
check('a hostile person name cannot inject markup into a chip',
    evil.indexOf('<img src=x') === -1 && evil.indexOf('&lt;img') !== -1);
const card = s5.renderPersonNotesCard('suspects', 0);
check('a hostile person name cannot inject markup into the profile card',
    card.indexOf('<img src=x') === -1);

section('the profile card');
const s6 = buildSandbox({
    caseNotes: [],
    suspects: [{ name: 'Jane Roe' }]
});
const empty = s6.renderPersonNotesCard('suspects', 0);
check('an unlinked person still gets the card', empty.indexOf('Case Notes') !== -1);
check('the empty state is explicit', empty.indexOf('No notes assigned yet') !== -1);
check('the card offers Add Note', empty.indexOf('openPersonNoteEditor(') !== -1);
check('the card says where the note actually lives',
    empty.indexOf('Case Notes module') !== -1);
const u6 = s6._ensurePersonNoteUid('suspects', 0);
s6.caseNotes.push({
    id: 7, contentHtml: '<p>Door knock</p>', createdAt: '2026-09-24T10:00:00.000Z',
    assignedTo: [{ uid: u6, role: 'suspects', name: 'Jane Roe' }]
});
const full = s6.renderPersonNotesCard('suspects', 0);
check('the assigned note renders on the profile', full.indexOf('Door knock') !== -1);
check('the note count badge appears', full.indexOf('>1</span>') !== -1);
check('the note can be edited from the profile',
    full.indexOf('openPersonNoteEditor(\'suspects\', 0, 7)') !== -1);
check('the note can be unassigned from the profile',
    full.indexOf('unassignNoteFromPerson(7,') !== -1);
check('a missing person index renders nothing',
    s6.renderPersonNotesCard('suspects', 42) === '');
check('an unknown role renders nothing',
    s6.renderPersonNotesCard('aliens', 0) === '');

section('unassign detaches without deleting');
const s7 = buildSandbox({ caseNotes: [], suspects: [{ name: 'Jane Roe' }], victims: [{ name: 'Pat' }] });
const su = s7._ensurePersonNoteUid('suspects', 0);
const vu = s7._ensurePersonNoteUid('victims', 0);
s7.caseNotes.push({
    id: 9, contentHtml: '<p>Shared</p>', createdAt: '2026-09-24T10:00:00.000Z',
    assignedTo: [{ uid: su, role: 'suspects', name: 'Jane Roe' },
                 { uid: vu, role: 'victims', name: 'Pat' }]
});
s7.viperConfirm = async () => true;
(async () => {
    await s7.unassignNoteFromPerson(9, su, 'suspects', 0);
    const note = s7.caseNotes.find(n => n.id === 9);
    check('the note itself survives', !!note);
    check('the suspect link is gone', !note.assignedTo.some(x => x.uid === su));
    check('the victim link is untouched', note.assignedTo.some(x => x.uid === vu));
    check('the change is persisted',
        JSON.parse(s7.localStorage.getItem('viperCaseNotes'))['25-55555'][0]
            .assignedTo.length === 1);
    check('the profile it was removed from re-renders',
        s7.__rendered[s7.__rendered.length - 1] === 'suspects');

    section('the picker');
    const s8 = buildSandbox({
        caseNotes: [],
        suspects: [{ name: 'Jane Roe' }],
        witnesses: [{ name: '' }]
    });
    const picker = s8._renderNoteAssignPicker();
    check('every party list with people is offered', picker.indexOf('Jane Roe') !== -1);
    check('empty lists are omitted', picker.indexOf('Victim') === -1);
    check('a nameless person is still pickable', picker.indexOf('Unnamed Witness') !== -1);
    check('checkboxes carry role and index',
        picker.indexOf('data-role="suspects"') !== -1 && picker.indexOf('data-index="0"') !== -1);
    const s9 = buildSandbox({ caseNotes: [] });
    check('a case with nobody on it says so',
        s9._renderNoteAssignPicker().indexOf('No people on this case yet') !== -1);

    section('the page wires it all together');
    check('the Case Notes form mounts the picker', SRC.indexOf('id="noteAssignList"') !== -1);
    check('the note card renders chips', SRC.indexOf('_noteAssigneeChips(note, personIndex)') !== -1);
    check('the person index is built once per list render',
        SRC.indexOf('const personIndex = _buildPersonNoteIndex();') !== -1);
    for (const role of ['suspects', 'victims', 'witnesses', 'involvedPersons', 'missingpersons']) {
        check('the ' + role + ' profile renders the notes card',
            SRC.indexOf("renderPersonNotesCard('" + role + "', index)") !== -1);
    }
    check('saveNote reads the picker before re-rendering',
        SRC.indexOf('const assignments = _collectNoteAssignments();') <
        SRC.indexOf("renderTabContent('notes');\n                viperToast('Note saved."));
    check('editNote re-ticks the boxes', SRC.indexOf('_syncNoteAssignBoxes(note)') !== -1);
    check('a fresh note starts with nothing ticked', SRC.indexOf('_syncNoteAssignBoxes(null)') !== -1);

    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + '  ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})();
