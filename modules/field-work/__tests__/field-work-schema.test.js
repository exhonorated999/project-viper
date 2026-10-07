/*
 * Field Work — form contract tests.
 *
 * Run: node modules\field-work\__tests__\field-work-schema.test.js
 * (pure module, no native deps)
 *
 * WHY THIS EXISTS
 *
 * This module is the ONLY definition of what a Field Work form can hold.
 * The FastAPI relay that renders the phone page keeps no copy of it — it
 * renders whatever descriptors VIPER hands it, by type. That is a good
 * trade (a new field ships with the desktop and needs no server deploy)
 * but it moves the whole burden of correctness here:
 *
 *   - a descriptor carrying a `type` the relay does not implement renders
 *     as nothing. The officer gets a form with a missing box and no error.
 *
 *   - `location` is what the Connection Board geocodes. An entry without
 *     it is invisible on the map, which is half the reason the module
 *     exists. It must survive a preset that forgot it and a saved form
 *     record written before it was mandatory.
 *
 *   - `timestamp` is what the entry list, the case timeline and the
 *     supervisor roll-up all sort on. An entry that sorts nowhere is an
 *     entry the investigator cannot find again.
 */
const path = require('path');
const S = require(path.join(__dirname, '..', 'field-work-schema.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')); }
};

/* ====================================================================== *
 * the module loads the way the renderer needs it to
 * ====================================================================== */
console.log('\n[the module loads]');

ok('module.exports carries the API', typeof S.makeEntry === 'function');
ok('the global is assigned too, not just module.exports',
    globalThis.FieldWorkSchema === S);
ok('  — which is the UMD trap: `module` is defined in the renderer',
    typeof module === 'object' && !!module.exports);

/* ====================================================================== *
 * the palette
 * ====================================================================== */
console.log('\n[the palette]');

ok('every field has a key, a label and a type',
    S.FIELD_PALETTE.every(f => f.key && f.label && f.type));

ok('every field type is one the relay implements',
    S.FIELD_PALETTE.every(f => S.TYPES.indexOf(f.type) !== -1),
    S.FIELD_PALETTE.filter(f => S.TYPES.indexOf(f.type) === -1).map(f => f.key));

ok('field keys are unique',
    new Set(S.FIELD_ORDER).size === S.FIELD_ORDER.length);

ok('location is the first field', S.FIELD_ORDER[0] === 'location');
ok('location is flagged always-on', S.FIELD_BY_KEY.location.always === true);
ok('location is the only always-on field',
    S.FIELD_PALETTE.filter(f => f.always).length === 1);
ok('notes is last, because it is the long one',
    S.FIELD_ORDER[S.FIELD_ORDER.length - 1] === 'notes');

ok('labelFor resolves a known key', S.labelFor('vehicle') === 'Vehicle');
ok('labelFor echoes an unknown key rather than throwing',
    S.labelFor('nope') === 'nope');
ok('labelFor tolerates null', S.labelFor(null) === '');

/* ====================================================================== *
 * the capture palette
 * ====================================================================== */
console.log('\n[the capture palette]');

ok('photo, video, audio and document are all offered',
    ['photo', 'video', 'audio', 'document'].every(k => !!S.CAPTURE_BY_KIND[k]));

ok('document is the kind Area Canvas does not have',
    S.CAPTURE_BY_KIND.document.accept.indexOf('.pdf') !== -1);

ok('a document is NOT accepted as any image',
    S.CAPTURE_BY_KIND.document.accept.indexOf('image/*') === -1);

ok('every capture kind declares a count ceiling',
    S.CAPTURE_KINDS.every(c => c.maxCount > 0));
ok('every capture kind declares a byte ceiling',
    S.CAPTURE_KINDS.every(c => c.maxBytes > 0));

ok('video and audio carry a duration budget, stills do not',
    !!S.CAPTURE_BY_KIND.video.totalSeconds
    && !!S.CAPTURE_BY_KIND.audio.totalSeconds
    && !S.CAPTURE_BY_KIND.photo.totalSeconds);

ok('the audio budget is long enough for a real interview (>= 20 min)',
    S.CAPTURE_BY_KIND.audio.totalSeconds >= 1200,
    S.CAPTURE_BY_KIND.audio.totalSeconds);

// A single file must never be allowed to exceed the whole-entry budget;
// if it could, the phone would accept a file the relay is bound to refuse.
ok('no single-file ceiling exceeds the whole-entry ceiling',
    S.CAPTURE_KINDS.every(c => c.maxBytes <= S.ENTRY_MAX_BYTES));

