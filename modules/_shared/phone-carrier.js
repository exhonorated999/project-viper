/*
 * phone-carrier.js — the optional service-provider ("carrier") on a phone
 * identifier. RENDERER-side (loaded by a <script> tag in
 * case-detail-with-analytics.html); also loadable in plain Node for tests.
 *
 * Why a separate `carrier` field and not `provider`:
 *   `ident.provider` already means "ISP" — the ARIN lookup writes it for IP
 *   identifiers and every view labels it "ISP: …". A phone carrier is a
 *   different fact and is typed by the officer, not looked up.
 *
 * Legacy data: the CargoNet import (index.html) used to put the driver's
 *   phone carrier into `provider`, so those phones rendered "ISP: Verizon".
 *   carrierOf() therefore reads `provider` as the carrier on a PHONE only,
 *   and setCarrier() moves it across the first time the carrier is edited.
 *
 * The suggestion list is a convenience, never a constraint: the field is
 * free text (an <input list=…> backed by a <datalist>), because the real
 * answer is often an MVNO or a VoIP provider nobody thought to list.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.PhoneCarrier = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var MAX_LEN = 60;
    var DATALIST_ID = 'viperPhoneCarriers';

    // Big three first (what the officer asked for), then the prepaid and
    // cable brands, then the VoIP / app-number providers that turn up
    // constantly in ICAC and fraud work.
    var SUGGESTIONS = Object.freeze([
        'AT&T', 'Verizon', 'T-Mobile',
        'US Cellular', 'Cricket Wireless', 'Metro by T-Mobile', 'Boost Mobile',
        'Visible', 'Mint Mobile', 'Straight Talk', 'TracFone', 'Total Wireless',
        'Consumer Cellular', 'Google Fi', 'Spectrum Mobile', 'Xfinity Mobile',
        'Google Voice', 'TextNow', 'TextFree (Pinger)', 'Bandwidth.com',
        'Twilio', 'Onvoy / Inteliquent', 'Peerless Network'
    ]);

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function normalize(v) {
        if (v == null) return '';
        return String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_LEN).trim();
    }

    function isPhone(ident) {
        return !!ident && String(ident.type || '').toLowerCase() === 'phone';
    }

    // The carrier to SHOW for an identifier. Only phones have one.
    function carrierOf(ident) {
        if (!isPhone(ident)) return '';
        return normalize(ident.carrier) || normalize(ident.provider);
    }

    // The ISP to show. On a phone, `provider` is a legacy carrier (above),
    // so it must never be labelled "ISP".
    function ispOf(ident) {
        if (!ident || isPhone(ident)) return '';
        return normalize(ident.provider);
    }

    // Write (or clear, with '' / null) a phone's carrier. Mutates and
    // returns `ident`. Clears a legacy carrier parked in `provider`, so an
    // officer who erases the carrier does not see the old one reappear.
    function setCarrier(ident, value) {
        if (!ident) return ident;
        var v = normalize(value);
        if (v) ident.carrier = v; else delete ident.carrier;
        if (isPhone(ident)) ident.provider = '';
        return ident;
    }

    // One plain-text label for reports/exports: "Carrier: X", "ISP: X" or ''.
    function describe(ident) {
        var c = carrierOf(ident);
        if (c) return 'Carrier: ' + c;
        var i = ispOf(ident);
        return i ? 'ISP: ' + i : '';
    }

    // On-screen badge. `opts.onclick` is HOST-authored JS (never user data);
    // when given, the badge is a button that opens the carrier editor, and a
    // phone with no carrier gets a small "+ Carrier" button instead.
    function badgeHtml(ident, opts) {
        opts = opts || {};
        if (!isPhone(ident)) return '';
        var size = opts.small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs';
        var c = carrierOf(ident);
        var click = opts.onclick ? ' onclick="' + esc(opts.onclick) + '"' : '';
        if (c) {
            var label = '📶 ' + esc(c) + (opts.onclick ? ' <span class="opacity-60">✎</span>' : '');
            var cls = 'pc-badge rounded ' + size + ' bg-sky-500/20 text-sky-300 border border-sky-500/40';
            return opts.onclick
                ? '<button type="button" class="' + cls + ' hover:bg-sky-500/30 transition" title="Carrier: ' + esc(c) + ' — click to change"' + click + '>' + label + '</button>'
                : '<span class="' + cls + '" title="Carrier">' + label + '</span>';
        }
        if (!opts.onclick) return '';
        return '<button type="button" class="pc-add rounded ' + size + ' border border-dashed border-gray-500 text-gray-400 hover:text-sky-300 hover:border-sky-500/60 transition" title="Add the phone carrier (optional)"' + click + '>+ Carrier</button>';
    }

    function datalistHtml(id) {
        return '<datalist id="' + esc(id || DATALIST_ID) + '">' +
            SUGGESTIONS.map(function (s) { return '<option value="' + esc(s) + '"></option>'; }).join('') +
            '</datalist>';
    }

    // Idempotently put ONE shared <datalist> on the page so every carrier
    // input can say list="viperPhoneCarriers".
    function ensureDatalist(doc) {
        doc = doc || (typeof document !== 'undefined' ? document : null);
        if (!doc || !doc.body || typeof doc.getElementById !== 'function') return false;
        if (doc.getElementById(DATALIST_ID)) return true;
        var wrap = doc.createElement('div');
        wrap.innerHTML = datalistHtml(DATALIST_ID);
        var dl = wrap.firstChild;
        if (!dl) return false;
        doc.body.appendChild(dl);
        return true;
    }

    // Show/hide the Platform and Carrier rows of an Add Identifier form when
    // its type <select> changes. Rows are found by data attribute inside the
    // select's own form, so two modals never fight over a shared id.
    function syncTypeRows(selectEl) {
        if (!selectEl) return;
        var scope = selectEl.form || selectEl.closest && selectEl.closest('form,[data-ident-row]') || null;
        if (!scope || typeof scope.querySelector !== 'function') return;
        var t = String(selectEl.value || '');
        var plat = scope.querySelector('[data-ident-platform-row]');
        var carr = scope.querySelector('[data-ident-carrier-row]');
        if (plat) plat.style.display = t === 'username' ? '' : 'none';
        if (carr) carr.style.display = t === 'phone' ? '' : 'none';
    }

    // Same, for one row of the suspect edit form (select + value + carrier).
    function syncRow(selectEl) {
        if (!selectEl || typeof selectEl.closest !== 'function') return;
        var row = selectEl.closest('[data-ident-row]');
        if (!row) return;
        var carr = row.querySelector('.ident-carrier');
        if (carr) carr.style.display = String(selectEl.value || '') === 'phone' ? '' : 'none';
    }

    // Build a fresh identifier from an Add Identifier form's values.
    function buildIdentifier(type, value, extra) {
        extra = extra || {};
        var ident = { type: type, value: value, provider: '' };
        if (type === 'username') {
            var platform = normalize(extra.platform);
            if (platform) ident.platform = platform;
        }
        if (type === 'phone') setCarrier(ident, extra.carrier);
        return ident;
    }

    // The suspect EDIT form rebuilds the identifier list from its rows.
    // It used to build each one from scratch — `{type, value, provider:''}`
    // — which silently threw away the platform, ISP, OSINT leads and email
    // check on every save. This keeps everything a row did not change.
    //
    // rows: [{ orig: <index into originals> | null, type, value, carrier? }]
    //   carrier === undefined means "this row has no carrier input" — keep it.
    function mergeEditedIdentifiers(originals, rows) {
        var src = Array.isArray(originals) ? originals : [];
        var out = [];
        (Array.isArray(rows) ? rows : []).forEach(function (row) {
            if (!row) return;
            var type = String(row.type || '');
            var value = String(row.value == null ? '' : row.value).trim();
            if (!type || !value) return;
            var o = (row.orig != null && row.orig !== '' && src[Number(row.orig)]) || null;
            var ident;
            if (o && typeof o === 'object') {
                ident = JSON.parse(JSON.stringify(o));
                if (ident.type !== type || String(ident.value || '').trim() !== value) {
                    // A different identifier now: results computed for the
                    // old one would be misattributed. Officer-typed labels
                    // survive only where they still make sense.
                    delete ident.osint;
                    delete ident.emailResult;
                    ident.provider = '';
                    if (type !== 'username') delete ident.platform;
                }
                ident.type = type;
                ident.value = value;
            } else {
                ident = { type: type, value: value, provider: '' };
            }
            if (type === 'phone') {
                if (row.carrier !== undefined) setCarrier(ident, row.carrier);
                else if (!ident.carrier && ident.provider) setCarrier(ident, ident.provider);
            } else {
                delete ident.carrier;
            }
            out.push(ident);
        });
        return out;
    }

    if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        if (document.body) ensureDatalist(document);
        else document.addEventListener('DOMContentLoaded', function () { ensureDatalist(document); });
    }

    return {
        MAX_LEN: MAX_LEN,
        DATALIST_ID: DATALIST_ID,
        SUGGESTIONS: SUGGESTIONS,
        normalize: normalize,
        isPhone: isPhone,
        carrierOf: carrierOf,
        ispOf: ispOf,
        setCarrier: setCarrier,
        describe: describe,
        badgeHtml: badgeHtml,
        datalistHtml: datalistHtml,
        ensureDatalist: ensureDatalist,
        syncTypeRows: syncTypeRows,
        syncRow: syncRow,
        buildIdentifier: buildIdentifier,
        mergeEditedIdentifiers: mergeEditedIdentifiers
    };
}));
