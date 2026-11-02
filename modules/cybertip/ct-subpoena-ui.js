/* ============================================================
   CyberTip "Subpoena list" — modal for case-detail-with-analytics.
   window.CTSubpoenaUI:
     open({scope, addresses})  scope 'tip' (the open tip) | 'case'
     openFor(el)               from an IP card (reads data-ct-ip)
     openSelected()            from the Identifiers bar: ticked IPs,
                               or every public IP when none is ticked
     cardButton() / barButton() / panelButton(scope)   button HTML
   Uses window.CyberTipSubpoena (model) and the Evidence / logo helpers
   exported by ct-ip-report-ui.js.
   ============================================================ */
(function () {
    'use strict';
    var M = function () { return window.CyberTipSubpoena; };
    var H = function () { return window.CTIpReportUI || {}; };
    var OPTS_KEY = 'viperCtSubpoenaOpts';
    var PREVIEW_LINES = 16;
    var S = null;          // modal state while open
    var busy = false;

    function toast(msg, type) {
        try { if (typeof showToast === 'function') return showToast(msg, type || 'info'); } catch (_) {}
        try { if (typeof window.viperToast === 'function') return window.viperToast(msg, type || 'info'); } catch (_) {}
        console.log('[CT subpoena]', msg);
    }
    function esc(s) { return M() ? M().esc(s) : String(s == null ? '' : s); }
    function theCase() { try { return (typeof currentCase !== 'undefined' && currentCase) || null; } catch (_) { return null; } }
    function allTips() { try { return (typeof getCyberTips === 'function' ? getCyberTips() : []) || []; } catch (_) { return []; } }
    function viewIdx() { try { return typeof currentCyberTipView !== 'undefined' ? currentCyberTipView : null; } catch (_) { return null; } }
    function tipsFor(scope) {
        var tips = allTips();
        if (scope === 'case') return tips;
        var t = tips[viewIdx()];
        return t ? [t] : [];
    }
    function loadOpts() {
        var d = { merge: true, onePerPage: true, showCase: true, showTips: false, showActivity: true, request: '' };
        try { var o = JSON.parse(localStorage.getItem(OPTS_KEY) || '{}'); if (o && typeof o === 'object') Object.assign(d, o); } catch (_) {}
        if (typeof d.request !== 'string' || !d.request.trim()) d.request = M() ? M().DEFAULT_REQUEST : '';
        return d;
    }
    function saveOpts() {
        if (!S) return;
        try { localStorage.setItem(OPTS_KEY, JSON.stringify({ merge: S.merge, onePerPage: S.onePerPage, showCase: S.showCase, showTips: S.showTips, showActivity: S.showActivity, request: S.request })); } catch (_) {}
    }

    var ICON = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6M9 8h2m-5 13h12a2 2 0 002-2V7l-5-5H6a2 2 0 00-2 2v15a2 2 0 002 2z"/></svg>';
    function cardButton() {
        return '<button type="button" onclick="CTSubpoenaUI.openFor(this)" class="px-2.5 py-1 text-xs bg-purple-500/15 text-purple-300 rounded border border-purple-500/40 hover:bg-purple-500/25 transition-colors flex items-center gap-1" title="Every date and time this IP was used, without file names: a list to attach to a subpoena for the provider">' + ICON + 'Subpoena list</button>';
    }
    function barButton() {
        return '<button type="button" onclick="CTSubpoenaUI.openSelected()" class="ml-1 px-2.5 py-1 bg-purple-500/15 text-purple-300 rounded border border-purple-500/40 hover:bg-purple-500/25 transition-colors flex items-center gap-1" title="Dates and times for the ticked IPs (or every IP), without file names">' + ICON + 'Subpoena list\u2026</button>';
    }
    function panelButton(scope) {
        return '<button type="button" onclick="CTSubpoenaUI.open({scope:\'' + (scope === 'case' ? 'case' : 'tip') + '\'})" class="px-3 py-1.5 text-xs rounded border transition-colors flex items-center gap-1.5 bg-purple-500/15 text-purple-300 border-purple-500/40 hover:bg-purple-500/25" title="Dates and times per IP, without file names, to attach to a subpoena">' + ICON + 'Subpoena list\u2026</button>';
    }

    function openFor(el) {
        var card = el && el.closest ? el.closest('[data-ct-ip]') : null;
        var addr = card ? card.getAttribute('data-ct-ip') : '';
        open({ scope: 'tip', addresses: addr ? [addr] : null });
    }
    function openSelected() {
        var picked = [];
        document.querySelectorAll('.ct-sel[data-ct-kind="ip"]').forEach(function (cb) {
            if (!cb.checked) return;
            var card = cb.closest('[data-ct-ip]');
            var a = card && card.getAttribute('data-ct-ip');
            if (a && picked.indexOf(a) < 0) picked.push(a);
        });
        open({ scope: 'tip', addresses: picked.length ? picked : null });
    }

    function open(opts) {
        opts = opts || {};
        if (!M()) { toast('The subpoena list module did not load.', 'error'); return; }
        var scope = opts.scope === 'case' ? 'case' : 'tip';
        var tips = tipsFor(scope);
        if (!tips.length) { toast('No CyberTip to build a list from.', 'warning'); return; }
        var cands = M().candidates(tips);
        if (!cands.length) { toast('No IP addresses in ' + (scope === 'case' ? 'these tips' : 'this tip') + '.', 'warning'); return; }
        var want = Array.isArray(opts.addresses) && opts.addresses.length ? opts.addresses.map(function (a) { return String(a).trim().toLowerCase(); }) : null;
        var sel = new Set();
        cands.forEach(function (c) {
            var k = c.address.toLowerCase();
            if (want ? want.indexOf(k) >= 0 : !c.private) sel.add(k);
        });
        var o = loadOpts();
        S = {
            scope: scope, tips: tips, cands: cands, sel: sel,
            kinds: { upload: true, login: true, other: true },
            merge: !!o.merge, onePerPage: !!o.onePerPage, showCase: !!o.showCase, showTips: !!o.showTips, showActivity: o.showActivity !== false, request: o.request,
            single: !!(want && want.length === 1)
        };
        mount();
        paint();
    }

    function model() {
        if (!S) return null;
        var addrs = S.cands.filter(function (c) { return S.sel.has(c.address.toLowerCase()); }).map(function (c) { return c.address; });
        return M().build(S.tips, { addresses: addrs, kinds: S.kinds, merge: S.merge, showActivity: S.showActivity });
    }

    function overlay() { return document.getElementById('ctSubpModal'); }
    function mount() {
        var old = overlay(); if (old) old.remove();
        var el = document.createElement('div');
        el.id = 'ctSubpModal';
        el.style.cssText = 'position:fixed;inset:0;z-index:99996;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:24px;color-scheme:dark';
        el.innerHTML = '<div class="ct-subp-box glass-card rounded-xl border border-gray-700/60 w-full flex flex-col" style="max-width:860px;max-height:92vh;background:rgba(13,17,23,.97)"></div>';
        el.addEventListener('click', onClick);
        el.addEventListener('change', onChange);
        el.addEventListener('input', onInput);
        el.addEventListener('mousedown', function (e) { if (e.target === el) el._down = true; });
        el.addEventListener('mouseup', function (e) { if (e.target === el && el._down) close(); el._down = false; });
        document.body.appendChild(el);
        window.addEventListener('keydown', onKey, true);
    }
    function close() {
        var el = overlay(); if (el) el.remove();
        window.removeEventListener('keydown', onKey, true);
        S = null;
    }
    function onKey(e) {
        if (e.key === 'Escape' && overlay()) { e.stopPropagation(); e.preventDefault(); close(); }
    }

    function chip(txt, cls) { return '<span class="text-[11px] px-1.5 py-0.5 rounded border ' + cls + '">' + esc(txt) + '</span>'; }
    function check(name, on, label, title) {
        return '<label class="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
            '<input type="checkbox" data-opt="' + name + '"' + (on ? ' checked' : '') + ' class="w-4 h-4 rounded accent-purple-400">' + label + '</label>';
    }

    function paint() {
        var box = overlay() && overlay().querySelector('.ct-subp-box');
        if (!box || !S) return;
        var mdl = model();
        var present = { upload: 0, login: 0, other: 0 };
        S.cands.forEach(function (c) { present.upload += c.uploads; present.login += c.logins; present.other += c.other; });

        var list = S.cands.map(function (c) {
            var k = c.address.toLowerCase();
            var parts = [];
            if (c.uploads) parts.push(chip(c.uploads + ' upload' + (c.uploads === 1 ? '' : 's'), 'bg-amber-500/15 text-amber-300 border-amber-500/40'));
            if (c.logins) parts.push(chip(c.logins + ' login' + (c.logins === 1 ? '' : 's'), 'bg-red-500/15 text-red-300 border-red-500/40'));
            if (c.other) parts.push(chip(c.other + ' other', 'bg-blue-500/15 text-blue-300 border-blue-500/40'));
            if (c.private) parts.push(chip('private address', 'bg-gray-500/20 text-gray-300 border-gray-500/40'));
            return '<label class="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-white/5 cursor-pointer">' +
                '<input type="checkbox" data-ip="' + esc(k) + '"' + (S.sel.has(k) ? ' checked' : '') + ' class="w-4 h-4 rounded accent-purple-400">' +
                '<span class="font-mono text-sm text-white break-all">' + esc(c.address) + '</span>' + parts.join('') +
                '<span class="ml-auto text-xs ' + (c.provider ? 'text-green-400' : 'text-gray-500 italic') + ' text-right">' + esc(c.provider || (c.private ? '' : 'provider not looked up')) + '</span>' +
            '</label>';
        }).join('');

        var kindBoxes = [
            present.upload ? check('k:upload', S.kinds.upload, 'Uploads') : '',
            present.login ? check('k:login', S.kinds.login, 'Logins') : '',
            present.other ? check('k:other', S.kinds.other, 'Other activity (check-ins, registrations\u2026)') : ''
        ].join('');

        var T = mdl.totals;
        var warn = [];
        if (T.noProvider) warn.push(T.noProvider + ' of the chosen IPs ' + (T.noProvider === 1 ? 'has' : 'have') + ' no provider yet. Use ARIN Lookup on the IP card to add it.');
        var nz = mdl.ips.some(function (g) { return !g.zones.length && g.rows.some(function (r) { return r.time; }); });
        if (nz) warn.push('The report gives no time zone for some times. Check the original report before serving the subpoena.');
        var noPort = mdl.ips.filter(function (g) { return !g.hasPort; }).length;
        if (mdl.ips.length && noPort === mdl.ips.length && T.lines) warn.push('No port numbers are listed. Mobile and shared (CGNAT) providers often need the port as well as the time to find a subscriber.');

        var preview = T.lines ? M().text(mdl, { request: '' }).split(/\r?\n/) : [];
        var more = preview.length > PREVIEW_LINES ? preview.length - PREVIEW_LINES : 0;
        var c = theCase() || {};
        var keep = {};
        ['ct-subp-scroll', 'ct-subp-list'].forEach(function (cls) { var x = box.querySelector('.' + cls); if (x) keep[cls] = x.scrollTop; });

        box.innerHTML =
            '<div class="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-gray-700/60">' +
                '<div><h3 class="text-lg font-bold text-white">Subpoena list: IP dates and times</h3>' +
                '<div class="text-xs text-gray-400 mt-0.5">Every date and time each IP was used, oldest first. No file names, hashes or people. Times are copied as the ESP reported them.</div></div>' +
                '<button type="button" data-act="close" class="text-gray-400 hover:text-white text-xl leading-none px-1" title="Close (Esc)">\u00d7</button>' +
            '</div>' +
            '<div class="ct-subp-scroll overflow-y-auto px-5 py-4 space-y-4" style="min-height:0">' +
                '<div>' +
                    '<div class="flex items-center gap-2 mb-1"><span class="text-xs font-semibold text-gray-300 uppercase tracking-wide">IP addresses</span>' +
                        '<span class="text-xs text-gray-500">' + S.sel.size + ' of ' + S.cands.length + ' chosen</span>' +
                        (S.cands.length > 1 ? '<button type="button" data-act="all" class="ml-auto text-xs text-viper-cyan hover:underline">All</button><button type="button" data-act="none" class="text-xs text-viper-cyan hover:underline">None</button>' : '') +
                    '</div>' +
                    '<div class="ct-subp-list rounded-lg border border-gray-700/50 bg-black/20 p-1 overflow-y-auto" style="max-height:200px">' + list + '</div>' +
                '</div>' +
                '<div class="grid gap-4" style="grid-template-columns:1fr 1fr">' +
                    '<div class="space-y-1.5"><div class="text-xs font-semibold text-gray-300 uppercase tracking-wide">Include</div>' + kindBoxes +
                        '<div class="pt-1.5 mt-1 border-t border-gray-700/50">' +
                            check('showActivity', S.showActivity, 'Say whether each line was an upload or a login', 'Off: the provider sees only the dates, times and ports, with no activity column and no upload/login counts') +
                            '<div class="text-[11px] text-gray-500 pl-6 mt-0.5">' + (S.showActivity ? 'Each line is labelled Upload, Login, etc.' : 'Dates, times and ports only. The provider is not told which lines were uploads.') + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="space-y-1.5"><div class="text-xs font-semibold text-gray-300 uppercase tracking-wide">Layout</div>' +
                        check('merge', S.merge, 'One line per date and time', 'Several files uploaded in the same second become one line with a count') +
                        check('onePerPage', S.onePerPage, 'Start each IP on a new page', 'Lets you attach each page to the subpoena for that IP\u2019s provider') +
                        check('showCase', S.showCase, 'Show the case number' + (c.caseNumber ? ' (' + esc(c.caseNumber) + ')' : '')) +
                        check('showTips', S.showTips, 'Show the CyberTip number and ESP name', 'Off by default: the provider receiving the subpoena does not need to know where the lead came from') +
                    '</div>' +
                '</div>' +
                '<div><div class="text-xs font-semibold text-gray-300 uppercase tracking-wide mb-1">Request line <span class="font-normal normal-case text-gray-500">(printed at the top of the PDF and the copied text; leave empty for none)</span></div>' +
                    '<textarea data-opt="request" rows="2" class="w-full text-sm rounded border border-gray-600 bg-gray-900/80 text-gray-200 px-2.5 py-1.5 focus:outline-none focus:border-purple-400/60" style="color-scheme:dark;resize:vertical">' + esc(S.request) + '</textarea>' +
                    '<div class="flex justify-end"><button type="button" data-act="reset-req" class="text-[11px] text-gray-400 hover:text-white">Reset to the default wording</button></div>' +
                '</div>' +
                (warn.length ? '<div class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 space-y-1">' + warn.map(function (w) { return '<div>' + esc(w) + '</div>'; }).join('') + '</div>' : '') +
                '<div><div class="text-xs font-semibold text-gray-300 uppercase tracking-wide mb-1">Preview <span class="font-normal normal-case text-gray-500">' +
                    esc(T.ips + ' IP' + (T.ips === 1 ? '' : 's') + ' \u00b7 ' + T.lines + ' line' + (T.lines === 1 ? '' : 's') + (T.entries !== T.lines ? ' from ' + T.entries + ' entries' : '')) + '</span></div>' +
                    (T.lines
                        ? '<pre class="ct-subp-preview text-[11px] leading-snug text-gray-200 bg-black/40 border border-gray-700/50 rounded p-2.5 overflow-x-auto whitespace-pre">' + esc(preview.slice(0, PREVIEW_LINES).join('\n')) + (more ? '\n\u2026 ' + more + ' more line' + (more === 1 ? '' : 's') : '') + '</pre>'
                        : '<div class="text-sm text-gray-400 py-3">Nothing to list. Choose at least one IP and one kind of activity.</div>') +
                '</div>' +
            '</div>' +
            '<div class="flex items-center gap-2 flex-wrap px-5 py-3 border-t border-gray-700/60">' +
                '<button type="button" data-act="pdf-ev" data-busy class="px-3 py-1.5 text-xs rounded border bg-viper-orange/20 text-viper-orange border-viper-orange/50 hover:bg-viper-orange/30"' + (T.lines ? '' : ' disabled') + '>Save PDF to Evidence</button>' +
                '<button type="button" data-act="pdf" data-busy class="px-3 py-1.5 text-xs rounded border bg-viper-cyan/10 text-viper-cyan border-viper-cyan/40 hover:bg-viper-cyan/20"' + (T.lines ? '' : ' disabled') + '>Save PDF copy\u2026</button>' +
                '<button type="button" data-act="csv" data-busy class="px-3 py-1.5 text-xs rounded border border-gray-600 text-gray-300 hover:text-white hover:border-gray-400"' + (T.lines ? '' : ' disabled') + '>Spreadsheet (CSV)</button>' +
                '<button type="button" data-act="copy" class="px-3 py-1.5 text-xs rounded border border-gray-600 text-gray-300 hover:text-white hover:border-gray-400"' + (T.lines ? '' : ' disabled') + ' title="Plain text to paste into the subpoena">Copy as text</button>' +
                '<button type="button" data-act="close" class="ml-auto px-3 py-1.5 text-xs rounded border border-gray-600 text-gray-300 hover:text-white">Close</button>' +
            '</div>';
        Object.keys(keep).forEach(function (cls) { var x = box.querySelector('.' + cls); if (x) x.scrollTop = keep[cls]; });
    }

    function onClick(e) {
        var b = e.target.closest ? e.target.closest('[data-act]') : null;
        if (!b || !S || b.disabled) return;
        var act = b.getAttribute('data-act');
        if (act === 'close') return close();
        if (act === 'all' || act === 'none') {
            S.sel = new Set();
            if (act === 'all') S.cands.forEach(function (c) { S.sel.add(c.address.toLowerCase()); });
            return paint();
        }
        if (act === 'reset-req') { S.request = M().DEFAULT_REQUEST; saveOpts(); return paint(); }
        if (act === 'copy') return copyText();
        if (act === 'csv') return saveCsv();
        if (act === 'pdf' || act === 'pdf-ev') return savePdf(act === 'pdf-ev');
    }
    function onChange(e) {
        var t = e.target;
        if (!S || !t) return;
        var ip = t.getAttribute('data-ip');
        if (ip) { if (t.checked) S.sel.add(ip); else S.sel.delete(ip); return paint(); }
        var opt = t.getAttribute('data-opt');
        if (!opt || opt === 'request') return;
        if (opt.indexOf('k:') === 0) S.kinds[opt.slice(2)] = !!t.checked;
        else S[opt] = !!t.checked;
        saveOpts();
        paint();
    }
    function onInput(e) {
        var t = e.target;
        if (S && t && t.getAttribute('data-opt') === 'request') { S.request = t.value; saveOpts(); }
    }

    function setBusy(on, label) {
        busy = !!on;
        var el = overlay(); if (!el) return;
        el.querySelectorAll('[data-busy]').forEach(function (b) {
            b.disabled = !!on;
            b.style.opacity = on ? '0.5' : '';
        });
        var ev = el.querySelector('[data-act="pdf-ev"]');
        if (ev) { if (!ev._label) ev._label = ev.textContent; ev.textContent = on && label ? label : ev._label; }
    }

    function meta(mdl) {
        var c = theCase() || {};
        var now = new Date();
        var day = H().localDay ? H().localDay(now) : now.toISOString().slice(0, 10);
        return {
            caseNumber: c.caseNumber || '', showCase: S.showCase, showTips: S.showTips, onePerPage: S.onePerPage,
            request: String(S.request || '').trim(), generated: now.toLocaleString(), day: day
        };
    }

    function copyText() {
        var mdl = model();
        var txt = M().text(mdl, { request: String(S.request || '').trim() });
        var done = function () { toast('Copied ' + mdl.totals.lines + ' line' + (mdl.totals.lines === 1 ? '' : 's') + ' for ' + mdl.totals.ips + ' IP' + (mdl.totals.ips === 1 ? '' : 's') + '.', 'success'); };
        var fallback = function () {
            try {
                var ta = document.createElement('textarea');
                ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                var ok = document.execCommand('copy');
                ta.remove();
                if (ok) done(); else toast('Could not copy to the clipboard.', 'error');
            } catch (_) { toast('Could not copy to the clipboard.', 'error'); }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fallback);
        else fallback();
    }

    function saveCsv() {
        var mdl = model();
        var m = meta(mdl);
        try {
            var blob = new Blob(['\ufeff' + M().csv(mdl)], { type: 'text/csv;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = M().fileName(mdl, m, 'csv');
            document.body.appendChild(a); a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
        } catch (e) { toast('Could not create the spreadsheet: ' + ((e && e.message) || e), 'error'); }
    }

    async function savePdf(toEvidence) {
        if (busy) return;
        var api = window.electronAPI;
        if (!api || typeof api.saveHtmlAsPdf !== 'function') { toast('Saving the PDF needs the VIPER desktop app.', 'error'); return; }
        var c = theCase();
        if (!c) { toast('No case is open.', 'error'); return; }
        var mdl = model();
        if (!mdl.totals.lines) return;
        var m = meta(mdl);
        setBusy(true, 'Building PDF\u2026');
        try {
            m.logo = H().logoData ? await H().logoData() : '';
            var name = M().fileName(mdl, m, 'pdf');
            var opts = {
                pageSize: 'Letter', settleMs: 500,
                footerText: 'IP address activity' + (m.showCase && m.caseNumber ? ' \u00b7 Case ' + m.caseNumber : '')
            };
            var html = M().pdfHtml(mdl, m);
            if (!toEvidence) {
                var r1 = await api.saveHtmlAsPdf({ html: html, defaultFileName: name, options: opts });
                if (r1 && r1.success) toast('Subpoena list saved' + (r1.path ? ': ' + r1.path : '.'), 'success');
                else if (r1 && !r1.canceled) toast('Subpoena list not saved: ' + (r1.error || 'unknown error'), 'error');
                return;
            }
            if (typeof api.saveEvidenceFile !== 'function' || !H().saveToEvidence) throw new Error('Saving to Evidence needs the VIPER desktop app.');
            var res = await api.saveHtmlAsPdf({ html: html, defaultFileName: name, options: opts, returnBase64: true });
            if (!res || !res.success || !res.base64) throw new Error((res && res.error) || 'The PDF was not created.');
            setBusy(true, 'Saving to Evidence\u2026');
            var T = mdl.totals;
            var desc = 'IP subpoena list: ' + mdl.ips.map(function (g) { return g.address; }).slice(0, 6).join(', ') + (T.ips > 6 ? ' +' + (T.ips - 6) + ' more' : '') +
                ' (' + T.lines + ' date/time line' + (T.lines === 1 ? '' : 's') + ', CT# ' + mdl.tips.join(', ') + ')';
            await H().saveToEvidence(c, name, H().b64ToBytes(res.base64), desc, 'cybertip_subpoena_list');
            toast('Subpoena list saved to Evidence (' + (H().EVIDENCE_TAG || 'CyberTip IP Reports') + ') as ' + name + '.', 'success');
        } catch (e) {
            console.error('[CT subpoena]', e);
            toast('Subpoena list not saved: ' + ((e && e.message) || e), 'error');
        } finally { setBusy(false); }
    }

    window.CTSubpoenaUI = {
        open: open, openFor: openFor, openSelected: openSelected, close: close,
        cardButton: cardButton, barButton: barButton, panelButton: panelButton,
        _state: function () { return S; }
    };
})();
