/*
 * provenance.js — showing which work on a case came from another detective.
 *
 * Run: node modules\_shared\__tests__\provenance.test.js
 * (pure module, no native deps)
 *
 * WHY THIS EXISTS
 *
 * The `_prov` stamp is written once, by the merge engine, and then read by
 * every tab on the case screen plus two export paths. The failure modes are
 * not crashes:
 *
 *   - a chip that says the wrong detective      -> the officer attributes
 *                                                  somebody else's work
 *   - a colour that changes between repaints    -> the officer learns to
 *                                                  read a legend that lies
 *   - a colour the officer reads as an alert    -> red/amber already mean
 *                                                  overdue and unverified
 *   - the stamp cleared when a record is edited -> the audit trail for the
 *                                                  whole feature is gone
 *   - the stamp printed into a DA report        -> raw JSON in a document
 *                                                  that goes to court
 *   - an officer name rendered unescaped        -> the name arrived in a
 *                                                  file from another machine
 *
 * Every one of those is pinned below.
 */
const path = require('path');
const P = require(path.join(__dirname, '..', 'provenance.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

const PROV = {
    by: 'Det. M. Alvarez',
    badge: '4471',
    agency: 'Fort Worth PD',
    case: '26-0905538',
    at: '2026-10-08T15:04:05.000Z',
    pkg: 'imp-aaa'
};
const imported = (extra) => Object.assign({ name: 'Doe, John', _prov: Object.assign({}, PROV, extra || {}) });
const mine = { name: 'Roe, Jane' };

/* ====================================================================== *
 * the module loads the way the renderer needs it to
 * ====================================================================== */
console.log('\n[the module loads]');

ok('module.exports carries the API', typeof P.chipHtml === 'function');
ok('the global is assigned too, not just module.exports',
    globalThis.Provenance === P);
ok('  — the UMD trap: `module` is defined in VIPER\'s renderer, so a wrapper '
    + 'that picks ONE branch leaves window.Provenance undefined and every '
    + 'host `if (window.Provenance)` branch silently never fires',
    typeof module === 'object' && !!module.exports);

/* ====================================================================== *
 * reading the stamp
 * ====================================================================== */
console.log('\n[whose work is this]');

ok('a stamped record is imported', P.isImported(imported()));
ok('an unstamped record is the officer\'s own', P.isMine(mine));
ok('  — and is not reported as imported', P.isImported(mine) === false);

ok('null does not throw', P.isImported(null) === false);
ok('a string does not throw', P.isImported('hello') === false);
ok('a number does not throw', P.isImported(7) === false);
ok('a record whose _prov is not an object is treated as unstamped',
    P.isImported({ _prov: 'yes' }) === false);
ok('  — and so is one whose _prov is null', P.isImported({ _prov: null }) === false);

ok('a name and badge are joined in exactly one place',
    P.formatWho('Det. M. Alvarez', '4471') === 'Det. M. Alvarez #4471');
ok('  — so the chip, the Contributions panel and an export cover page cannot disagree',
    P.formatWho('Det. M. Alvarez', '4471') === P.sourceName(imported()));
ok('a badge the sender already wrote with a hash is not given a second one',
    P.formatWho('Det. M. Alvarez', '#4471') === 'Det. M. Alvarez #4471');
ok('no badge means no stray hash', P.formatWho('Det. M. Alvarez', '') === 'Det. M. Alvarez');
ok('the badge can be formatted on its own for a layout that colours it separately',
    P.formatBadge('4471') === '#4471' && P.formatBadge('#4471') === '#4471');
ok('an absent badge formats to nothing at all, not to a lone hash',
    P.formatBadge('') === '' && P.formatBadge(null) === '' && P.formatBadge(undefined) === '');
ok('a nameless sender is still named something an officer can read',
    P.formatWho('', '4471') === 'Unknown officer #4471');
ok('surrounding whitespace from another agency\'s settings form is trimmed',
    P.formatWho('  Det. M. Alvarez  ', '  4471  ') === 'Det. M. Alvarez #4471');

ok('the chip names the detective and the badge',
    P.sourceName(imported()) === 'Det. M. Alvarez #4471', P.sourceName(imported()));
ok('a stamp with no badge still names the detective',
    P.sourceName({ _prov: { by: 'Sgt. Price' } }) === 'Sgt. Price');
ok('a stamp with no name says so rather than rendering empty',
    P.sourceName({ _prov: { at: 'x' } }) === 'Unknown officer');
ok('  — which is the same wording the merge engine writes, so the chip and '
    + 'the import summary cannot disagree',
    P.sourceName({ _prov: {} }) === 'Unknown officer');
ok('an own record has no source name', P.sourceName(mine) === '');

ok('the grouping key folds case so one detective is one group',
    P.sourceKey(imported()) === P.sourceKey({ _prov: { by: 'DET. M. ALVAREZ', badge: '4471' } }));
ok('two detectives sharing a surname are different groups',
    P.sourceKey({ _prov: { by: 'Alvarez', badge: '1' } })
    !== P.sourceKey({ _prov: { by: 'Alvarez', badge: '2' } }));
ok('  — because a badge is what actually separates them',
    P.sourceKey({ _prov: { by: 'Alvarez', badge: '1' } }).indexOf('1') !== -1);

ok('the batch id is the package id, so undo can work per import',
    P.batchId(imported()) === 'imp-aaa');
ok('a record with no package id has no batch', P.batchId({ _prov: { by: 'x' } }) === '');

/* ====================================================================== *
 * colour
 * ====================================================================== */
console.log('\n[colour identifies the detective, never a status]');

ok('an imported record gets a colour', P.colorOf(imported()) !== '');
ok('the officer\'s own work gets none', P.colorOf(mine) === '');

ok('the same detective is the same colour every time',
    P.colorOf(imported()) === P.colorOf(imported({ at: '2027-01-01T00:00:00Z', pkg: 'imp-zzz' })));
ok('  — across a different record entirely',
    P.colorOf({ _prov: PROV }) === P.colorOf({ anything: 1, _prov: PROV }));
ok('  — and regardless of the case it arrived in',
    P.colorOf(imported()) === P.colorOf(imported({ case: 'SOMETHING-ELSE' })));

ok('colorFor agrees with colorOf for the same detective',
    P.colorFor('Det. M. Alvarez', '4471') === P.colorOf(imported()));
ok('colorFor with nobody named returns nothing', P.colorFor('', '') === '');

(() => {
    /* The point of a hashed palette is that adding a contributor does not
     * re-colour the ones already on screen. A palette walked by insertion
     * order would, and the officer would have learned a legend that is now
     * wrong. */
    const before = ['Alpha', 'Bravo', 'Charlie'].map(n => P.colorFor(n, ''));
    const after = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map(n => P.colorFor(n, ''));
    ok('adding a fourth and fifth contributor does not re-colour the first three',
        before.join('|') === after.slice(0, 3).join('|'));
})();

(() => {
    /* Red and amber are already load-bearing on a case screen: overdue
     * tasks, unverified names, not-discoverable evidence. A colour that
     * only means "Alvarez sent this" must never be readable as an alert. */
    const bad = P.PALETTE.filter(rgb => {
        const [r, g, b] = rgb.split(',').map(s => parseInt(s.trim(), 10));
        return r > 200 && g < 140 && b < 140;          /* red / amber band */
    });
    ok('no palette entry sits in the red/amber band reserved for alerts',
        bad.length === 0, bad);
    ok('every palette entry is three parseable channels',
        P.PALETTE.every(rgb => rgb.split(',').length === 3
            && rgb.split(',').every(c => Number.isFinite(parseInt(c.trim(), 10)))));
    ok('the palette has enough colours for a realistic multi-agency case',
        P.PALETTE.length >= 6, P.PALETTE.length);
})();

/* ====================================================================== *
 * html
 * ====================================================================== */
console.log('\n[what lands on the card]');

(() => {
    const h = P.chipHtml(imported());
    ok('the chip carries the detective\'s name, not just the word "imported"',
        h.indexOf('Det. M. Alvarez #4471') !== -1, h.slice(0, 160));
    ok('  — because "imported" alone answers the less useful half of the question',
        h.toLowerCase().indexOf('det. m. alvarez') !== -1);
    ok('the chip carries the full source sentence as a tooltip',
        h.indexOf('title="Imported from Det. M. Alvarez #4471') !== -1, h.slice(0, 200));
    ok('the chip is tagged with its source key so a filter can find it in the DOM',
        h.indexOf('data-prov-source=') !== -1);
    ok('the chip uses the detective\'s colour',
        h.indexOf('rgb(' + P.colorOf(imported()) + ')') !== -1);
    ok('an own record renders no chip at all', P.chipHtml(mine) === '');
    ok('null renders no chip', P.chipHtml(null) === '');
})();

(() => {
    const full = P.chipHtml(imported());
    const compact = P.chipHtml(imported(), { compact: true });
    ok('the default chip carries its own spacing, for a card',
        full.indexOf('<div class="mb-2">') === 0);
    ok('the compact chip does not, for a table row',
        compact.indexOf('<div') === -1 && compact.indexOf('<span') === 0);
})();

(() => {
    /* The officer name, badge and agency were typed on somebody else's
     * machine and arrived inside a file. They go straight into innerHTML on
     * every card on the case. */
    const nasty = { _prov: { by: '<img src=x onerror=alert(1)>', badge: '"><script>bad()</script>' } };
    const h = P.chipHtml(nasty);
    ok('a script tag in the sender\'s name is escaped',
        h.indexOf('<script>') === -1 && h.indexOf('<img') === -1, h.slice(0, 200));
    ok('the quote that would break out of the title attribute is escaped',
        h.indexOf('badge="') === -1 && h.indexOf('&quot;') !== -1);
    ok('  — and the escaped text is still shown, not dropped',
        h.indexOf('&lt;img') !== -1);
    ok('an apostrophe is escaped too, since attributes here are quoted',
        P.esc("O'Brien") === 'O&#39;Brien');
    ok('an ampersand is escaped first, not double-escaped after',
        P.esc('A & B') === 'A &amp; B');
})();

(() => {
    const s = P.sourceLine(imported());
    ok('the source line names the detective', s.indexOf('Det. M. Alvarez #4471') !== -1, s);
    ok('the source line names the agency', s.indexOf('Fort Worth PD') !== -1, s);
    ok('the source line gives THEIR case number, which need not match ours',
        s.indexOf('their case 26-0905538') !== -1, s);
    ok('the source line says when it was received', s.indexOf('received 10/08/2026') !== -1, s);
    ok('an unreadable timestamp is omitted rather than printed as Invalid Date',
        P.sourceLine({ _prov: { by: 'X', at: 'not-a-date' } }).indexOf('Invalid') === -1);
    ok('  — and the rest of the line still renders',
        P.sourceLine({ _prov: { by: 'X', at: 'not-a-date' } }).indexOf('Imported from X') === 0);
    ok('an own record has no source line', P.sourceLine(mine) === '');
})();

(() => {
    const a = P.accentStyle(imported());
    ok('the accent is a style fragment, to append to the style already on the card',
        a.indexOf('border-left:') === 0 && a.slice(-1) === ';', a);
    ok('  — appending is the only edit that cannot disturb the existing layout',
        a.indexOf('{') === -1 && a.indexOf('}') === -1);
    ok('the accent uses the same colour as the chip',
        a.indexOf('rgb(' + P.colorOf(imported()) + ')') !== -1);
    ok('own work gets no accent', P.accentStyle(mine) === '');
})();

ok('the legend swatch uses the same colour as the chip',
    P.swatchHtml('Det. M. Alvarez', '4471').indexOf('rgb(' + P.colorOf(imported()) + ')') !== -1);
ok('a swatch for nobody renders nothing', P.swatchHtml('', '') === '');

/* ====================================================================== *
 * editing an imported record
 * ====================================================================== */
console.log('\n[editing something another detective sent]');

(() => {
    const before = imported();
    const after = P.markEdited(before, '2026-10-09T00:00:00.000Z');

    ok('the edited copy still says where it came from',
        P.sourceName(after) === 'Det. M. Alvarez #4471');
    ok('  — because where a record came from stays true no matter how much '
        + 'it is edited afterwards, and clearing it would break the whole '
        + 'audit trail this feature exists for',
        after._prov.by === PROV.by && after._prov.badge === PROV.badge);
    ok('the batch is kept, so the record can still be undone with its import',
        P.batchId(after) === 'imp-aaa');
    ok('it is now flagged as edited here', P.isEditedHere(after) === true);
    ok('and carries when', after._prov.editedAt === '2026-10-09T00:00:00.000Z');

    ok('the original is not mutated — the caller may still be rendering it',
        before._prov.editedHere === undefined);
    ok('  — and the stamp object itself was copied, not shared',
        before._prov !== after._prov);

    ok('the chip says it was edited here', P.chipHtml(after).indexOf('edited here') !== -1);
    ok('the source line says it too',
        P.sourceLine(after).indexOf('edited on this machine since') !== -1);

    ok('an unedited record is not flagged', P.isEditedHere(imported()) === false);

    const again = P.markEdited(after, '2026-11-30T12:00:00.000Z');
    ok('editing it a second time keeps the FIRST edit date',
        again._prov.editedAt === '2026-10-09T00:00:00.000Z');
    ok('  — the useful date is when the record stopped being purely the other '
        + 'detective\'s, not whenever a comma was last moved',
        again._prov.editedHere === true);

    ok('the officer\'s own record is returned untouched — it does not need to '
        + 'be told it was edited by its own author',
        P.markEdited(mine) === mine);
    ok('null is returned untouched', P.markEdited(null) === null);
})();

/* ====================================================================== *
 * filtering
 * ====================================================================== */
console.log('\n[All / Mine / Imported / From one detective]');

ok('"all" shows own work', P.matchesFilter(mine, 'all') === true);
ok('"all" shows imported work', P.matchesFilter(imported(), 'all') === true);
ok('"mine" hides imported work', P.matchesFilter(imported(), 'mine') === false);
ok('"mine" shows own work', P.matchesFilter(mine, 'mine') === true);
ok('"imported" hides own work', P.matchesFilter(mine, 'imported') === false);
ok('"imported" shows imported work', P.matchesFilter(imported(), 'imported') === true);

ok('a per-detective filter shows that detective',
    P.matchesFilter(imported(), 'src:' + P.sourceKey(imported())) === true);
ok('a per-detective filter hides a different detective',
    P.matchesFilter({ _prov: { by: 'Other', badge: '9' } }, 'src:' + P.sourceKey(imported())) === false);
ok('a per-detective filter hides own work',
    P.matchesFilter(mine, 'src:' + P.sourceKey(imported())) === false);

ok('an empty filter shows everything', P.matchesFilter(mine, '') === true);
ok('an unrecognised filter shows everything rather than nothing',
    P.matchesFilter(mine, 'wat') === true && P.matchesFilter(imported(), 'wat') === true);
ok('  — a typo in a filter value must never look like an empty case',
    P.matchesFilter(imported(), 'Mine') === true);

/* ====================================================================== *
 * the contributions panel
 * ====================================================================== */
console.log('\n[who contributed what]');

const ROWS = [
    { store: 'suspects', label: 'suspects', record: imported() },
    { store: 'suspects', label: 'suspects', record: imported({ at: '2026-10-08T15:04:06.000Z' }) },
    { store: 'caseNotes', label: 'notes', record: imported({ at: '2026-10-08T15:04:07.000Z' }) },
    { store: 'suspects', label: 'suspects', record: { _prov: { by: 'Det. R. Pine', badge: '2210', at: '2026-10-09T09:00:00.000Z', pkg: 'imp-bbb' } } },
    { store: 'suspects', label: 'suspects', record: mine },
    { store: 'suspects', label: 'suspects', record: null }
];

(() => {
    const g = P.contributions(ROWS);
    ok('one group per contributing detective', g.length === 2, g.length);
    ok('own work is not a contribution', g.every(x => x.name !== ''));
    ok('a null row does not throw and is not counted',
        g.reduce((n, x) => n + x.total, 0) === 4);
    ok('the busiest contributor sorts first', g[0].name === 'Det. M. Alvarez', g[0].name);
    ok('the group carries the agency so the officer can go back to the source',
        g[0].agency === 'Fort Worth PD');
    ok('the group carries the same colour the chips use',
        g[0].color === P.colorOf(imported()));

    const b = g[0].batches;
    ok('one batch, because all three arrived in the same import', b.length === 1, b.length);
    ok('the batch is named, so it can be undone on its own', b[0].batchId === 'imp-aaa');
    ok('the batch breaks down by what kind of record it was',
        b[0].byStore.suspects === 2 && b[0].byStore.notes === 1, b[0].byStore);
    ok('  — rather than an undifferentiated count', b[0].total === 3);
    ok('the batch carries their case number', b[0].theirCase === '26-0905538');
    ok('the batch timestamp is the earliest in it, so repaints do not reorder it',
        b[0].at === '2026-10-08T15:04:05.000Z', b[0].at);
})();

(() => {
    const g = P.contributions([
        { label: 'suspects', record: { _prov: { by: 'A', pkg: 'p1', at: '2026-01-01T00:00:00Z' } } },
        { label: 'notes', record: { _prov: { by: 'A', pkg: 'p2', at: '2026-02-01T00:00:00Z' } } }
    ]);
    ok('two imports from the same detective are two batches', g[0].batches.length === 2);
    ok('the newest batch is listed first', g[0].batches[0].batchId === 'p2');
    ok('but they are one contributor', g.length === 1 && g[0].total === 2);
})();

ok('a case with nothing imported has no contributions at all',
    P.contributions([{ label: 'suspects', record: mine }]).length === 0);
ok('  — so the panel can hide itself rather than assert an empty case',
    P.contributions([]).length === 0);
ok('undefined rows do not throw', P.contributions(undefined).length === 0);

(() => {
    const s = P.sources(ROWS);
    ok('the filter dropdown lists every contributor', s.length === 2);
    ok('each entry carries the key the filter uses',
        s[0].key === P.sourceKey(imported()));
    ok('each entry carries a count, so the officer sees how much is theirs',
        s[0].count === 3, s[0].count);
})();

/* ====================================================================== *
 * keeping the stamp out of documents that go to court
 * ====================================================================== */
console.log('\n[exports]');

ok('_prov is recognised as internal', P.isInternalKey('_prov') === true);
ok('a normal field is not', P.isInternalKey('name') === false);
ok('the rule is the underscore, not a list of names that would need '
    + 'maintaining every time one is added',
    P.isInternalKey('_anythingAtAll') === true);
ok('an empty key does not throw', P.isInternalKey('') === false);
ok('undefined does not throw', P.isInternalKey(undefined) === false);

(() => {
    const rec = { name: 'Doe, John', dob: '1990-01-02', _prov: PROV, _labelOverride: 'x' };
    const out = P.forExport(rec);
    ok('the export copy drops _prov', out._prov === undefined);
    ok('  — otherwise the generic field dumper prints it as raw JSON into a '
        + 'document that goes to a prosecutor',
        JSON.stringify(out).indexOf('Alvarez') === -1);
    ok('it drops every other internal key too', out._labelOverride === undefined);
    ok('it keeps the real fields', out.name === 'Doe, John' && out.dob === '1990-01-02');
    ok('the original is untouched', rec._prov !== undefined);
    ok('a non-object is returned as-is', P.forExport('hello') === 'hello');
    ok('an array is returned as-is rather than being turned into an object',
        Array.isArray(P.forExport([1, 2])));
})();

(() => {
    const lines = P.coverLines(ROWS);
    ok('one cover line per contributor', lines.length === 2);
    ok('the cover line names the detective and badge in plain text',
        lines[0].indexOf('Det. M. Alvarez #4471') === 0, lines[0]);
    ok('the cover line names the agency', lines[0].indexOf('Fort Worth PD') !== -1);
    ok('the cover line counts what they contributed',
        lines[0].indexOf('2 suspects') !== -1 && lines[0].indexOf('1 notes') !== -1, lines[0]);
    ok('the cover line carries no html — it is read on paper',
        lines.every(l => l.indexOf('<') === -1));
    ok('a case with nothing imported produces no cover lines',
        P.coverLines([{ label: 'x', record: mine }]).length === 0);
})();

console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
