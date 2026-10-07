/*
 * Field Work — the form contract.
 *
 * Area Canvas is a crew of officers working one neighbourhood off one shared
 * form. Field Work is the opposite: ONE investigator, their own phone, their
 * own case, and a form they shape to the job in front of them. A surveillance
 * sit wants a subject, a vehicle and video. An interview wants a name, an
 * audio recording and a PDF of the signed statement. Forcing both through the
 * same seven boxes is how a tool stops getting used in the field.
 *
 * THIS FILE IS THE SINGLE DEFINITION OF WHAT A FIELD WORK FORM CAN CONTAIN.
 *
 * That is deliberate and it is the most important thing about the module. The
 * phone page is rendered by the FastAPI relay in the other repo, but the relay
 * does NOT keep its own copy of the field list. VIPER sends the chosen fields
 * as descriptors ({key, label, type, ...}) when the form is created, and the
 * relay renders whatever it is handed, generically, by `type`. So adding a
 * field here ships with the desktop app and needs no server deploy at all —
 * which is the difference between a half-hour change and a two-repo release.
 *
 * Area Canvas went the other way: its seven fields are a hard-coded if/else
 * ladder inside the server's page template, and the desktop only sends a list
 * of names it hopes the server recognises. Two definitions, and the way you
 * find out they disagree is an officer staring at a form with a missing box.
 *
 * Pure, dependency-free, and loadable in Node so the whole contract is
 * testable without Electron.
 */