ok('the entry ceiling is smaller than every kind at full count summed',
    S.ENTRY_MAX_BYTES
    < S.CAPTURE_KINDS.reduce((n, c) => n + c.maxCount * c.maxBytes, 0));

/* ====================================================================== *
 * presets
 * ====================================================================== */
console.log('\n[presets]');

ok('preset ids are unique',
    new Set(S.PRESETS.map(p => p.id)).size === S.PRESETS.length);

ok('every preset names only palette fields',
    S.PRESETS.every(p => p.fields.every(k => !!S.FIELD_BY_KEY[k])),
    S.PRESETS.filter(p => p.fields.some(k => !S.FIELD_BY_KEY[k])).map(p => p.id));

ok('every preset names only known capture kinds',
    S.PRESETS.every(p => p.captures.every(k => !!S.CAPTURE_BY_KIND[k])));

ok('every preset includes location',
    S.PRESETS.every(p => p.fields.indexOf('location') !== -1));

ok('every preset offers at least one way to attach something',
    S.PRESETS.every(p => p.captures.length > 0));

ok('every preset has a label and a plain-English description',
    S.PRESETS.every(p => p.label && p.description && p.description.length > 10));

ok('surveillance offers video', S.presetById('surveillance').captures.indexOf('video') !== -1);
ok('interview offers audio', S.presetById('interview').captures.indexOf('audio') !== -1);
ok('interview offers documents — the signed statement comes back as a PDF',
    S.presetById('interview').captures.indexOf('document') !== -1);
ok('interview asks who was interviewed',
    S.presetById('interview').fields.indexOf('personInterviewed') !== -1);
ok('knock & talk asks whether contact was made',
    S.presetById('knock-and-talk').fields.indexOf('contactMade') !== -1);
ok('knock & talk can flag a follow-up',
    S.presetById('knock-and-talk').fields.indexOf('followUp') !== -1);
ok('evidence collection asks what was collected',
    S.presetById('evidence-collection').fields.indexOf('itemDescription') !== -1);
ok('custom starts minimal', S.presetById('custom').fields.length <= 3);

ok('presetById returns null for an unknown id', S.presetById('nope') === null);
ok('presetById tolerates null', S.presetById(null) === null);

/* ====================================================================== *
 * normalisation
 * ====================================================================== */
console.log('\n[normalisation]');

ok('unknown keys are dropped',
    S.normalizeFieldKeys(['notes', 'definitely-not-a-field']).indexOf('definitely-not-a-field') === -1);

ok('duplicates collapse',
    S.normalizeFieldKeys(['notes', 'notes', 'notes']).filter(k => k === 'notes').length === 1);

ok('palette order is restored regardless of input order',
    JSON.stringify(S.normalizeFieldKeys(['notes', 'subject', 'occurredAt']))
    === JSON.stringify(['location', 'occurredAt', 'subject', 'notes']));

// The Connection Board geocodes `address`. A form without it produces
// entries that never reach the map, so unticking it is not an option the
// UI offers and not one a stale record gets to smuggle through either.
ok('location is put back when it was left out', S.normalizeFieldKeys(['notes']).indexOf('location') === 0);
ok('location is put back for an empty list', S.normalizeFieldKeys([]).length === 1);
ok('location is put back for null', S.normalizeFieldKeys(null)[0] === 'location');
ok('location is put back for garbage input', S.normalizeFieldKeys('notes')[0] === 'location');

ok('capture kinds de-duplicate and keep order',
    JSON.stringify(S.normalizeCaptureKinds(['audio', 'photo', 'audio']))
    === JSON.stringify(['photo', 'audio']));
ok('unknown capture kinds are dropped',
    S.normalizeCaptureKinds(['photo', 'hologram']).length === 1);
ok('no captures at all is allowed — a text-only form is legitimate',
    S.normalizeCaptureKinds([]).length === 0);

/* ====================================================================== *
 * the wire format the relay renders from
 * ====================================================================== */
console.log('\n[descriptors — the wire format]');

const D = S.descriptorsFor(['location', 'subject', 'contactMade', 'notes']);

ok('a descriptor is produced per field', D.length === 4);
ok('every descriptor carries key, label and type',
    D.every(d => d.key && d.label && d.type));
ok('every descriptor type is renderable by the relay',
    D.every(d => S.TYPES.indexOf(d.type) !== -1));
ok('the required flag rides along for location',
    D.filter(d => d.key === 'location')[0].required === true);
ok('optional fields carry no required flag at all',
    D.filter(d => d.key === 'subject')[0].required === undefined);
ok('placeholders ride along when the palette has one',
    !!D.filter(d => d.key === 'subject')[0].placeholder);
