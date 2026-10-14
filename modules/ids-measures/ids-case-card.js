/*
 * IDS Case Card — the "ICAC case" box and the ICAC card on Case Overview.
 *
 * Most IDS numbers come from records VIPER already keeps (suspects, warrants,
 * devices, prosecution). A few have no home anywhere else in a case file:
 * whether the investigation was reactive or proactive, referrals made to
 * other agencies, the dates it went out for evidence processing and to CVIP,
 * and children rescued or newly identified. This card is that home.
 *
 * Renderer-side, but the host page's state is NOT reachable from here (the
 * case page declares `currentCase` with a top-level `let`, which never lands
 * on `window`). So everything goes through the `host` object handed to
 * html() — closures over the page's own variables:
 *
 *   enabled()          → is Settings → ICAC Task Force Reporting on?
 *   getCase()          → the case record
 *   getTips()          → the case's imported CyberTips
 *   load()             → the icac_<caseId> record ({} when none)
 *   save(data)         → write it; return false on failure
 *   setCaseFlag(bool)  → record the officer's explicit ICAC choice
 *   toast(msg, kind)
 *
 * Event handlers are inline `onclick="IdsCaseCard.x(...)"` calls, like the
 * rest of the case page; html() remembers the last host so they can reach it.
 */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.IdsCaseCard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var HOST_ID = 'icacCardHost';
    var _host = null;

    function M() {
        var m = root && root.IdsMeasures;
        if (!m && typeof require === 'function') { try { m = require('./ids-measures.js'); } catch (_) { m = null; } }
        return m;
    }
    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return x && typeof x === 'object'; }) : []; }
    function doc() { return root && root.document; }
    function val(id) { var d = doc(); var el = d && d.getElementById(id); return el ? String(el.value || '').trim() : ''; }
    function dateOnly(v) { var s = String(v || ''); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }

    function data() {
        var d = (_host && _host.load()) || {};
        return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
    }
    function isIcac() {
        var m = M();
        if (!_host || !m) return false;
        return m.isIcacCase(_host.getCase(), _host.getTips());
    }

    // ── Rendering ──────────────────────────────────────────────────────

    function html(host) {
        _host = host || _host;
        if (!_host || !_host.enabled() || !_host.getCase()) return '';
        var c = _host.getCase();
        var icac = isIcac();
        var tips = arr(_host.getTips());
        var hasTip = !!String(c.cybertipNumber || '').trim() || tips.length > 0;
        var auto = (c.icac !== true && c.icac !== false);
        var d = data();

        var why = auto
            ? (hasTip ? 'Ticked automatically because this case has a CyberTip.' : 'Not an ICAC case unless you tick it.')
            : (c.icac ? 'You marked this an ICAC case.' : (hasTip ? 'You unticked this — its CyberTip will not be counted.' : 'You marked this as not an ICAC case.'));

        var box =
            '<div class="flex items-center gap-2 px-3 py-1.5 rounded-lg border ' +
                (icac ? 'bg-viper-purple/20 border-viper-purple/50' : 'border-gray-600 bg-viper-dark/30') +
                ' cursor-pointer transition-colors hover:opacity-90" onclick="IdsCaseCard.toggleFlag()" data-ids="flag">' +
              '<div class="w-4 h-4 rounded border-2 ' + (icac ? 'border-viper-purple text-viper-purple' : 'border-gray-600 text-transparent') +
                ' flex items-center justify-center flex-shrink-0">' +
                (icac ? '<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>' : '') +
              '</div>' +
              '<span class="text-xs font-medium ' + (icac ? 'text-viper-purple' : 'text-gray-400') + ' whitespace-nowrap">ICAC case</span>' +
            '</div>';

        var body = '';
        if (icac) body = cardBody(d, hasTip);

        return '<div id="' + HOST_ID + '" class="col-span-2 mt-2 pt-4 border-t border-gray-700/50" data-ids="card">' +
            '<label class="text-sm text-gray-400 flex items-center gap-1.5 mb-3">' +
              '<svg class="w-4 h-4 text-viper-purple" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>' +
              'ICAC Reporting (IDS)' +
            '</label>' +
            '<div class="flex flex-wrap items-center gap-3">' + box +
              '<span class="text-xs text-gray-500">' + esc(why) + '</span>' +
            '</div>' +
            body +
        '</div>';
    }

    var INPUT = 'px-2 py-1 bg-viper-dark border border-gray-600 rounded text-xs text-white focus:border-viper-purple outline-none';
    var BTN = 'px-2.5 py-1 rounded-lg text-xs font-medium bg-viper-purple/20 text-viper-purple border border-viper-purple/40 hover:bg-viper-purple/30 transition';
    var DEL = 'text-gray-500 hover:text-red-400 text-xs px-1';

    function cardBody(d, hasTip) {
        var m = M();
        var fmt = m ? m.fmtDate : function (x) { return x; };
        var type = String(d.investigationType || '');
        var typeHint = (!type && hasTip) ? '<span class="text-[11px] text-gray-500">Counted as reactive (it has a CyberTip) until you choose.</span>'
                     : (!type ? '<span class="text-[11px] text-amber-400">Choose one — IDS counts every new investigation as reactive or proactive.</span>' : '');

        var refRows = arr(d.referrals).map(function (r, i) {
            return '<div class="flex items-center gap-2 text-xs text-gray-300" data-ids="referral">' +
                '<span class="text-gray-400 w-20">' + esc(fmt(r.date) || 'no date') + '</span>' +
                '<span class="px-1.5 py-0.5 rounded bg-gray-700/60 border border-gray-600">' + (r.venue === 'federal' ? 'Federal' : 'State / Local') + '</span>' +
                '<span class="flex-1 truncate">' + esc(r.agency || '') + '</span>' +
                '<button type="button" class="' + DEL + '" title="Remove" onclick="IdsCaseCard.removeReferral(' + i + ')">✕</button>' +
            '</div>';
        }).join('');

        var vicLabel = {};
        (m ? m.VICTIM_KINDS : []).forEach(function (k) { vicLabel[k.value] = k.label; });
        var vicRows = arr(d.victims).map(function (v, i) {
            return '<div class="flex items-center gap-2 text-xs text-gray-300" data-ids="victim">' +
                '<span class="text-gray-400 w-20">' + esc(fmt(v.date) || 'no date') + '</span>' +
                '<span class="font-semibold text-white w-6 text-right">' + esc(v.count || 1) + '</span>' +
                '<span class="flex-1">' + esc(vicLabel[v.kind] || v.kind || '') + '</span>' +
                '<button type="button" class="' + DEL + '" title="Remove" onclick="IdsCaseCard.removeVictim(' + i + ')">✕</button>' +
            '</div>';
        }).join('');

        var vicOpts = (m ? m.VICTIM_KINDS : []).map(function (k) {
            return '<option value="' + esc(k.value) + '">' + esc(k.label) + '</option>';
        }).join('');

        return '' +
        '<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">' +
          '<div class="space-y-2">' +
            '<div class="flex flex-wrap items-center gap-2">' +
              '<span class="text-xs text-gray-400 w-40">Investigation type</span>' +
              '<select class="' + INPUT + '" onchange="IdsCaseCard.setField(\'investigationType\', this.value)" data-ids="type">' +
                '<option value=""' + (type ? '' : ' selected') + '>— Not set —</option>' +
                '<option value="reactive"' + (type === 'reactive' ? ' selected' : '') + '>Reactive</option>' +
                '<option value="proactive"' + (type === 'proactive' ? ' selected' : '') + '>Proactive</option>' +
              '</select>' + typeHint +
            '</div>' +
            '<div class="flex flex-wrap items-center gap-2">' +
              '<span class="text-xs text-gray-400 w-40">Sent for evidence processing</span>' +
              '<input type="date" class="' + INPUT + '" value="' + esc(dateOnly(d.evidenceNeededDate)) + '" onchange="IdsCaseCard.setField(\'evidenceNeededDate\', this.value)" data-ids="evidence">' +
            '</div>' +
            '<div class="flex flex-wrap items-center gap-2">' +
              '<span class="text-xs text-gray-400 w-40">Submitted to CVIP</span>' +
              '<input type="date" class="' + INPUT + '" value="' + esc(dateOnly(d.cvipSubmittedDate)) + '" onchange="IdsCaseCard.setField(\'cvipSubmittedDate\', this.value)" data-ids="cvip">' +
            '</div>' +
          '</div>' +
          '<div class="space-y-4">' +
            '<div>' +
              '<div class="text-xs text-gray-400 mb-1.5">Case referrals made to another agency</div>' +
              '<div class="space-y-1 mb-2">' + (refRows || '<div class="text-[11px] text-gray-600 italic">None</div>') + '</div>' +
              '<div class="flex flex-wrap items-center gap-1.5">' +
                '<input type="date" id="idsRefDate" class="' + INPUT + '">' +
                '<select id="idsRefVenue" class="' + INPUT + '"><option value="state">State / Local</option><option value="federal">Federal</option></select>' +
                '<input type="text" id="idsRefAgency" maxlength="80" placeholder="Agency" class="' + INPUT + ' w-32">' +
                '<button type="button" class="' + BTN + '" onclick="IdsCaseCard.addReferral()">Add</button>' +
              '</div>' +
            '</div>' +
            '<div>' +
              '<div class="text-xs text-gray-400 mb-1.5">Child victims rescued / identified</div>' +
              '<div class="space-y-1 mb-2">' + (vicRows || '<div class="text-[11px] text-gray-600 italic">None</div>') + '</div>' +
              '<div class="flex flex-wrap items-center gap-1.5">' +
                '<input type="date" id="idsVicDate" class="' + INPUT + '">' +
                '<input type="number" id="idsVicCount" min="1" value="1" class="' + INPUT + ' w-14">' +
                '<select id="idsVicKind" class="' + INPUT + '">' + vicOpts + '</select>' +
                '<button type="button" class="' + BTN + '" onclick="IdsCaseCard.addVictim()">Add</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<p class="text-[11px] text-gray-500 mt-3">Arrests, warrants, prosecution and forensic exams are counted from their own tabs — nothing needs entering twice here.</p>';
    }

    // ── Actions ────────────────────────────────────────────────────────

    function repaint() {
        var d = doc();
        var el = d && d.getElementById(HOST_ID);
        if (el) el.outerHTML = html();
    }
    function commit(next) {
        if (!_host) return false;
        var ok = _host.save(next) !== false;
        if (!ok) { if (_host.toast) _host.toast('Could not save the ICAC details — nothing was changed.', 'error'); return false; }
        repaint();
        return true;
    }

    function toggleFlag() {
        if (!_host) return;
        var now = isIcac();
        // The host toasts its own failure (saveCase does); just don't repaint
        // a state that was not stored.
        if (_host.setCaseFlag(!now) === false) return;
        repaint();
    }
    function setField(key, value) {
        if (['investigationType', 'evidenceNeededDate', 'cvipSubmittedDate'].indexOf(key) === -1) return;
        var d = Object.assign({}, data());
        var v = String(value || '').trim();
        if (key === 'investigationType') v = (v === 'reactive' || v === 'proactive') ? v : '';
        else v = dateOnly(v);
        if (v) d[key] = v; else delete d[key];
        commit(d);
    }
    function addReferral() {
        var date = dateOnly(val('idsRefDate'));
        if (!date) { if (_host && _host.toast) _host.toast('Enter the date the case was referred.', 'warning'); return; }
        var d = Object.assign({}, data());
        d.referrals = arr(d.referrals).concat([{
            date: date,
            venue: val('idsRefVenue') === 'federal' ? 'federal' : 'state',
            agency: val('idsRefAgency').slice(0, 80)
        }]);
        commit(d);
    }
    function removeReferral(i) {
        var d = Object.assign({}, data());
        var list = arr(d.referrals);
        if (!(i >= 0 && i < list.length)) return;
        list.splice(i, 1);
        d.referrals = list;
        commit(d);
    }
    function addVictim() {
        var date = dateOnly(val('idsVicDate'));
        if (!date) { if (_host && _host.toast) _host.toast('Enter the date for this entry.', 'warning'); return; }
        var n = parseInt(val('idsVicCount'), 10);
        if (!(n >= 1)) n = 1;
        var kind = val('idsVicKind');
        var known = (M() ? M().VICTIM_KINDS : []).some(function (k) { return k.value === kind; });
        if (!known) return;
        var d = Object.assign({}, data());
        d.victims = arr(d.victims).concat([{ date: date, kind: kind, count: n }]);
        commit(d);
    }
    function removeVictim(i) {
        var d = Object.assign({}, data());
        var list = arr(d.victims);
        if (!(i >= 0 && i < list.length)) return;
        list.splice(i, 1);
        d.victims = list;
        commit(d);
    }

    return {
        html: html,
        toggleFlag: toggleFlag,
        setField: setField,
        addReferral: addReferral,
        removeReferral: removeReferral,
        addVictim: addVictim,
        removeVictim: removeVictim,
        _setHost: function (h) { _host = h; }
    };
}));
