/* ============================================================
   CyberTip "Uploads by IP" — glue for case-detail-with-analytics.
   window.CTIpReportUI:
     tipPanel(tip)   card for one tip's detail view
     caseView()      full-page combined view (currentCyberTipView = 'ipAll')
     listButton()    button for the CyberTips list page
     filter / expand / save   handlers used by the panel's buttons
   Reads the host's top-level getCyberTips / currentCyberTipView /
   currentCase / caseEvidence (shared global scope).
   ============================================================ */
(function () {
    'use strict';
    var R = function () { return window.CyberTipIpReport; };
    var LOGO_PATH = 'modules/case-status-report/csr-logo.png';
    var EVIDENCE_TAG = 'CyberTip IP Reports';

    function toast(msg, type) {
        try { if (typeof showToast === 'function') return showToast(msg, type || 'info'); } catch (_) {}
        try { if (typeof window.viperToast === 'function') return window.viperToast(msg, type || 'info'); } catch (_) {}
        console.log('[CT IP report]', msg);
    }
    function theCase() { try { return (typeof currentCase !== 'undefined' && currentCase) || null; } catch (_) { return null; } }
    function allTips() { try { return (typeof getCyberTips === 'function' ? getCyberTips() : []) || []; } catch (_) { return []; } }
    function viewIdx() { try { return typeof currentCyberTipView !== 'undefined' ? currentCyberTipView : null; } catch (_) { return null; } }
    function tipsFor(scope) {
        var tips = allTips();
        if (scope === 'case') return tips;
        var t = tips[viewIdx()];
        return t ? [t] : [];
    }

    function tipPanel(t) {
        if (!R() || !t) return '';
        var report = R().build([t], { scope: 'tip' });
        if (!report.totals.uploadIps && !report.totals.otherIps) return '';
        return '<div class="glass-card rounded-xl p-6 border border-gray-700/50" id="ctIprPanel">' + R().panelHtml(report) + '</div>';
    }

    function caseView() {
        var tips = allTips();
        var back =
            '<div class="flex items-center justify-between">' +
                '<button onclick="currentCyberTipView=null; renderTabContent(\'cyberTips\')" class="flex items-center gap-2 text-gray-400 hover:text-white transition-colors">' +
                    '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>' +
                    'Back to CyberTips</button>' +
            '</div>';
        if (!R()) return '<div class="space-y-6">' + back + '<div class="text-gray-400">The IP report module did not load.</div></div>';
        var report = R().build(tips, { scope: 'case' });
        return '<div class="space-y-6">' + back +
            '<div class="glass-card rounded-xl p-6 border border-gray-700/50" id="ctIprPanel">' +
                '<div class="text-xs text-gray-400 mb-3">All CyberTips in this case: ' + R().esc(report.tips.map(function (x) { return 'CT# ' + x.reportNumber; }).join(', ')) + '</div>' +
                R().panelHtml(report) +
            '</div></div>';
    }

    function listButton() {
        return '<button onclick="currentCyberTipView=\'ipAll\'; renderTabContent(\'cyberTips\')" class="px-4 py-2 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 rounded-lg border border-purple-500/40 flex items-center gap-2 transition-colors" title="Every IP across every CyberTip in this case: uploads (dates, times, files) first, then logins and other activity">' +
            '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-6h6v6m-9 4h12a2 2 0 002-2V7l-5-5H6a2 2 0 00-2 2v15a2 2 0 002 2z"/></svg>' +
            'Uploads by IP (all tips)</button>';
    }

    function panel() { return document.getElementById('ctIprPanel'); }

    function filter(v) {
        var p = panel(); if (!p) return;
        var q = String(v || '').trim().toLowerCase();
        var shown = 0;
        p.querySelectorAll('.ct-ipr-group').forEach(function (el) {
            var hit = !q || (el.getAttribute('data-ct-ipr-text') || '').indexOf(q) >= 0;
            el.style.display = hit ? '' : 'none';
            if (hit) shown++;
        });
        var none = p.querySelector('.ct-ipr-none');
        if (none) none.classList.toggle('hidden', !!shown || !q);
    }

    function expand(open) {
        var p = panel(); if (!p) return;
        p.querySelectorAll('.ct-ipr-group').forEach(function (el) { if (el.style.display !== 'none') el.open = !!open; });
    }

    function logoData() {
        var url;
        try { url = new URL(LOGO_PATH, location.href).href; } catch (_) { url = LOGO_PATH; }
        if (typeof fetch !== 'function' || typeof FileReader !== 'function') return Promise.resolve(url);
        return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); }).then(function (blob) {
            return new Promise(function (resolve) {
                var fr = new FileReader();
                fr.onload = function () { resolve(String(fr.result || url)); };
                fr.onerror = function () { resolve(url); };
                fr.readAsDataURL(blob);
            });
        }).catch(function () { return url; });
    }
    function localDay(d) {
        d = d || new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function b64ToBytes(b64) {
        var bin = atob(b64), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // Same record shape and storage path as the Evidence tab's own upload.
    async function saveToEvidence(c, fileName, bytes, description) {
        var savedPath = await window.electronAPI.saveEvidenceFile({
            caseNumber: c.caseNumber, evidenceTag: EVIDENCE_TAG, fileName: fileName, fileData: Array.from(bytes)
        });
        if (!savedPath) throw new Error('The file could not be written to the evidence folder.');
        var now = new Date();
        var rec = {
            id: Date.now(), type: 'document', tag: EVIDENCE_TAG, discoverable: true,
            description: description, location: '', fileCount: 1, totalSize: bytes.length,
            files: [{ name: fileName, path: savedPath, size: bytes.length, type: 'application/pdf', lastModified: now.getTime() }],
            source: 'cybertip_ip_report', collectedDate: localDay(now), createdAt: now.toISOString()
        };
        var mem = null;
        try { if (typeof caseEvidence !== 'undefined' && Array.isArray(caseEvidence)) mem = caseEvidence; } catch (_) {}
        var all;
        try { all = JSON.parse(localStorage.getItem('viperCaseEvidence') || '{}') || {}; } catch (_) { all = {}; }
        var list = mem || (Array.isArray(all[c.caseNumber]) ? all[c.caseNumber] : []);
        list.push(rec);
        try {
            try { if (typeof _provStampEdits === 'function') _provStampEdits('viperCaseEvidence', list); } catch (_) {}
            all[c.caseNumber] = list;
            localStorage.setItem('viperCaseEvidence', JSON.stringify(all));
        } catch (e) {
            list.pop();
            throw new Error('Saved the PDF to ' + savedPath + ', but the Evidence list could not be updated (storage full?).');
        }
        if (!mem) { try { if (typeof window.refreshCaseEvidenceFromStorage === 'function') window.refreshCaseEvidenceFromStorage(); } catch (_) {} }
        try { if (typeof window.audit === 'function') window.audit('evidence_added', { case_number: c.caseNumber, case_id: c.id, evidence_id: rec.id, type: rec.type, tag: EVIDENCE_TAG, file_count: 1, source: rec.source }); } catch (_) {}
        return rec;
    }

    var busy = false;
    function setBusy(on, label) {
        busy = !!on;
        document.querySelectorAll('[data-ct-ipr-save]').forEach(function (b) {
            b.disabled = !!on;
            b.style.opacity = on ? '0.5' : '';
            if (b.getAttribute('data-ct-ipr-save') === 'ev') {
                if (!b._label) b._label = b.innerHTML;
                b.innerHTML = on && label ? label : b._label;
            }
        });
    }

    async function save(scope, toEvidence) {
        if (busy) return;
        var api = window.electronAPI;
        if (!api || typeof api.saveHtmlAsPdf !== 'function') { toast('Saving the PDF needs the VIPER desktop app.', 'error'); return; }
        var c = theCase();
        if (!c) { toast('No case is open.', 'error'); return; }
        var tips = tipsFor(scope);
        if (!tips.length) { toast('No CyberTip to report on.', 'warning'); return; }
        var report = R().build(tips, { scope: scope });
        if (!report.totals.uploadIps && !report.totals.otherIps) { toast('No IP addresses in ' + (scope === 'case' ? 'these tips' : 'this tip') + '.', 'warning'); return; }
        setBusy(true, 'Building PDF\u2026');
        try {
            var now = new Date();
            var meta = {
                caseNumber: c.caseNumber || '', caseTitle: c.title || c.caseName || c.name || '',
                generated: now.toLocaleString(), day: localDay(now), logo: await logoData()
            };
            var name = R().fileName(report, meta);
            var opts = {
                pageSize: 'Letter', settleMs: 700,
                footerText: 'Case ' + (c.caseNumber || '') + ' \u00b7 ' + R().titleFor(report) + ' \u00b7 Uploads by IP \u00b7 LAW ENFORCEMENT SENSITIVE'
            };
            var html = R().pdfHtml(report, meta);
            if (!toEvidence) {
                var r1 = await api.saveHtmlAsPdf({ html: html, defaultFileName: name, options: opts });
                if (r1 && r1.success) toast('IP report saved' + (r1.path ? ': ' + r1.path : '.'), 'success');
                else if (r1 && !r1.canceled) toast('IP report not saved: ' + (r1.error || 'unknown error'), 'error');
                return;
            }
            if (typeof api.saveEvidenceFile !== 'function') throw new Error('Saving to Evidence needs the VIPER desktop app.');
            var res = await api.saveHtmlAsPdf({ html: html, defaultFileName: name, options: opts, returnBase64: true });
            if (!res || !res.success || !res.base64) throw new Error((res && res.error) || 'The PDF was not created.');
            setBusy(true, 'Saving to Evidence\u2026');
            var T = report.totals;
            var desc = 'CyberTip uploads by IP: ' + R().titleFor(report) + ' (' + T.uploadIps + ' upload IP' + (T.uploadIps === 1 ? '' : 's') + ', ' + T.uploads + ' upload' + (T.uploads === 1 ? '' : 's') + ', ' + T.otherIps + ' login/other IP' + (T.otherIps === 1 ? '' : 's') + ')';
            await saveToEvidence(c, name, b64ToBytes(res.base64), desc);
            toast('IP report saved to Evidence (' + EVIDENCE_TAG + ') as ' + name + '.', 'success');
        } catch (e) {
            console.error('[CT IP report]', e);
            toast('IP report not saved: ' + ((e && e.message) || e), 'error');
        } finally { setBusy(false); }
    }

    window.CTIpReportUI = { tipPanel: tipPanel, caseView: caseView, listButton: listButton, filter: filter, expand: expand, save: save };
})();