ok('hints ride along when the palette has one',
    !!D.filter(d => d.key === 'location')[0].hint);
ok('a descriptor carries nothing the relay has no use for',
    D.every(d => Object.keys(d).every(
        k => ['key', 'label', 'type', 'placeholder', 'hint', 'required'].indexOf(k) !== -1)));

ok('descriptors are JSON-round-trippable',
    JSON.stringify(JSON.parse(JSON.stringify(D))) === JSON.stringify(D));

const CS = S.captureSpecFor(['photo', 'document']);
ok('a capture spec is produced per kind', CS.length === 2);
ok('each spec carries the ceilings the relay enforces',
    CS.every(c => c.maxCount > 0 && c.maxBytes > 0 && c.accept));

/* ====================================================================== *
 * address composition
 * ====================================================================== */
console.log('\n[address composition]');

ok('a full address composes in postal order',
    S.composeAddress({ street: '4100 Camp Bowie Blvd', city: 'Fort Worth', state: 'TX', zip: '76107' })
    === '4100 Camp Bowie Blvd, Fort Worth, TX, 76107');

ok('missing parts do not leave stray commas',
    S.composeAddress({ street: '4100 Camp Bowie Blvd', city: '', state: 'TX', zip: '' })
    === '4100 Camp Bowie Blvd, TX');

ok('whitespace-only parts are dropped',
    S.composeAddress({ street: '  ', city: 'Fort Worth', state: '  ', zip: '' })
    === 'Fort Worth');

ok('a plain string passes through trimmed',
    S.composeAddress('  123 Main St  ') === '123 Main St');

ok('null composes to empty, not "undefined"', S.composeAddress(null) === '');
ok('an empty object composes to empty', S.composeAddress({}) === '');

/* ====================================================================== *
 * entry construction
 * ====================================================================== */
console.log('\n[entry construction]');

const E = S.makeEntry({
    preset: 'interview',
    formId: 'abc123',
    timestamp: '2026-10-05T18:30:00.000Z',
    fields: {
        location: { street: '900 Monroe St', city: 'Fort Worth', state: 'TX', zip: '76102' },
        occurredAt: '2026-10-05T17:00:00.000Z',
        personInterviewed: 'Dana Whitlock',
        phone: '(555) 123-4567',
        notes: 'Saw the grey sedan twice.'
    },
    fieldKeys: ['location', 'occurredAt', 'personInterviewed', 'phone', 'notes'],
    media: [{ fileName: 'x.pdf', kind: 'document' }]
});

ok('the preset label is resolved from the id', E.presetLabel === 'Interview');
ok('the address is composed and promoted', E.address === '900 Monroe St, Fort Worth, TX, 76102');
ok('the address parts are kept separately too', E.city === 'Fort Worth' && E.state === 'TX');
ok('location is NOT duplicated into the fields bag', E.fields.location === undefined);
ok('the variable fields land in the bag', E.fields.personInterviewed === 'Dana Whitlock');
ok('notes is promoted out of the bag for the card and the board',
    E.notes === 'Saw the grey sedan twice.');
ok('occurredAt is promoted and normalised to ISO', E.occurredAt === '2026-10-05T17:00:00.000Z');
ok('the filing timestamp is kept separately from when it happened',
    E.timestamp === '2026-10-05T18:30:00.000Z' && E.timestamp !== E.occurredAt);
ok('the originating form is recorded', E.relayFormId === 'abc123');
ok('media rides along', E.media.length === 1);
ok('the source defaults to the relay', E.source === 'relay');
ok('an id is minted', typeof E.id === 'number' && E.id > 0);

// Everything downstream sorts on `timestamp`. There is no acceptable
// answer other than a real ISO string.
const E2 = S.makeEntry({});
ok('a bare entry still gets a timestamp', !!E2.timestamp && !isNaN(new Date(E2.timestamp).getTime()));
ok('a bare entry still gets an occurredAt', !!E2.occurredAt);
ok('occurredAt falls back to the filing time rather than being blank',
    E2.occurredAt === E2.timestamp);
ok('a bare entry has an empty address, not undefined', E2.address === '');
ok('a bare entry defaults to the custom preset', E2.preset === 'custom');
ok('a bare entry has an empty media array, not null', Array.isArray(E2.media) && E2.media.length === 0);

const E3 = S.makeEntry({ timestamp: 'not a date' });
ok('an unparseable timestamp is replaced, not carried',
    !isNaN(new Date(E3.timestamp).getTime()));

const E4 = S.makeEntry({ fields: { occurredAt: 'whenever' } });
ok('an unparseable occurredAt falls back to the filing time',
    E4.occurredAt === E4.timestamp);

