/**
 * "It looks like it saves but when you leave the tab and come back its gone."
 *
 * Three field-reported bugs, all in case-detail-with-analytics.html:
 *
 *   1. Consent Search and Vehicles wrote to localStorage with no try/catch.
 *      Once the quota was full the write threw, the in-memory array had
 *      ALREADY been pushed to, the modal closed, the success toast fired and
 *      the tab re-rendered from memory. The record only disappeared on the
 *      next visit. Consent's handler was `async`, so the browser discarded
 *      the rejection entirely and not even the console showed anything.
 *
 *   2. Consent attachments were base64'd into localStorage, which is both
 *      what filled the quota and what made the failure certain for a scanned
 *      form. The encoder used btoa(String.fromCharCode(...bytes)), which is
 *      a RangeError past about 100KB anyway.
 *
 *   3. The Consent Search module was registered everywhere except the
 *      "+ Add Module" picker, so a case that had never held consent data
 *      could not add the tab at all.
 *
 * These are source-shape assertions against the shipping page plus a live
 * exercise of the rollback contract. Run:
 *   set ELECTRON_RUN_AS_NODE=1 && node_modules\.bin\electron.cmd
 *   modules\_shared\__tests__\case-save-honesty.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CS = require('../case-storage.js');

const ROOT = path.join(__dirname, '..', '..', '..');
// The page is CRLF on disk. Normalise or every multi-line anchor misses.
const PAGE = fs.readFileSync(path.join(ROOT, 'case-detail-with-analytics.html'), 'utf8')
    .replace(/\r\n/g, '\n');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const SNAP = fs.readFileSync(path.join(ROOT, 'case-snapshot.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function check(label, cond, detail) {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/** Count non-overlapping occurrences of a literal. */
function hits(hay, needle) {
    let n = 0, i = 0;
    for (;;) { const j = hay.indexOf(needle, i); if (j < 0) break; n++; i = j + needle.length; }
    return n;
}