(function (root, factory) {
    var api = factory();
    // module IS defined in VIPER's renderer, so assigning to only one of
    // these leaves window.FieldWorkSchema undefined and every caller
    // silently does nothing. Assign to BOTH, always.
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.FieldWorkSchema = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ── Widget types the relay knows how to render ──────────────────────
     * The relay validates every descriptor's `type` against this list and
     * drops anything it does not recognise, so an older server paired with a
     * newer desktop loses one box rather than serving a broken page.
     */
    var TYPES = ['address', 'text', 'textarea', 'tel', 'toggle', 'datetime'];

    /* ── The field palette ────────────────────────────────────────────────
     * Order here is the order on the phone. `location` is first and is not
     * optional: without an address there is nothing to put on the Connection
     * Board, and placing field work on the map is half the point of it.
     */
    var FIELD_PALETTE = [
        {
            key: 'location', label: 'Location', type: 'address', required: true, always: true,
            hint: 'City & State help GPS map this entry. Street alone may not locate.'
        },
        {
            key: 'occurredAt', label: 'Date & Time', type: 'datetime',
            hint: 'When the work happened, if that is not when you are filing it.'
        },
        { key: 'subject', label: 'Subject / Person Observed', type: 'text', placeholder: 'Name or description' },
        { key: 'personInterviewed', label: 'Person Interviewed', type: 'text', placeholder: 'John Doe' },
        { key: 'contactMade', label: 'Contact Made?', type: 'toggle' },
        { key: 'phone', label: 'Phone Number', type: 'tel', placeholder: '(555) 123-4567' },
        { key: 'vehicle', label: 'Vehicle', type: 'text', placeholder: 'Plate, make, model, colour' },
        { key: 'activity', label: 'Activity Observed', type: 'text', placeholder: 'What happened' },
        { key: 'itemDescription', label: 'Item / Evidence Description', type: 'text', placeholder: 'What was collected' },
        { key: 'officerName', label: 'Officer Name', type: 'text', placeholder: 'Your name' },
        { key: 'followUp', label: 'Needs Follow-Up', type: 'toggle' },
        { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Observations, context, anything else' }
    ];

    var FIELD_BY_KEY = {};
    FIELD_PALETTE.forEach(function (f) { FIELD_BY_KEY[f.key] = f; });

    var FIELD_ORDER = FIELD_PALETTE.map(function (f) { return f.key; });

    /* ── The capture palette ──────────────────────────────────────────────
     * `document` is the one Area Canvas does not have, and it is the reason
     * the interview preset is worth anything: a signed consent or statement
     * comes off a phone as a PDF, not a photo.
     *
     * Counts and byte ceilings are mirrored by the relay, which enforces them
     * server-side — these numbers are the UI's half of the same contract and
     * a test pins them against the server's.
     */
    var CAPTURE_KINDS = [
        { kind: 'photo', label: 'Photos', icon: '📷', maxCount: 10, maxBytes: 8 * 1024 * 1024, accept: 'image/*' },
        { kind: 'video', label: 'Video', icon: '🎥', maxCount: 3, maxBytes: 48 * 1024 * 1024, accept: 'video/*', totalSeconds: 180 },
        { kind: 'audio', label: 'Audio', icon: '🎙️', maxCount: 4, maxBytes: 24 * 1024 * 1024, accept: 'audio/*', totalSeconds: 1800 },
        {
            kind: 'document', label: 'Documents', icon: '📄', maxCount: 6, maxBytes: 24 * 1024 * 1024,
            accept: '.pdf,.doc,.docx,.txt,.rtf,.csv,.xls,.xlsx,application/pdf'
        }
    ];

    var CAPTURE_BY_KIND = {};
    CAPTURE_KINDS.forEach(function (c) { CAPTURE_BY_KIND[c.kind] = c; });

    var CAPTURE_ORDER = CAPTURE_KINDS.map(function (c) { return c.kind; });

    // Everything one entry may carry, in total. The relay refuses past this
    // too; the phone shows it as a running budget so an officer finds out
    // before the upload, not after.
    var ENTRY_MAX_BYTES = 96 * 1024 * 1024;

    // Photos are downscaled on the phone before they are encrypted. A 1600px
    // long edge is more than any report or court exhibit uses and it is the
    // difference between a 300 KB upload and a 6 MB one on cell data.
    var IMAGE_MAX_EDGE = 1600;

    /* ── Presets ──────────────────────────────────────────────────────────
     * A preset is a starting point, never a cage: every one of these is
     * editable before the form is created. They exist because an investigator
     * about to sit on a house should not have to think about checkboxes.
     */
    var PRESETS = [
        {
            id: 'surveillance',
            label: 'Surveillance',
            icon: '👁️',
            description: 'Watching a location, person or vehicle.',
            fields: ['location', 'occurredAt', 'subject', 'vehicle', 'activity', 'notes'],
            captures: ['photo', 'video']
        },
        {
            id: 'interview',
            label: 'Interview',
            icon: '🎙️',
            description: 'Statement from a witness, victim or subject.',
            fields: ['location', 'occurredAt', 'personInterviewed', 'phone', 'notes'],
            captures: ['audio', 'document', 'photo']
        },
        {
            id: 'knock-and-talk',
            label: 'Knock & Talk',
            icon: '🚪',
            description: 'Door contact — who answered and what they said.',
            fields: ['location', 'occurredAt', 'personInterviewed', 'contactMade', 'phone', 'followUp', 'notes'],
            captures: ['photo', 'audio']
        },
        {
            id: 'evidence-collection',
            label: 'Evidence Collection',
            icon: '📦',
            description: 'Something picked up in the field.',
            fields: ['location', 'occurredAt', 'itemDescription', 'notes'],
            captures: ['photo', 'document']
        },
        {
            id: 'vehicle-observation',
            label: 'Vehicle Observation',
            icon: '🚗',
            description: 'A plate, a parked car, a vehicle on the move.',
            fields: ['location', 'occurredAt', 'vehicle', 'activity', 'notes'],
            captures: ['photo', 'video']
        },
        {
            id: 'custom',
            label: 'Custom',
            icon: '⚙️',
            description: 'Start minimal and pick your own.',
            fields: ['location', 'occurredAt', 'notes'],
            captures: ['photo']
        }
    ];

    var PRESET_BY_ID = {};
    PRESETS.forEach(function (p) { PRESET_BY_ID[p.id] = p; });

    function presetById(id) {
        return PRESET_BY_ID[String(id || '')] || null;
    }

    function labelFor(key) {
        var f = FIELD_BY_KEY[key];
        return f ? f.label : String(key || '');
    }

    /* ── Normalisation ────────────────────────────────────────────────────
     * Anything arriving from a saved form record, a preset or a checkbox
     * sweep goes through here. De-duplicates, drops anything not in the
     * palette, and restores palette order so the phone form never comes out
     * in whatever order the DOM happened to hand back.
     */
    function normalizeFieldKeys(keys) {
        var want = {};
        (Array.isArray(keys) ? keys : []).forEach(function (k) {
            if (FIELD_BY_KEY[k]) want[k] = true;
        });
        // `location` is structural, not a preference. Put it back if it was
        // unticked, dropped by an older record, or never there at all.
        FIELD_PALETTE.forEach(function (f) { if (f.always) want[f.key] = true; });
        return FIELD_ORDER.filter(function (k) { return want[k]; });
    }

    function normalizeCaptureKinds(kinds) {
        var want = {};
        (Array.isArray(kinds) ? kinds : []).forEach(function (k) {
            if (CAPTURE_BY_KIND[k]) want[k] = true;
        });
        return CAPTURE_ORDER.filter(function (k) { return want[k]; });
    }

    /*
     * The wire format. This is what the relay renders the phone page from,
     * so it has to be complete — the server looks nothing up.
     */
    function descriptorsFor(fieldKeys) {
        return normalizeFieldKeys(fieldKeys).map(function (k) {
            var f = FIELD_BY_KEY[k];
            var d = { key: f.key, label: f.label, type: f.type };
            if (f.placeholder) d.placeholder = f.placeholder;
            if (f.hint) d.hint = f.hint;
            if (f.required) d.required = true;
            return d;
        });
    }

    function captureSpecFor(kinds) {
        return normalizeCaptureKinds(kinds).map(function (k) {
            var c = CAPTURE_BY_KIND[k];
            var spec = { kind: c.kind, label: c.label, maxCount: c.maxCount, maxBytes: c.maxBytes, accept: c.accept };
            if (c.totalSeconds) spec.totalSeconds = c.totalSeconds;
            return spec;
        });
    }

    /* ── Address composition ──────────────────────────────────────────────
     * Same shape Area Canvas settled on, for the same reason: the Connection
     * Board geocodes a single string, and "4100 Camp Bowie" on its own lands
     * in the wrong state often enough to matter.
     */
    function composeAddress(loc) {
        if (!loc) return '';
        if (typeof loc === 'string') return loc.trim();
        var parts = [loc.street, loc.city, loc.state, loc.zip]
            .map(function (p) { return String(p == null ? '' : p).trim(); })
            .filter(Boolean);
        return parts.join(', ');
    }

    function _str(v) { return String(v == null ? '' : v).trim(); }

    function _iso(v) {
        if (!v) return '';
        var d = new Date(v);
        return isNaN(d.getTime()) ? '' : d.toISOString();
    }

    /* ── Entry construction ───────────────────────────────────────────────
     * One shape, whether the entry arrived from the phone relay or was typed
     * straight into VIPER at the desk. Everything the rest of the app needs
     * without knowing the schema — address, timestamps, notes, follow-up — is
     * promoted to the top level; the variable part stays in `fields`.
     *
     * `timestamp` is never blank. The Connection Board, the supervisor roll-up
     * and the entry list all sort on it, and an entry that sorts nowhere is an
     * entry the investigator cannot find again.
     */
    function makeEntry(opts) {
        var o = opts || {};
        var fields = {};
        var src = o.fields || {};
        normalizeFieldKeys(o.fieldKeys || Object.keys(src)).forEach(function (k) {
            if (k === 'location') return; // promoted below, never duplicated
            var v = src[k];
            if (FIELD_BY_KEY[k].type === 'toggle') fields[k] = v === true || v === 'true' || v === 'Yes';
            else fields[k] = _str(v);
        });

        var loc = src.location || o.location || {};
        var address = composeAddress(loc) || _str(o.address);
        var submitted = _iso(o.timestamp) || new Date().toISOString();

        var entry = {
            id: o.id != null ? o.id : Date.now(),
            preset: _str(o.preset) || 'custom',
            presetLabel: _str(o.presetLabel) || (presetById(o.preset) ? presetById(o.preset).label : 'Field Work'),
            address: address,
            street: _str(loc.street),
            city: _str(loc.city),
            state: _str(loc.state),
            zip: _str(loc.zip),
            // When the work actually happened. Falls back to the filing time
            // so a timeline never shows a gap it cannot explain.
            occurredAt: _iso(src.occurredAt) || submitted,
            // When it reached VIPER.
            timestamp: submitted,
            fields: fields,
            notes: _str(src.notes),
            followUp: fields.followUp === true,
            media: Array.isArray(o.media) ? o.media : [],
            source: _str(o.source) || 'relay'
        };
        if (o.formId) entry.relayFormId = o.formId;
        if (typeof o.manualLat === 'number' && !isNaN(o.manualLat)) entry.manualLat = o.manualLat;
        if (typeof o.manualLon === 'number' && !isNaN(o.manualLon)) entry.manualLon = o.manualLon;
        return entry;
    }

    /*
     * One line for the entry card and the Connection Board pin. Prefers the
     * fields that identify WHO or WHAT over the ones that describe context,
     * because that is what an investigator scans a list for.
     */
    function summaryLine(entry) {
        if (!entry) return '';
        var f = entry.fields || {};
        var bits = [];
        ['subject', 'personInterviewed', 'vehicle', 'itemDescription', 'activity'].forEach(function (k) {
            if (f[k]) bits.push(labelFor(k) + ': ' + f[k]);
        });
        if (!bits.length && entry.notes) bits.push(entry.notes);
        return bits.join(' — ');
    }

    /*
     * Marker colour on the case map, highest concern first. Mirrors the Area
     * Canvas ladder so a detective running both modules reads one legend.
     */
    function markerColor(entry) {
        if (!entry) return '#9ca3af';
        if (entry.followUp) return '#a855f7';
        if ((entry.media || []).length) return '#f97316';
        if (entry.fields && entry.fields.contactMade) return '#22c55e';
        return '#9ca3af';
    }

    function statusLabel(entry) {
        if (!entry) return '';
        if (entry.followUp) return 'Needs follow-up';
        if ((entry.media || []).length) return (entry.media || []).length + ' attachment' + ((entry.media || []).length === 1 ? '' : 's');
        if (entry.fields && entry.fields.contactMade) return 'Contact made';
        return 'Logged';
    }

    return {
        TYPES: TYPES,
        FIELD_PALETTE: FIELD_PALETTE,
        FIELD_BY_KEY: FIELD_BY_KEY,
        FIELD_ORDER: FIELD_ORDER,
        CAPTURE_KINDS: CAPTURE_KINDS,
        CAPTURE_BY_KIND: CAPTURE_BY_KIND,
        CAPTURE_ORDER: CAPTURE_ORDER,
        ENTRY_MAX_BYTES: ENTRY_MAX_BYTES,
        IMAGE_MAX_EDGE: IMAGE_MAX_EDGE,
        PRESETS: PRESETS,
        presetById: presetById,
        labelFor: labelFor,
        normalizeFieldKeys: normalizeFieldKeys,
        normalizeCaptureKinds: normalizeCaptureKinds,
        descriptorsFor: descriptorsFor,
        captureSpecFor: captureSpecFor,
        composeAddress: composeAddress,
        makeEntry: makeEntry,
        summaryLine: summaryLine,
        markerColor: markerColor,
        statusLabel: statusLabel
    };
}));
