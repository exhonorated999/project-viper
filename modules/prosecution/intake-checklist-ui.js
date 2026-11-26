/**
 * modules/prosecution/intake-checklist-ui.js — the Intake / Discovery
 * Checklist card on a case's Prosecution tab.
 *
 *   window.ViperIntakeChecklistUI.mount(el, ctx)
 *     ctx: { caseNumber,
 *            get()          → the stored checklist or null (not added on this case)
 *            commit(next)   → saves it (null removes it); false when the save failed
 *            prefill()      → { defendants, agency, agencyCaseNumber, caseNumbers }
 *            toast(msg, kind), confirm(msg, opts) → Promise<boolean>,
 *            api            → window.electronAPI (prosecutionIntakePdf) }
 *
 * renderCard(checklist, state) is pure (HTML string) so it loads under node for tests.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root && root.document) root.ViperIntakeChecklistUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const IC = () => (root && root.ViperIntakeChecklist) || require('./intake-checklist.js');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const INPUT = 'w-full px-2 py-1.5 bg-viper-dark border border-gray-600 rounded text-sm text-white focus:border-viper-cyan outline-none';
    const BTN = 'px-3 py-1.5 rounded-lg text-xs font-medium border transition disabled:opacity-50';

    // Open/closed survives re-renders of the tab for the rest of the session.
    const openState = {};

    function progressText(cl) {
        const p = IC().progress(cl);
        return `${p.done} of ${p.total} complete` + (p.requested ? ` · ${p.requested} requested` : '') + (p.open ? ` · ${p.open} open` : '');
    }

    function fmtWhen(iso) {
        const d = new Date(iso);
        if (isNaN(d)) return '';
        return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    function lastExportText(cl) {
        const x = cl && cl.lastExport;
        if (!x) return 'Not exported yet';
        return `Last exported ${fmtWhen(x.at)} → ${x.destination === 'case' ? 'case Forms folder' : 'saved copy'}: ${x.fileName}`;
    }

    function showDetail(v) {
        return !!v && (v.status === 'other' || v.status === 'requested' || !!v.detail);
    }

    function renderEmpty() {
        return `
            <div class="glass-card rounded-xl p-6" data-ic="card">
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h3 class="text-xl font-bold text-viper-cyan">Intake / Discovery Checklist</h3>
                        <p class="text-xs text-gray-500 mt-1">Optional. Track what has gone to the prosecutor and print a checklist for the DA packet.</p>
                    </div>
                    <button type="button" data-ic-act="add" class="px-4 py-2 rounded-lg text-sm font-medium bg-viper-cyan/20 text-viper-cyan border border-viper-cyan/40 hover:bg-viper-cyan/30 transition">+ Add Intake Checklist</button>
                </div>
            </div>`;
    }

    function renderSection(sec, cl) {
        const L = IC();
        const rows = sec.items.map(item => {
            if (sec.kind === 'check') {
                const on = !!cl.checks[item.id];
                return `
                    <label class="flex items-start gap-2 py-1 text-sm text-gray-200 cursor-pointer">
                        <input type="checkbox" data-ic-check="${esc(item.id)}" ${on ? 'checked' : ''} class="mt-0.5 accent-cyan-400">
                        <span>${esc(item.label)}</span>
                    </label>`;
            }
            const v = cl.statuses[item.id] || null;
            const st = v ? v.status : '';
            const tone = st === 'requested' ? 'border-amber-500/60 text-amber-200' : st ? 'border-viper-cyan/50 text-white' : 'border-gray-600 text-gray-400';
            const opts = [`<option value="" ${st ? '' : 'selected'}>—</option>`]
                .concat(L.STATUSES.map(s => `<option value="${s.id}" ${st === s.id ? 'selected' : ''}>${esc(s.label)}</option>`)).join('');
            return `
                <div class="py-1" data-ic-row="${esc(item.id)}">
                    <div class="flex items-center gap-2">
                        <span class="flex-1 text-sm text-gray-200">${esc(item.label)}</span>
                        <select data-ic-status="${esc(item.id)}" aria-label="${esc(item.label)} status" class="w-28 px-2 py-1 bg-viper-dark border rounded text-xs focus:border-viper-cyan outline-none ${tone}">${opts}</select>
                    </div>
                    <input type="text" data-ic-detail="${esc(item.id)}" maxlength="${L.LIMITS.detail}" value="${esc(v && v.detail ? v.detail : '')}"
                        placeholder="${st === 'requested' ? 'Requested from / when (optional)' : 'Details'}"
                        class="${showDetail(v) ? '' : 'hidden '}mt-1 w-full px-2 py-1 bg-viper-dark border border-gray-700 rounded text-xs text-gray-200 focus:border-viper-cyan outline-none">
                </div>`;
        }).join('');
        return `
            <div class="rounded-lg border border-gray-700 bg-viper-dark/30 p-3">
                <div class="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">${esc(sec.title)}</div>
                ${rows}
            </div>`;
    }

    function renderCard(cl, state) {
        if (!cl) return renderEmpty();
        const L = IC();
        const open = !state || state.open !== false;
        const header = L.HEADER_FIELDS.map(f => `
            <label class="block ${f.id === 'defendants' ? 'md:col-span-2' : ''}">
                <span class="text-xs text-gray-400">${esc(f.label)}</span>
                <input type="text" data-ic-h="${esc(f.id)}" maxlength="${f.max}" value="${esc(cl.header[f.id])}" placeholder="${esc(f.hint)}" class="${INPUT} mt-1">
            </label>`).join('');
        const p = L.progress(cl);
        return `
            <div class="glass-card rounded-xl p-6" data-ic="card">
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <button type="button" data-ic-act="toggle" class="flex items-center gap-2 text-left" aria-expanded="${open}">
                        <span class="text-gray-400 text-sm w-4">${open ? '▾' : '▸'}</span>
                        <h3 class="text-xl font-bold text-viper-cyan">Intake / Discovery Checklist</h3>
                    </button>
                    <span data-ic="progress" class="text-xs px-2 py-1 rounded border ${p.requested ? 'border-amber-500/50 text-amber-200 bg-amber-500/10' : 'border-gray-600 text-gray-300'}">${esc(progressText(cl))}</span>
                </div>
                <div data-ic="body" class="${open ? '' : 'hidden'} mt-4 space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${header}</div>
                    <p class="text-xs text-gray-500">Tick what has been provided. For the rest choose N/A, In File, Requested or Other.</p>
                    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">${L.SECTIONS.map(s => renderSection(s, cl)).join('')}</div>
                    <div class="rounded-lg border border-gray-700 p-3 text-xs text-gray-400"><span class="font-semibold text-gray-300">Discovery.</span> ${esc(L.DISCOVERY_NOTE)}</div>
                    <label class="block">
                        <span class="text-xs text-gray-400">Notes (optional)</span>
                        <textarea data-ic-notes rows="4" maxlength="${L.LIMITS.notes}" class="${INPUT} mt-1">${esc(cl.notes)}</textarea>
                    </label>
                    <div class="flex flex-wrap items-center gap-2">
                        <button type="button" data-ic-act="case" class="${BTN} bg-viper-cyan/20 text-viper-cyan border-viper-cyan/40 hover:bg-viper-cyan/30">Save PDF to case Forms</button>
                        <button type="button" data-ic-act="saveAs" class="${BTN} bg-gray-700/40 text-gray-200 border-gray-600 hover:bg-gray-700/70">Save as…</button>
                        <button type="button" data-ic-act="open" class="${BTN} bg-gray-700/40 text-gray-200 border-gray-600 hover:bg-gray-700/70">Open / Print</button>
                        <button type="button" data-ic-act="remove" class="${BTN} ml-auto text-gray-400 border-gray-700 hover:text-red-300 hover:border-red-500/50">Remove checklist</button>
                    </div>
                    <p data-ic="last" class="text-xs text-gray-500">${esc(lastExportText(cl))}</p>
                </div>
            </div>`;
    }

    function mount(el, ctx) {
        if (!el || !ctx) return;
        const L = IC();
        const key = String(ctx.caseNumber || '');
        const toast = (m, k) => { try { ctx.toast && ctx.toast(m, k); } catch (_) { /* ignore */ } };
        let busy = false;

        const paint = () => { el.innerHTML = renderCard(ctx.get(), { open: openState[key] !== false }); };
        const refreshProgress = (cl) => {
            const pe = el.querySelector('[data-ic="progress"]');
            if (!pe) return;
            const p = L.progress(cl);
            pe.textContent = progressText(cl);
            pe.className = `text-xs px-2 py-1 rounded border ${p.requested ? 'border-amber-500/50 text-amber-200 bg-amber-500/10' : 'border-gray-600 text-gray-300'}`;
        };
        // Save one edit; the DOM already shows it, so only the summary is redrawn.
        const apply = (fn) => {
            const cur = ctx.get();
            if (!cur) { paint(); return null; }
            const next = fn(cur);
            if (!ctx.commit(next)) { paint(); return null; }
            refreshProgress(next);
            return next;
        };

        async function exportPdf(mode) {
            const cl = ctx.get();
            if (!cl || busy) return;
            const api = ctx.api;
            if (!api || typeof api.prosecutionIntakePdf !== 'function') { toast('PDF export needs the V.I.P.E.R. desktop app.', 'warning'); return; }
            busy = true;
            const btns = el.querySelectorAll('[data-ic-act="case"],[data-ic-act="saveAs"],[data-ic-act="open"]');
            btns.forEach(b => { b.disabled = true; });
            try {
                const r = await api.prosecutionIntakePdf({ caseNumber: ctx.caseNumber, checklist: cl, mode });
                if (!r || !r.success) { toast((r && r.error) || 'Could not create the checklist PDF.', 'error'); return; }
                if (r.canceled || r.opened) return;
                const latest = ctx.get();
                if (latest) {
                    const next = L.setLastExport(latest, { fileName: r.fileName, destination: r.destination });
                    if (ctx.commit(next)) {
                        const le = el.querySelector('[data-ic="last"]');
                        if (le) le.textContent = lastExportText(next);
                    }
                }
                toast(r.destination === 'case' ? `Saved to the case Forms folder: ${r.fileName}` : `Saved: ${r.fileName}`, 'success');
            } catch (e) {
                toast('Could not create the checklist PDF: ' + ((e && e.message) || e), 'error');
            } finally {
                busy = false;
                btns.forEach(b => { b.disabled = false; });
            }
        }

        el.onclick = async (ev) => {
            const b = ev.target.closest && ev.target.closest('[data-ic-act]');
            if (!b || !el.contains(b)) return;
            const act = b.getAttribute('data-ic-act');
            if (act === 'add') {
                const cl = L.create(ctx.prefill ? ctx.prefill() : {});
                openState[key] = true;
                if (ctx.commit(cl)) paint();
            } else if (act === 'toggle') {
                openState[key] = openState[key] === false;
                paint();
            } else if (act === 'remove') {
                const ok = ctx.confirm
                    ? await ctx.confirm('Remove the intake checklist from this case? PDFs already saved to the Forms folder are kept.', { danger: true, okText: 'Remove' })
                    : false;
                if (!ok) return;
                if (ctx.commit(null)) paint();
            } else if (act === 'case' || act === 'saveAs' || act === 'open') {
                exportPdf(act);
            }
        };

        el.onchange = (ev) => {
            const t = ev.target;
            if (!t || !t.getAttribute) return;
            let id;
            if ((id = t.getAttribute('data-ic-h'))) apply(cl => L.setHeader(cl, id, t.value));
            else if ((id = t.getAttribute('data-ic-check'))) apply(cl => L.setCheck(cl, id, !!t.checked));
            else if ((id = t.getAttribute('data-ic-detail'))) apply(cl => L.setDetail(cl, id, t.value));
            else if (t.hasAttribute('data-ic-notes')) apply(cl => L.setNotes(cl, t.value));
            else if ((id = t.getAttribute('data-ic-status'))) {
                const next = apply(cl => L.setStatus(cl, id, t.value));
                if (!next) return;
                // Redraw just this row (detail box + colours).
                const row = t.closest('[data-ic-row]');
                const sec = L.SECTIONS.find(s => s.items.some(i => i.id === id));
                if (row && sec) {
                    const tmp = (el.ownerDocument || root.document).createElement('div');
                    tmp.innerHTML = renderSection(Object.assign({}, sec, { items: sec.items.filter(i => i.id === id) }), next);
                    const fresh = tmp.querySelector('[data-ic-row]');
                    if (fresh) {
                        row.replaceWith(fresh);
                        const d = fresh.querySelector('[data-ic-detail]');
                        if (d && (t.value === 'other' || t.value === 'requested')) d.focus();
                    }
                }
            }
        };

        paint();
    }

    return { mount, renderCard, progressText, lastExportText };
}));