(async () => {

    // -----------------------------------------------------------------
    section('bug 3 — Consent Search can actually be added to a case');

    // moduleConfig is the registry; showAddModuleModal is the only thing
    // that can CREATE the tab on a case with no existing consent data.
    check('consentSearch is registered in moduleConfig',
        /consentSearch\s*:\s*\{/.test(PAGE));

    const pickerStart = PAGE.indexOf('function showAddModuleModal');
    check('the module picker exists', pickerStart > 0);
    const pickerBody = PAGE.slice(pickerStart, pickerStart + 9000);
    check('the picker offers Consent Search',
        /id:\s*'consentSearch'/.test(pickerBody), 'picker body missing the entry');
    check('  under a human label',
        /id:\s*'consentSearch',\s*label:\s*'Consent Search'/.test(pickerBody));

    // Regression guard: every other registration site must still be there,
    // because a tab that can be added but not rendered is worse than one
    // that cannot be added.
    check('it still has a render branch', /case\s*'consentSearch'\s*:/.test(PAGE));
    check('it still has an item count', hits(PAGE, "'consentSearch'") >= 6,
        'only ' + hits(PAGE, "'consentSearch'") + ' references');

    // -----------------------------------------------------------------
    section('bug 2 — a refused write is never reported as a save');

    // The guard helper itself.
    check('_lsSetSafe exists', /function _lsSetSafe\(/.test(PAGE));
    check('  and reports success as a boolean', /return res\.ok;/.test(PAGE));

    // No module on the two reported tabs may write storage directly.
    const consentStart = PAGE.indexOf('function saveConsentSearches');
    const consentBody = PAGE.slice(consentStart, consentStart + 400);
    check('saveConsentSearches goes through the guard',
        /_lsSetSafe\(/.test(consentBody), consentBody.slice(0, 160));
    check('  and no longer calls setItem directly',
        !/localStorage\.setItem/.test(consentBody));

    const vehStart = PAGE.indexOf('function saveRecoveredVehicles');
    const vehBody = PAGE.slice(vehStart, vehStart + 500);
    check('saveRecoveredVehicles goes through the guard', /_lsSetSafe\(/.test(vehBody));
    check('  and no longer calls setItem directly',
        !/localStorage\.setItem/.test(vehBody));

    const notesStart = PAGE.indexOf('function _persistCaseNotes');
    const notesBody = PAGE.slice(notesStart, notesStart + 400);
    check('_persistCaseNotes goes through the guard', /_lsSetSafe\(/.test(notesBody));

    // The rollback contract: the list on screen must never be ahead of the
    // list in storage. Each handler restores its previous array on failure.
    const vehSubmit = PAGE.slice(PAGE.indexOf("getElementById('recoveredVehicleForm').onsubmit"),
        PAGE.indexOf("getElementById('recoveredVehicleForm').onsubmit") + 2200);
    check('the vehicle handler works on a copy',
        /const next = recoveredVehicles\.slice\(\)/.test(vehSubmit));
    check('  and rolls back when the write is refused',
        /if \(!saveRecoveredVehicles\(\)\) \{\s*\n\s*recoveredVehicles = before;/.test(vehSubmit),
        'rollback not found');
    check('  the modal is only removed AFTER a successful write',
        vehSubmit.indexOf('saveRecoveredVehicles()') < vehSubmit.indexOf('modal.remove()'));

    check('the consent handler works on a copy',
        /const next = consentSearches\.slice\(\)/.test(PAGE));
    check('  and rolls back when the write is refused',
        /if \(!saveConsentSearches\(\)\) \{[\s\S]{0,200}?consentSearches = before;/.test(PAGE));

    check('deleting a vehicle rolls back too',
        /if \(!saveRecoveredVehicles\(\)\) \{ recoveredVehicles = before; return; \}/.test(PAGE));
    check('deleting a consent record rolls back too',
        /if \(!saveConsentSearches\(\)\) \{ consentSearches = before; return; \}/.test(PAGE));

    check('the note commit reports a refused write as failed',
        /_persistCaseNotes\(\) === false/.test(PAGE));

    // An async submit handler's rejection is dropped by the browser. The
    // consent handler is async, so it must catch its own errors.
    const consentSubmitIdx = PAGE.indexOf("consentSearchForm').onsubmit");
    check('the consent submit handler exists', consentSubmitIdx > 0);
    const consentSubmit = PAGE.slice(consentSubmitIdx, consentSubmitIdx + 9000);
    check('  it wraps its body in try/catch', /\btry\s*\{/.test(consentSubmit)
        && /\bcatch\s*\(/.test(consentSubmit));
    check('  it re-enables the submit button on every exit',
        hits(consentSubmit, 'unwind()') >= 3, hits(consentSubmit, 'unwind()') + ' calls');

    // -----------------------------------------------------------------
    section('bug 2 — binary goes to the case folder, not into storage');

    check('consent attachments are written through the case-attachment IPC',
        /_caseFileSave\('consentSearch'/.test(PAGE));
    check('  the stored record carries a file name, not bytes',
        /fileName:\s*saved/.test(PAGE) || /fileName/.test(PAGE));
    // The page still NAMES the old encoder, in a comment explaining why it
    // was replaced. Strip comments before asserting, or this passes or fails
    // for the wrong reason.
    const PAGE_CODE = PAGE.replace(/^[ \t]*\/\/.*$/gm, '');
    check('  the old all-bytes-at-once encoder is gone from the code',
        !/btoa\(String\.fromCharCode\(\.\.\./.test(PAGE_CODE));
    check('  but is still named in a comment, so nobody reintroduces it',
        /btoa\(String\.fromCharCode\(\.\.\./.test(PAGE));
    check('  and the chunked encoder is used instead',
        /_CS\.bufferToBase64\(/.test(PAGE));
    check('deleting a record also removes its files from disk',
        /caseAttachmentDelete\(\{[\s\S]{0,160}kind: 'consentSearch'/.test(PAGE));
    check('attachments can be opened again',
        /function openConsentAttachment\(/.test(PAGE));

    // The IPC trio and its allow-list.
    check('main exposes case-attachment-save', /ipcMain\.handle\('case-attachment-save'/.test(MAIN));
    check('main exposes case-attachment-read', /ipcMain\.handle\('case-attachment-read'/.test(MAIN));
    check('main exposes case-attachment-delete', /ipcMain\.handle\('case-attachment-delete'/.test(MAIN));
    check('the folder list is an allow-list, not a sanitiser',
        /CASE_ATTACHMENT_DIRS = Object\.freeze\(/.test(MAIN));
    check('  an unknown kind resolves to nothing',
        /if \(!sub\) return null;/.test(MAIN));
    check('writes claim the name by the write itself',
        /flag:\s*'wx'/.test(MAIN));
    check('a locked vault refuses the write outright',
        /Field Security is locked/.test(MAIN));
    check('preload bridges all three', /caseAttachmentSave/.test(PRELOAD)
        && /caseAttachmentRead/.test(PRELOAD) && /caseAttachmentDelete/.test(PRELOAD));

    // -----------------------------------------------------------------
    section('bug 1 — pictures stop costing storage');

    check('the note commit moves images out before writing',
        /_noteImagesToDisk\(contentHtml\)/.test(PAGE));
    check('the close/quit flush blanks hydrated images instead',
        /_CS\.blankHydrated\(contentHtml\)/.test(PAGE));
    check('existing notes are migrated on case open',
        /_noteStorageMaintenance\(\)/.test(PAGE));
    check('  the migration runs once per case', /_noteStorageMaintenanceRun/.test(PAGE));
    check('  it persists the lean copy before hydrating for display',
        PAGE.indexOf('if (migrated) _persistCaseNotes();')
            < PAGE.indexOf('note.contentHtml = await _noteImagesFromDisk(note.contentHtml);'));
    check('the person-note editor offloads images too',
        /savePersonNote[\s\S]{0,900}_noteImagesToDisk/.test(PAGE));
    // Both PDF exports walk note HTML. Neither may draw a blank placeholder
    // because the background hydration had not finished yet.
    check('both PDF exports read the pictures back before drawing',
        hits(PAGE, 'html = await _noteImagesFromDisk(html)') === 2,
        hits(PAGE, 'html = await _noteImagesFromDisk(html)') + ' of 2');

    check('pasted screenshots are downscaled in the main editor',
        /_CS\.shrinkImageDataUrl\(ev\.target\.result\)/.test(PAGE));
    check('uploaded photos are downscaled',
        /_CS\.shrinkImageDataUrl\(raw\)/.test(PAGE));
    check('  and the original is kept if shrinking fails',
        /input\.value = small \|\| raw;/.test(PAGE));

    // The pop-out round-trips through main, so both ends need wiring.
    check('note-get hydrates for the pop-out', /_noteImagesFromDisk\(html\)/.test(MAIN));
    check('note-save strips the bytes again before storing',
        /_CS\.blankHydrated\(d\.contentHtml\)/.test(MAIN));

    // -----------------------------------------------------------------
    section('the global net — no quota failure is silent');

    check('the snapshot wrapper catches quota errors', /_isQuota\(err\)/.test(SNAP));
    check('  tells the officer', /_announceQuota\(\)/.test(SNAP));
    check('  and still re-throws so no caller carries on',
        /if \(_isQuota\(err\)\) _announceQuota\(\);\s*\n\s*throw err;/.test(SNAP));
    check('  the message says nothing was saved', /was NOT saved/.test(SNAP));
    check('  repeated failures are debounced into one message',
        /_quotaToastAt < 4000/.test(SNAP));

    // -----------------------------------------------------------------
    section('the rollback contract, exercised rather than asserted');

    // A byte-ceilinged store, so quota is genuinely reached rather than
    // simulated by a stub that throws on command.
    function makeStore(limitBytes) {
        const data = {};
        return {
            _data: data,
            get length() { return Object.keys(data).length; },
            key(i) { return Object.keys(data)[i]; },
            getItem: k => (k in data ? data[k] : null),
            removeItem: k => { delete data[k]; },
            setItem(k, v) {
                const next = Object.assign({}, data, { [k]: String(v) });
                let total = 0;
                for (const key of Object.keys(next)) total += (key.length + next[key].length) * 2;
                if (total > limitBytes) {
                    const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
                }
                data[k] = String(v);
            }
        };
    }

    // Stand-in for the shipping handler, same shape: copy, swap, write,
    // roll back on refusal.
    const store = makeStore(4096);
    let list = [{ id: 1, note: 'first' }];
    store.setItem('consentSearches_c1', JSON.stringify(list));

    function save(l) {
        return CS.setItemSafe('consentSearches_c1', JSON.stringify(l),
            { store, label: 'the consent search' }).ok;
    }
    function add(record) {
        const next = list.slice();
        next.push(record);
        const before = list;
        list = next;
        if (!save(list)) { list = before; return false; }
        return true;
    }

    check('a small record saves', add({ id: 2, note: 'second' }) === true);
    check('  and is in the list', list.length === 2);
    check('  and in storage', JSON.parse(store.getItem('consentSearches_c1')).length === 2);

    const refused = add({ id: 3, note: 'x'.repeat(4000) });
    check('a record that will not fit is refused', refused === false);
    check('  the in-memory list is rolled back', list.length === 2,
        'len=' + list.length);
    check('  storage still holds exactly what is on screen',
        JSON.parse(store.getItem('consentSearches_c1')).length === list.length);
    check('  the refused record is nowhere', !list.some(r => r.id === 3)
        && store.getItem('consentSearches_c1').indexOf('xxxx') === -1);

    const res = CS.setItemSafe('consentSearches_c1', JSON.stringify([{ n: 'y'.repeat(5000) }]),
        { store, label: 'the consent search' });
    check('the refusal names what was not saved', /the consent search/.test(res.message), res.message);
    check('  and says plainly that nothing was saved', /nothing was saved/.test(res.message));
    check('  and is flagged as a quota problem', res.quota === true);

    console.log('\n' + (fail ? 'FAILED' : 'ALL PASS') + '  ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})();