/* ── toggles ─────────────────────────────────────────────────────────── */
// The phone sends a toggle back as a boolean, a CSV import sends "Yes",
// and a JSON round trip can turn either into the string "true". All three
// have to mean the same thing or follow-up flags go missing.
console.log('\n[toggles]');

const mk = (v) => S.makeEntry({ fields: { followUp: v, contactMade: v }, fieldKeys: ['followUp', 'contactMade'] });
ok('a boolean true reads as true', mk(true).followUp === true);
ok('the string "true" reads as true', mk('true').followUp === true);
ok('the string "Yes" reads as true', mk('Yes').followUp === true);
ok('a boolean false reads as false', mk(false).followUp === false);
ok('the string "No" reads as false', mk('No').followUp === false);
ok('undefined reads as false, never undefined', mk(undefined).followUp === false);
ok('a toggle is always a real boolean in the bag',
    typeof mk('Yes').fields.contactMade === 'boolean');
ok('followUp is promoted to the top level for the map legend',
    mk(true).followUp === true && mk(true).fields.followUp === true);

/* ── manual coordinates ──────────────────────────────────────────────── */
console.log('\n[manual coordinates]');

const EM = S.makeEntry({ manualLat: 32.7555, manualLon: -97.3308 });
ok('typed coordinates are kept', EM.manualLat === 32.7555 && EM.manualLon === -97.3308);
ok('absent coordinates are absent, not zero',
    S.makeEntry({}).manualLat === undefined);
ok('NaN coordinates are refused rather than stored',
    S.makeEntry({ manualLat: NaN, manualLon: NaN }).manualLat === undefined);
ok('string coordinates are refused — a half-parsed number is worse than none',
    S.makeEntry({ manualLat: '32.7', manualLon: '-97.3' }).manualLat === undefined);

/* ====================================================================== *
 * presentation helpers
 * ====================================================================== */
console.log('\n[summary line]');

ok('the summary names who was interviewed',
    S.summaryLine(E).indexOf('Dana Whitlock') !== -1);
ok('the summary labels the field it is showing',
    S.summaryLine(E).indexOf('Person Interviewed:') === 0);
ok('a notes-only entry summarises as its notes',
    S.summaryLine(S.makeEntry({ fields: { notes: 'Nobody home.' }, fieldKeys: ['notes'] })) === 'Nobody home.');
ok('an empty entry summarises as empty, not "undefined"',
    S.summaryLine(S.makeEntry({})) === '');
ok('summaryLine tolerates null', S.summaryLine(null) === '');

const multi = S.makeEntry({
    fields: { subject: 'Tall male', vehicle: 'TX ABC-1234', activity: 'Left at 1800' },
    fieldKeys: ['subject', 'vehicle', 'activity']
});
ok('several identifying fields are joined, who-and-what first',
    S.summaryLine(multi).indexOf('Subject / Person Observed: Tall male') === 0);
ok('the vehicle comes before the activity',
    S.summaryLine(multi).indexOf('TX ABC-1234') < S.summaryLine(multi).indexOf('Left at 1800'));

console.log('\n[map legend]');

ok('a follow-up entry is purple', S.markerColor(S.makeEntry({ fields: { followUp: true }, fieldKeys: ['followUp'] })) === '#a855f7');
ok('an entry with attachments is orange',
    S.markerColor(S.makeEntry({ media: [{ fileName: 'a.jpg' }] })) === '#f97316');
ok('a contact-made entry is green',
    S.markerColor(S.makeEntry({ fields: { contactMade: true }, fieldKeys: ['contactMade'] })) === '#22c55e');
ok('a plain entry is grey', S.markerColor(S.makeEntry({})) === '#9ca3af');
ok('follow-up outranks attachments',
    S.markerColor(S.makeEntry({ fields: { followUp: true }, fieldKeys: ['followUp'], media: [{ fileName: 'a.jpg' }] })) === '#a855f7');
ok('markerColor tolerates null', S.markerColor(null) === '#9ca3af');

ok('the status label names the follow-up',
    S.statusLabel(S.makeEntry({ fields: { followUp: true }, fieldKeys: ['followUp'] })) === 'Needs follow-up');
ok('the status label counts one attachment in the singular',
    S.statusLabel(S.makeEntry({ media: [{ fileName: 'a.jpg' }] })) === '1 attachment');
ok('the status label counts two in the plural',
    S.statusLabel(S.makeEntry({ media: [{}, {}] })) === '2 attachments');
ok('a plain entry still says something', S.statusLabel(S.makeEntry({})) === 'Logged');
ok('statusLabel tolerates null', S.statusLabel(null) === '');

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
