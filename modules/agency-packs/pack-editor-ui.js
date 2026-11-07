/**
 * Agency pack editor — Settings → Warrant Authoring → Agency template packs → Create / Edit.
 *
 * A full-screen panel over Settings. Everything is done in the main process (pack-drafts.js):
 * this file only shows the draft it gets back and sends the officer's changes, one at a time.
 * Every change is kept straight away as a draft, so closing the panel never loses work; "Save
 * pack" installs the pack on this computer with a new version number.
 *
 * window.ViperPackEditor.open({ id, mode: 'edit' | 'resume', view?, onClose })
 */
(function () {
    'use strict';

    const E = {
        el: null, id: null, view: null, tab: 'templates', expanded: null, filter: '',
        notice: null, newCategory: 'Search Warrant', busy: '', chain: Promise.resolve(), onClose: null,
        openNotes: {}, resumed: false,
        // Added Word files that look like a template already in the pack: { file, path, rel, title }.
        conflicts: [],
    };

    const api = () => (typeof window !== 'undefined' && window.electronAPI) || {};
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const toast = (msg, kind) => {
        try { if (window.viperToast) return window.viperToast(msg, kind || 'info'); } catch (_) { /* fall through */ }
        try { console.log('[pack-editor]', msg); } catch (_) { /* ignore */ }
    };
    const confirmBox = async (msg, opts) => {
        // viperConfirm shows its message as HTML; labels come from Word files and shared packs.
        try { if (window.viperConfirm) return await window.viperConfirm(esc(msg).replace(/\n/g, '<br>'), opts); } catch (_) { /* fall through */ }
        return window.confirm(msg);
    };
    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
    const fmtWhen = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleString() : ''; };

    const BTN = 'px-2.5 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700/40 disabled:opacity-50';
    const BTN_PRIMARY = 'px-3 py-1.5 text-xs rounded-lg bg-viper-cyan/20 hover:bg-viper-cyan/30 border border-viper-cyan text-viper-cyan disabled:opacity-50';
    const BTN_DANGER = 'px-2.5 py-1 text-xs rounded border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 disabled:opacity-50';
    const INPUT = 'w-full px-2.5 py-1.5 text-sm rounded-lg bg-viper-dark border border-gray-600 text-white focus:border-viper-cyan focus:outline-none';

    // ---- Talking to main ---------------------------------------------------------------------
    // One request at a time, in order (a field's "change" on blur, then a click on Save).
    function queue(label, fn) {
        const run = async () => {
            E.busy = label || 'Working…';
            renderStatus();
            try { return await fn(); } catch (e) {
                toast(String(e && e.message || e), 'error');
                return null;
            } finally { E.busy = ''; renderStatus(); }
        };
        const p = E.chain.then(run, run);
        E.chain = p.catch(() => {});
        return p;
    }
    function take(r, fallback) {
        if (!r) return null;
        if (r.canceled) return null;
        if (!r.success) { toast(r.error || fallback || 'That did not work', 'error'); return null; }
        if (r.draft) E.view = r.draft;
        return r;
    }
    const op = (name, args, label) => queue(label || 'Saving draft…', async () => {
        const r = take(await api().agencyPackDraftOp({ id: E.id, op: name, args }));
        render();
        return r;
    });

    // ---- Open / close ------------------------------------------------------------------------
    async function open(opts) {
        opts = opts || {};
        E.id = opts.id;
        E.onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
        E.tab = opts.tab || 'templates';
        E.expanded = null; E.filter = ''; E.notice = null; E.openNotes = {}; E.resumed = false; E.conflicts = [];
        let r;
        if (opts.view) r = { success: true, draft: opts.view };
        else if (opts.mode === 'edit') r = await api().agencyPackDraftOpen({ id: opts.id });
        else r = await api().agencyPackDraftGet(opts.id);
        if (!r || !r.success) { toast((r && r.error) || 'Could not open the pack', 'error'); return false; }
        E.view = r.draft;
        E.resumed = opts.mode === 'edit' && !!r.draft.dirty;
        if (!E.view.templates.length) E.tab = 'templates';
        mountPanel();
        render();
        return true;
    }

    async function close() {
        await E.chain;
        if (E.el) { E.el.remove(); E.el = null; }
        document.removeEventListener('keydown', onKey, true);
        const cb = E.onClose;
        E.onClose = null;
        if (cb) { try { cb(E.view); } catch (_) { /* ignore */ } }
    }
    function onKey(e) {
        if (e.key === 'Escape' && E.el && !document.querySelector('.viper-confirm-backdrop')) { e.stopPropagation(); close(); }
    }

    function mountPanel() {
        if (E.el) E.el.remove();
        const el = document.createElement('div');
        el.setAttribute('data-pack-editor', '');
        el.className = 'fixed inset-0 z-[9000] bg-black/70 flex items-center justify-center p-4';
        el.innerHTML = `
            <div class="w-full max-w-6xl h-[94vh] flex flex-col rounded-xl border border-gray-700 bg-viper-darker shadow-2xl" style="background:#0f1117">
                <div data-pe-head class="px-5 pt-4 pb-3 border-b border-gray-700/70"></div>
                <div data-pe-tabs class="px-5 pt-2 flex gap-1 border-b border-gray-700/70"></div>
                <div data-pe-body class="flex-1 overflow-y-auto px-5 py-4"></div>
                <div data-pe-foot class="px-5 py-3 border-t border-gray-700/70"></div>
            </div>`;
        document.body.appendChild(el);
        E.el = el;
        el.addEventListener('click', onClick);
        el.addEventListener('change', onChange);
        el.addEventListener('input', onInput);
        // Files dropped anywhere on the panel never navigate the page.
        el.addEventListener('dragover', (e) => { e.preventDefault(); const z = e.target.closest && e.target.closest('[data-pe-drop]'); el.querySelectorAll('[data-pe-drop]').forEach(d => d.classList.toggle('border-viper-cyan', d === z)); });
        el.addEventListener('dragleave', (e) => { if (e.target.closest && e.target.closest('[data-pe-drop]')) e.target.closest('[data-pe-drop]').classList.remove('border-viper-cyan'); });
        el.addEventListener('drop', onDrop);
        document.addEventListener('keydown', onKey, true);
    }

    // ---- Rendering -------------------------------------------------------------------------
    function keepFocus(fn) {
        const a = document.activeElement;
        const key = a && a.getAttribute && a.getAttribute('data-pe-focus');
        const pos = a && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
        const body = E.el && E.el.querySelector('[data-pe-body]');
        const scroll = body ? body.scrollTop : 0;
        fn();
        if (body) body.scrollTop = scroll;
        if (key && E.el) {
            const n = E.el.querySelector(`[data-pe-focus="${CSS.escape(key)}"]`);
            if (n) { n.focus(); if (pos && typeof n.setSelectionRange === 'function') { try { n.setSelectionRange(pos[0], pos[1]); } catch (_) { /* ignore */ } } }
        }
    }

    function render() {
        if (!E.el || !E.view) return;
        keepFocus(() => {
            E.el.querySelector('[data-pe-head]').innerHTML = headHtml();
            E.el.querySelector('[data-pe-tabs]').innerHTML = tabsHtml();
            E.el.querySelector('[data-pe-body]').innerHTML = bodyHtml();
            E.el.querySelector('[data-pe-foot]').innerHTML = footHtml();
        });
    }
    function renderStatus() {
        if (!E.el) return;
        const s = E.el.querySelector('[data-pe-status]');
        if (s) s.innerHTML = statusHtml();
        E.el.querySelectorAll('[data-pe-act="save"]').forEach(b => { b.disabled = !!E.busy || !(E.view && E.view.check.ok); });
    }
    function statusHtml() {
        const v = E.view;
        if (E.busy) return `<span class="text-gray-400">${esc(E.busy)}</span>`;
        if (v.dirty) return `<span class="text-amber-300">Changes not saved to the pack yet</span> <span class="text-gray-500">· kept as a draft${v.updatedAt ? ' ' + esc(fmtWhen(v.updatedAt)) : ''}</span>`;
        if (v.meta.packVersion) return `<span class="text-emerald-400">✓ Saved · version ${esc(v.meta.packVersion)}</span>`;
        return '<span class="text-gray-400">Not saved yet</span>';
    }

    function headHtml() {
        const v = E.view, m = v.meta;
        const title = m.installedVersion || m.packVersion ? 'Edit agency pack' : 'New agency pack';
        return `
            <div class="flex items-start justify-between gap-4">
                <div class="min-w-0">
                    <div class="text-[11px] uppercase tracking-wider text-gray-500">${title}</div>
                    <div class="text-lg font-semibold text-white truncate" data-pe-title>${esc(m.name)}</div>
                    <div class="text-xs text-gray-400">${esc(m.agency || 'No agency set')} · ${m.installedVersion ? 'installed version ' + esc(m.installedVersion) : 'not installed yet'}</div>
                    <div class="text-xs mt-1" data-pe-status>${statusHtml()}</div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <button type="button" data-pe-act="save" class="${BTN_PRIMARY}" ${E.busy || !v.check.ok ? 'disabled' : ''}
                        title="Install this pack on this computer as version ${esc(m.nextVersion)}">Save pack (v${esc(m.nextVersion)})</button>
                    <button type="button" data-pe-act="close" class="${BTN}">Close</button>
                </div>
            </div>
            ${v.stale ? `
            <div class="mt-3 p-3 rounded-lg border border-rose-500/50 bg-rose-500/10 text-xs text-rose-100 flex items-center justify-between gap-3" data-pe-stale>
                <span><span class="font-semibold text-rose-200">This pack was updated after these changes were made.</span>
                    The changes below were made to version ${esc(v.stale.baseVersion)}${v.updatedAt ? ' (last change ' + esc(fmtWhen(v.updatedAt)) + ')' : ''}, but version ${esc(v.stale.installedVersion)} has been installed since${v.stale.installedAt ? ' (' + esc(fmtWhen(v.stale.installedAt)) + ')' : ''}.
                    Saving them would replace version ${esc(v.stale.installedVersion)} and lose whatever changed in it.</span>
                <button type="button" data-pe-act="start-over" class="${BTN_PRIMARY} shrink-0">Start from version ${esc(v.stale.installedVersion)}</button>
            </div>` : E.resumed ? `
            <div class="mt-3 p-2.5 rounded-lg border border-amber-500/40 bg-amber-500/5 text-xs text-amber-200 flex items-center justify-between gap-3" data-pe-resumed>
                <span>You have changes to this pack that were never saved${v.updatedAt ? ' (last change ' + esc(fmtWhen(v.updatedAt)) + ')' : ''}. They are shown here.</span>
                <button type="button" data-pe-act="start-over" class="${BTN}">Discard them and start from the installed pack</button>
            </div>` : ''}`;
    }

    function tabsHtml() {
        const v = E.view;
        const n = v.fields.shared.length + v.fields.own.length;
        const tab = (id, label) => `<button type="button" data-pe-tab="${id}" class="px-3 py-2 text-sm rounded-t-lg ${E.tab === id ? 'text-viper-cyan border-b-2 border-viper-cyan' : 'text-gray-400 hover:text-gray-200'}">${label}</button>`;
        return tab('details', 'Details') + tab('templates', `Templates (${v.templates.length})`) + tab('fields', `Fields (${n})`) + tab('help', 'How it works');
    }

    function footHtml() {
        const c = E.view.check;
        const items = c.errors.map(e => `<li class="text-rose-300">${esc(e)}</li>`)
            .concat(c.warnings.slice(0, 3).map(w => `<li class="text-amber-300">${esc(w)}</li>`));
        const more = c.warnings.length > 3 ? `<li class="text-gray-500">…and ${c.warnings.length - 3} more like this</li>` : '';
        const msg = items.length
            ? `<ul class="text-xs space-y-0.5">${items.join('')}${more}</ul>`
            : '<div class="text-xs text-gray-400">Ready to save. Saving installs the pack on this computer; use <span class="text-gray-300">Export</span> in Settings to share the file with other officers.</div>';
        return `<div class="flex items-center justify-between gap-4">${msg}<div class="text-[11px] text-gray-500 shrink-0">Pack id: ${esc(E.view.id)}</div></div>`;
    }

    function bodyHtml() {
        if (E.tab === 'details') return detailsHtml();
        if (E.tab === 'fields') return fieldsHtml();
        if (E.tab === 'help') return helpHtml();
        return templatesHtml();
    }

    // ---- Details -------------------------------------------------------------------------
    function detailsHtml() {
        const m = E.view.meta;
        return `
            <div class="max-w-2xl space-y-4">
                <label class="block"><span class="text-xs text-gray-400">Pack name</span>
                    <input data-pe-meta="name" data-pe-focus="meta-name" class="${INPUT} mt-1" maxlength="120" value="${esc(m.name)}"></label>
                <label class="block"><span class="text-xs text-gray-400">Agency</span>
                    <input data-pe-meta="agency" data-pe-focus="meta-agency" class="${INPUT} mt-1" maxlength="120" value="${esc(m.agency)}" placeholder="e.g. Example Police Department"></label>
                <label class="block"><span class="text-xs text-gray-400">Description (optional)</span>
                    <textarea data-pe-meta="description" data-pe-focus="meta-description" class="${INPUT} mt-1" rows="3" maxlength="1000" placeholder="What is in this pack, who it is for">${esc(m.description)}</textarea></label>
                <div class="text-xs text-gray-400 space-y-1">
                    <div>Version: ${m.packVersion ? 'last saved ' + esc(m.packVersion) + ' · ' : ''}next save will be <span class="text-gray-200">${esc(m.nextVersion)}</span>. The number goes up by itself each time you save, so officers can tell which copy they have.</div>
                    ${m.hasRules ? '<div class="text-gray-500">This pack also has county and court rules from the pack-building tool. They are kept exactly as they are.</div>' : ''}
                </div>
            </div>`;
    }

    // ---- Templates -----------------------------------------------------------------------
    function categoryOptions() {
        const v = E.view;
        const all = Array.from(new Set(v.suggestedCategories.concat(v.categories)));
        return `<datalist id="pe-categories">${all.map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist>`;
    }
    function conflictsHtml() {
        const list = E.conflicts;
        if (!list.length) return '';
        const rows = list.map((c, i) => `
                <li class="py-2 flex items-center justify-between gap-3" data-pe-conflict="${i}">
                    <div class="min-w-0 text-xs">
                        <div class="text-white truncate">${esc(c.file)}</div>
                        <div class="text-gray-400">Looks like <span class="text-gray-200">${esc(c.title)}</span>, already in the pack</div>
                    </div>
                    <div class="flex gap-2 shrink-0">
                        <button type="button" data-pe-act="dup-replace" data-idx="${i}" class="${BTN_PRIMARY}"
                            title="Use this file instead of the current one. Fields still in it keep their settings.">Replace ${esc(c.title)}</button>
                        <button type="button" data-pe-act="dup-add" data-idx="${i}" class="${BTN}"
                            title="Keep both. The new one is added with a number after its name.">Add as a separate template</button>
                        <button type="button" data-pe-act="dup-skip" data-idx="${i}" class="${BTN}">Skip</button>
                    </div>
                </li>`).join('');
        return `
            <div class="mb-4 p-3 rounded-lg border border-amber-500/50 bg-amber-500/5" data-pe-conflicts>
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <div class="text-sm text-white font-semibold">${list.length === 1 ? 'This template is already in the pack' : `${list.length} of these templates are already in the pack`}</div>
                        <div class="text-xs text-gray-400">If it is a newer version of the same document, replace the old one so officers don't see it twice.</div>
                    </div>
                    ${list.length > 1 ? `<button type="button" data-pe-act="dup-replace-all" class="${BTN_PRIMARY} shrink-0">Replace all ${list.length}</button>` : ''}
                </div>
                <ul class="divide-y divide-gray-700/40 mt-1">${rows}</ul>
            </div>`;
    }
    function noticeHtml() {
        const n = E.notice;
        if (!n) return conflictsHtml();
        const lines = n.lines.map(l => `<li class="${l.cls || 'text-gray-300'}">${l.html}</li>`).join('');
        return conflictsHtml() + `
            <div class="mb-4 p-3 rounded-lg border ${n.error ? 'border-rose-500/40 bg-rose-500/5' : 'border-viper-cyan/40 bg-viper-cyan/5'}" data-pe-notice>
                <div class="flex items-start justify-between gap-3">
                    <div class="text-sm text-white font-semibold">${esc(n.title)}</div>
                    <button type="button" data-pe-act="dismiss" class="text-gray-400 hover:text-white text-xs">✕</button>
                </div>
                <ul class="text-xs mt-1 space-y-0.5 list-disc ml-5">${lines}</ul>
            </div>`;
    }
    function templatesHtml() {
        const v = E.view;
        const groups = new Map();
        v.templates.forEach(t => { if (!groups.has(t.category)) groups.set(t.category, []); groups.get(t.category).push(t); });
        const cats = Array.from(groups.keys()).sort((a, z) => a.localeCompare(z));
        const row = (t) => {
            const warn = [];
            if (!t.fieldCount) warn.push('<span class="text-rose-300">No fill-in fields found</span>');
            if (t.unhighlighted.length) warn.push(`<span class="text-amber-300">${plural(t.unhighlighted.length, '[bracket] is', '[brackets] are')} not highlighted</span>`);
            if (t.unclosed.length) warn.push(`<span class="text-amber-300">${plural(t.unclosed.length, '[ is', '[ are')} never closed</span>`);
            const showNotes = E.openNotes[t.rel];
            const notes = showNotes ? `
                <div class="mt-2 text-[11px] text-gray-400 space-y-1">
                    ${t.unhighlighted.length ? `<div>Not highlighted, so left as typed: ${t.unhighlighted.slice(0, 20).map(s => `<span class="text-gray-200">[${esc(s)}]</span>`).join(', ')}${t.unhighlighted.length > 20 ? ' …' : ''}</div>` : ''}
                    ${t.unclosed.length ? `<div>Opened with [ but never closed: ${t.unclosed.slice(0, 10).map(s => `<span class="text-gray-200">“${esc(s)}”</span>`).join(', ')}</div>` : ''}
                    <div class="text-gray-500">If any of these should be fill-in fields, highlight them in Word, save, then use Replace.</div>
                </div>` : '';
            return `
                <div class="p-3 rounded-lg border border-gray-700/60 bg-viper-dark/40" data-pe-tpl="${esc(t.rel)}">
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                            <div class="text-sm text-white">${esc(t.title)}</div>
                            <div class="text-[11px] text-gray-400">${plural(t.fieldCount, 'field')}${warn.length ? ' · ' + warn.join(' · ') : ''}
                                ${t.unhighlighted.length || t.unclosed.length ? `<button type="button" data-pe-act="notes" data-rel="${esc(t.rel)}" class="ml-1 underline text-gray-400 hover:text-gray-200">${showNotes ? 'hide' : 'show'}</button>` : ''}</div>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                            <input list="pe-categories" data-pe-cat="${esc(t.rel)}" data-pe-focus="cat-${esc(t.rel)}" value="${esc(t.category)}" title="Category"
                                class="w-44 px-2 py-1 text-xs rounded bg-viper-dark border border-gray-600 text-gray-200">
                            <button type="button" data-pe-act="preview" data-rel="${esc(t.rel)}" class="${BTN}" title="Open this template in Word with each field shown as a box">Preview in Word</button>
                            <button type="button" data-pe-act="replace" data-rel="${esc(t.rel)}" class="${BTN}" title="Use a newer Word file for this template">Replace…</button>
                            <button type="button" data-pe-act="remove-tpl" data-rel="${esc(t.rel)}" class="${BTN_DANGER}">Remove</button>
                        </div>
                    </div>
                    ${notes}
                </div>`;
        };
        return `
            ${categoryOptions()}
            ${noticeHtml()}
            <div data-pe-drop class="mb-5 p-5 rounded-xl border-2 border-dashed border-gray-600 text-center transition-colors">
                <div class="text-sm text-gray-200">Drop Word templates (.docx) here</div>
                <div class="text-xs text-gray-400 mt-1">Each highlighted <span class="text-gray-200">[Field name]</span> in the document becomes a box officers fill in. <button type="button" data-pe-tab="help" class="underline hover:text-gray-200">How to mark fields</button></div>
                <div class="mt-3 flex items-center justify-center gap-2 text-xs text-gray-400">
                    <span>Category for new templates</span>
                    <input list="pe-categories" data-pe-newcat data-pe-focus="newcat" value="${esc(E.newCategory)}" class="w-48 px-2 py-1 text-xs rounded bg-viper-dark border border-gray-600 text-gray-200">
                    <button type="button" data-pe-act="add" class="${BTN_PRIMARY}">Choose files…</button>
                </div>
            </div>
            ${v.templates.length ? cats.map(c => `
                <div class="mb-4">
                    <div class="text-xs uppercase tracking-wider text-gray-500 mb-2">${esc(c)} (${groups.get(c).length})</div>
                    <div class="space-y-2">${groups.get(c).map(row).join('')}</div>
                </div>`).join('') : '<div class="text-sm text-gray-500 italic">No templates yet.</div>'}`;
    }

    // ---- Fields --------------------------------------------------------------------------
    const allFields = () => E.view.fields.shared.concat(E.view.fields.own);
    const titleOf = (rel) => { const t = E.view.templates.find(x => x.rel === rel); return t ? t.title : rel; };
    function kindText(f) { return (E.view.kindLabels[f.effectiveKind] || f.effectiveKind) + (f.kind ? '' : ' (auto)'); }
    function autofillText(a) {
        if (!a || a === 'none') return '';
        return E.view.autofillLabels[a] || a;
    }
    function matches(f) {
        const q = E.filter.trim().toLowerCase();
        if (!q) return true;
        return f.label.toLowerCase().includes(q) || f.uses.some(u => u.name.toLowerCase().includes(q) || titleOf(u.rel).toLowerCase().includes(q));
    }
    function contextHtml(u) {
        if (!u.context) return '<span class="text-gray-600">—</span>';
        const needle = '[' + u.name + ']';
        const s = String(u.context);
        const i = s.indexOf(needle);
        if (i < 0) return esc(s);
        return esc(s.slice(0, i)) + `<mark class="bg-amber-400/30 text-amber-100 rounded px-0.5">${esc(needle)}</mark>` + esc(s.slice(i + needle.length));
    }

    function fieldsHtml() {
        return `
            <div class="flex items-center gap-3 mb-3">
                <input data-pe-filter data-pe-focus="filter" class="${INPUT} max-w-sm" placeholder="Find a field or template…" value="${esc(E.filter)}">
                <div class="text-xs text-gray-400">Click a field to change how it is filled in. Changes are kept as you go.</div>
            </div>
            <div data-pe-fieldlist>${fieldListHtml()}</div>`;
    }
    function fieldListHtml() {
        const v = E.view;
        if (!v.templates.length) return '<div class="text-sm text-gray-500 italic">Add a Word template first.</div>';
        const shared = v.fields.shared.filter(matches);
        const own = v.fields.own.filter(matches);
        const byTpl = new Map();
        own.forEach(f => { const rel = f.uses[0].rel; if (!byTpl.has(rel)) byTpl.set(rel, []); byTpl.get(rel).push(f); });
        const tplOrder = Array.from(byTpl.keys()).sort((a, z) => titleOf(a).localeCompare(titleOf(z)));
        const none = !shared.length && !own.length ? '<div class="text-sm text-gray-500 italic">No fields match.</div>' : '';
        return `
            ${shared.length ? `
            <div class="mb-5">
                <div class="text-xs uppercase tracking-wider text-gray-500">Shared fields (${shared.length})</div>
                <div class="text-[11px] text-gray-500 mb-2">Asked once and filled into every template that uses them. Fields with the same name are linked for you.</div>
                <div class="space-y-1.5">${shared.map(fieldRow).join('')}</div>
            </div>` : ''}
            ${tplOrder.map(rel => `
            <div class="mb-4">
                <div class="text-xs uppercase tracking-wider text-gray-500 mb-2">Only in ${esc(titleOf(rel))} (${byTpl.get(rel).length})</div>
                <div class="space-y-1.5">${byTpl.get(rel).map(fieldRow).join('')}</div>
            </div>`).join('')}
            ${none}`;
    }

    function fieldRow(f) {
        const open = E.expanded === f.key;
        const badges = [`<span class="text-gray-400">${esc(kindText(f))}</span>`];
        const af = autofillText(f.effectiveAutofill);
        if (af) badges.push(`<span class="text-emerald-300">fills from: ${esc(af)}</span>`);
        if (f.effectiveHidden) badges.push('<span class="text-amber-300">hidden on the form</span>');
        if (f.shared) badges.push(`<span class="text-viper-cyan">${plural(f.uses.length, 'template')}</span>`);
        if (f.hint) badges.push('<span class="text-gray-500">has a hint</span>');
        return `
            <div class="rounded-lg border ${open ? 'border-viper-cyan/50 bg-viper-cyan/5' : 'border-gray-700/60 bg-viper-dark/40'}" data-pe-field="${esc(f.key)}">
                <button type="button" data-pe-act="toggle" data-key="${esc(f.key)}" class="w-full text-left px-3 py-2 flex items-center justify-between gap-3">
                    <span class="text-sm text-white truncate">${esc(f.label)}</span>
                    <span class="text-[11px] flex gap-2 shrink-0">${badges.join('<span class="text-gray-600">·</span>')}</span>
                </button>
                ${open ? fieldEditorHtml(f) : ''}
            </div>`;
    }

    function fieldEditorHtml(f) {
        const v = E.view;
        const k = esc(f.key);
        const fid = (s) => `${s}-${f.key}`;
        const kindOpts = [`<option value="" ${!f.kind ? 'selected' : ''}>Automatic — ${esc(v.kindLabels[f.effectiveKind] || f.effectiveKind)}</option>`]
            .concat(Object.keys(v.kindLabels).map(x => `<option value="${x}" ${f.kind === x ? 'selected' : ''}>${esc(v.kindLabels[x])}</option>`)).join('');
        const autoName = f.autofill ? '' : autofillText(f.effectiveAutofill);
        const caseOpts = Object.keys(v.autofillLabels).filter(x => x.startsWith('case:'));
        const profOpts = Object.keys(v.autofillLabels).filter(x => x.startsWith('profile:'));
        const opt = (x) => `<option value="${x}" ${f.autofill === x ? 'selected' : ''}>${esc(v.autofillLabels[x])}</option>`;
        const autoOpts = `<option value="" ${!f.autofill ? 'selected' : ''}>Automatic — ${autoName ? esc(autoName) : 'nothing'}</option>
            <option value="none" ${f.autofill === 'none' ? 'selected' : ''}>Don't fill it in</option>
            <optgroup label="From the case">${caseOpts.map(opt).join('')}</optgroup>
            <optgroup label="From the officer's profile">${profOpts.map(opt).join('')}</optgroup>`;
        const hiddenVal = f.hidden === true ? 'hide' : f.hidden === false ? 'show' : '';
        const hidOpts = `<option value="" ${hiddenVal === '' ? 'selected' : ''}>Automatic — ${f.effectiveHidden ? 'hidden' : 'shown'}</option>
            <option value="show" ${hiddenVal === 'show' ? 'selected' : ''}>Show it</option>
            <option value="hide" ${hiddenVal === 'hide' ? 'selected' : ''}>Hide it (filled in automatically or left as is)</option>`;
        const others = allFields().filter(x => x.key !== f.key)
            .map(x => ({ key: x.key, text: x.label + (x.shared ? ` — shared (${x.uses.length})` : ` — ${titleOf(x.uses[0].rel)}`) }))
            .sort((a, z) => a.text.localeCompare(z.text));
        const uses = f.uses.map(u => `
            <li class="flex items-start justify-between gap-3 py-1">
                <div class="min-w-0">
                    <div class="text-xs text-gray-200">${esc(titleOf(u.rel))} <span class="text-gray-500">· [${esc(u.name)}]</span></div>
                    <div class="text-[11px] text-gray-400 italic">${contextHtml(u)}</div>
                </div>
                ${f.shared && f.uses.length > 1 ? `<button type="button" data-pe-act="split" data-key="${k}" data-rel="${esc(u.rel)}" data-name="${esc(u.name)}" class="${BTN} shrink-0" title="Ask for this one separately">Separate</button>` : ''}
            </li>`).join('');
        return `
            <div class="px-3 pb-3 pt-1 border-t border-gray-700/50 grid grid-cols-2 gap-x-4 gap-y-3" data-pe-editor="${k}">
                <label class="block"><span class="text-[11px] text-gray-400">Label on the form</span>
                    <input data-pe-f="label" data-key="${k}" data-pe-focus="${esc(fid('label'))}" class="${INPUT} mt-1" maxlength="200" value="${esc(f.label)}"></label>
                <label class="block"><span class="text-[11px] text-gray-400">Type of answer</span>
                    <select data-pe-f="kind" data-key="${k}" data-pe-focus="${esc(fid('kind'))}" class="${INPUT} mt-1">${kindOpts}</select></label>
                ${f.effectiveKind === 'dropdown' ? `
                <label class="block col-span-2"><span class="text-[11px] text-gray-400">Choices (one per line)</span>
                    <textarea data-pe-f="choices" data-key="${k}" data-pe-focus="${esc(fid('choices'))}" class="${INPUT} mt-1" rows="4">${esc(f.choices.join('\n'))}</textarea></label>` : ''}
                <label class="block col-span-2"><span class="text-[11px] text-gray-400">Hint shown under the box (optional)</span>
                    <input data-pe-f="hint" data-key="${k}" data-pe-focus="${esc(fid('hint'))}" class="${INPUT} mt-1" maxlength="500" value="${esc(f.hint)}" placeholder="e.g. As it appears on the provider's records"></label>
                <label class="block"><span class="text-[11px] text-gray-400">Fill in automatically</span>
                    <select data-pe-f="autofill" data-key="${k}" data-pe-focus="${esc(fid('autofill'))}" class="${INPUT} mt-1">${autoOpts}</select></label>
                <label class="block"><span class="text-[11px] text-gray-400">On the form</span>
                    <select data-pe-f="hidden" data-key="${k}" data-pe-focus="${esc(fid('hidden'))}" class="${INPUT} mt-1">${hidOpts}</select></label>
                <div class="col-span-2">
                    <div class="text-[11px] text-gray-400">Where it appears</div>
                    <ul class="divide-y divide-gray-700/40">${uses}</ul>
                </div>
                <div class="col-span-2 flex items-center gap-2">
                    <span class="text-[11px] text-gray-400 shrink-0">Same answer as</span>
                    <select data-pe-merge-with data-pe-focus="${esc(fid('merge'))}" class="${INPUT} !py-1 text-xs">
                        <option value="">choose another field…</option>
                        ${others.map(o => `<option value="${esc(o.key)}">${esc(o.text)}</option>`).join('')}
                    </select>
                    <button type="button" data-pe-act="merge" data-key="${k}" class="${BTN} shrink-0" title="Ask once and fill both places with the same answer">Combine</button>
                </div>
            </div>`;
    }

    // ---- How it works -------------------------------------------------------------------
    function helpHtml() {
        const li = (t) => `<li class="pl-1">${t}</li>`;
        return `
            <div class="max-w-3xl text-sm text-gray-300 space-y-5">
                <section>
                    <h4 class="text-white font-semibold mb-2">1. Mark the fill-in spots in Word</h4>
                    <ol class="list-decimal ml-5 space-y-1.5">
                        ${li('Where an officer should type something, write a short name in square brackets: <span class="text-white">[Suspect name]</span>, <span class="text-white">[Account number]</span>, <span class="text-white">[Date range]</span>.')}
                        ${li('Select the whole thing, brackets included, and highlight it (Home → <span class="text-white">Text Highlight Color</span>, any color). Only highlighted brackets become fields; plain [brackets] stay as typed.')}
                        ${li('Use exactly the same name wherever the same answer goes, in any template. VIPER links them, so the officer types it once.')}
                        ${li('For a choice, separate the options with a slash: <span class="text-white">[his/her]</span>, <span class="text-white">[NORTH/SOUTH]</span> gives a dropdown list.')}
                        ${li('Save the document as a Word document (.docx).')}
                    </ol>
                </section>
                <section>
                    <h4 class="text-white font-semibold mb-2">2. Build the pack here</h4>
                    <ol class="list-decimal ml-5 space-y-1.5">
                        ${li('<span class="text-white">Templates</span>: drop the .docx files and give each a category (Search Warrant, Arrest Warrant, …). VIPER warns about brackets that are not highlighted or never closed.')}
                        ${li('<span class="text-white">Fields</span>: check each field. Pick the type of answer (text, date, date range, dropdown, formatted text, text and photos), add a hint, and choose whether it fills in automatically from the case or the officer\'s profile.')}
                        ${li('Two names that mean the same thing (e.g. [Suspect] and [Suspect name])? Open one and use <span class="text-white">Same answer as → Combine</span>. Use <span class="text-white">Separate</span> to undo a link.')}
                        ${li('<span class="text-white">Preview in Word</span> opens a template the way VIPER will fill it: each field is a box marked with its name, so you can check that every blank was found.')}
                    </ol>
                </section>
                <section>
                    <h4 class="text-white font-semibold mb-2">3. Save and share</h4>
                    <ol class="list-decimal ml-5 space-y-1.5">
                        ${li('<span class="text-white">Save pack</span> installs it on this computer; the version number goes up each time. It shows on a case under Warrant Author → Agency Templates.')}
                        ${li('To share it, use <span class="text-white">Export</span> next to the pack in Settings and give the .viperpack file to other officers. They install it with <span class="text-white">Install pack…</span>.')}
                        ${li('To change the wording later, edit the Word file, then <span class="text-white">Replace…</span> the template here (or drop the file on it). Fields that are still there keep their settings; new and removed fields are listed. Adding a file with the same name as a template already in the pack asks whether to replace it.')}
                    </ol>
                </section>
                <p class="text-xs text-gray-500">The wording of the documents is edited in Word, not in VIPER. Your work is kept as a draft as you go, even if you close this window.</p>
            </div>`;
    }

    // ---- Events ----------------------------------------------------------------------------
    const fieldByKey = (key) => allFields().find(f => f.key === key) || null;

    async function onClick(e) {
        const tabBtn = e.target.closest && e.target.closest('[data-pe-tab]');
        if (tabBtn) { E.tab = tabBtn.getAttribute('data-pe-tab'); render(); return; }
        const b = e.target.closest && e.target.closest('[data-pe-act]');
        if (!b || b.disabled) return;
        const act = b.getAttribute('data-pe-act');
        const rel = b.getAttribute('data-rel');
        const key = b.getAttribute('data-key');
        if (act === 'close') return close();
        if (act === 'dismiss') { E.notice = null; render(); return; }
        if (act === 'notes') { E.openNotes[rel] = !E.openNotes[rel]; render(); return; }
        if (act === 'toggle') { E.expanded = E.expanded === key ? null : key; render(); return; }
        if (act === 'add') return addTemplates(null);
        if (act === 'replace') return replaceTemplate(rel);
        if (act === 'preview') return preview(rel);
        if (act === 'remove-tpl') return removeTemplate(rel);
        if (act === 'save') return save();
        if (act === 'start-over') return startOver();
        if (act === 'dup-replace' || act === 'dup-add' || act === 'dup-skip') {
            const c = E.conflicts[Number(b.getAttribute('data-idx'))];
            if (!c) return;
            E.conflicts = E.conflicts.filter(x => x !== c);
            if (act === 'dup-skip') { render(); return; }
            if (act === 'dup-replace') return replaceTemplate(c.rel, c.path);
            const t = E.view.templates.find(x => x.rel === c.rel);
            return addTemplates([c.path], { duplicates: 'add', category: t ? t.category : undefined });
        }
        if (act === 'dup-replace-all') return replaceAll();
        if (act === 'split') {
            const f = fieldByKey(key);
            const name = b.getAttribute('data-name');
            await op('splitField', { ref: key, rel, name }, 'Separating…');
            if (f) E.expanded = (E.view.fields.shared.find(x => x.key === key) ? key : null);
            render();
            return;
        }
        if (act === 'merge') {
            const sel = E.el.querySelector(`[data-pe-editor="${CSS.escape(key)}"] [data-pe-merge-with]`);
            const from = sel && sel.value;
            if (!from) return toast('Choose the field that takes the same answer', 'warning');
            const into = fieldByKey(key);
            const other = fieldByKey(from);
            const ok = await confirmBox(`Ask once for "${into ? into.label : ''}" and use the answer for "${other ? other.label : ''}" too?\n\nThe combined field keeps the settings of "${into ? into.label : ''}". You can separate them again later.`, { okText: 'Combine' });
            if (!ok) return;
            const r = await op('mergeFields', { into: key, from }, 'Combining…');
            if (r && into) {
                const use = into.uses[0];
                const g = E.view.fields.shared.find(x => x.uses.some(u => u.rel === use.rel && u.name === use.name));
                E.expanded = g ? g.key : null;
                render();
            }
        }
    }

    function onChange(e) {
        const t = e.target;
        if (t.hasAttribute('data-pe-meta')) {
            const k = t.getAttribute('data-pe-meta');
            const val = t.value;
            if (k === 'name' && !val.trim()) { toast('The pack needs a name', 'warning'); t.value = E.view.meta.name; return; }
            op('setMeta', { [k]: val });
            return;
        }
        if (t.hasAttribute('data-pe-cat')) { op('setCategory', { rel: t.getAttribute('data-pe-cat'), category: t.value }); return; }
        if (t.hasAttribute('data-pe-newcat')) { E.newCategory = t.value.trim() || 'Search Warrant'; return; }
        if (t.hasAttribute('data-pe-f')) {
            const key = t.getAttribute('data-key');
            const which = t.getAttribute('data-pe-f');
            const patch = {};
            if (which === 'label') {
                if (!t.value.trim()) { toast('A field needs a label', 'warning'); const f = fieldByKey(key); t.value = f ? f.label : ''; return; }
                patch.label = t.value;
            } else if (which === 'choices') patch.choices = t.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            else if (which === 'hidden') patch.hidden = t.value === 'hide' ? true : t.value === 'show' ? false : null;
            else patch[which] = t.value;
            op('updateField', { ref: key, patch });
        }
    }

    function onInput(e) {
        if (!e.target.hasAttribute('data-pe-filter')) return;
        E.filter = e.target.value;
        const list = E.el.querySelector('[data-pe-fieldlist]');
        if (list) list.innerHTML = fieldListHtml();
    }

    function onDrop(e) {
        e.preventDefault();
        E.el.querySelectorAll('[data-pe-drop]').forEach(d => d.classList.remove('border-viper-cyan'));
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (!files.length) return;
        const getPath = api().getPathForFile;
        const paths = files.map(f => (typeof getPath === 'function' ? getPath(f) : f.path) || '').filter(Boolean);
        if (!paths.length) return toast('Could not read the dropped files', 'error');
        const row = e.target.closest && e.target.closest('[data-pe-tpl]');
        if (row && paths.length === 1) return replaceTemplate(row.getAttribute('data-pe-tpl'), paths[0]);
        if (E.tab !== 'templates') E.tab = 'templates';
        return addTemplates(paths);
    }

    // ---- Actions ---------------------------------------------------------------------------
    function addTemplates(paths, opts) {
        opts = opts || {};
        return queue('Reading Word files…', async () => {
            const req = { id: E.id, paths: paths || undefined, category: opts.category || E.newCategory };
            if (opts.duplicates === 'add') req.duplicates = 'add';
            const r = await api().agencyPackDraftAddTemplates(req);
            if (!take(r, 'Could not add the templates')) return;
            const conflicts = Array.isArray(r.conflicts) ? r.conflicts : [];
            // A file chosen again replaces its earlier, still unanswered question.
            E.conflicts = E.conflicts.filter(c => !conflicts.some(n => n.path === c.path)).concat(conflicts);
            const ok = r.results.filter(x => !x.error);
            const bad = r.results.filter(x => x.error);
            const lines = ok.map(x => {
                const extra = [];
                if (x.linked) extra.push(`${x.linked} linked to fields in other templates`);
                if (x.unhighlighted) extra.push(`<span class="text-amber-300">${plural(x.unhighlighted, '[bracket]')} not highlighted</span>`);
                if (x.unclosed) extra.push(`<span class="text-amber-300">${plural(x.unclosed, 'unclosed [')}</span>`);
                if (!x.fields) extra.push('<span class="text-rose-300">no highlighted [fields] found</span>');
                return { html: `<span class="text-white">${esc(x.title)}</span>: ${plural(x.fields, 'field')}${extra.length ? ' · ' + extra.join(' · ') : ''}` };
            }).concat(bad.map(x => ({ cls: 'text-rose-300', html: esc(x.error) })));
            if (lines.length) E.notice = { title: ok.length ? `Added ${plural(ok.length, 'template')}` : 'Nothing was added', error: !ok.length, lines };
            else if (conflicts.length) E.notice = null;
            E.tab = 'templates';
            render();
        });
    }

    function replacedLines(x) {
        const lines = [{ html: `${plural(x.kept, 'field')} kept with ${x.kept === 1 ? 'its' : 'their'} settings` }];
        if (x.added.length) lines.push({ cls: 'text-viper-cyan', html: `New: ${x.added.map(n => '[' + esc(n) + ']').join(', ')} — check them under Fields` });
        if (x.removed.length) lines.push({ cls: 'text-amber-300', html: `No longer in the document: ${x.removed.map(n => '[' + esc(n) + ']').join(', ')}` });
        if (x.unhighlighted) lines.push({ cls: 'text-amber-300', html: `${plural(x.unhighlighted, '[bracket]')} not highlighted` });
        if (x.unclosed) lines.push({ cls: 'text-amber-300', html: plural(x.unclosed, 'unclosed [') });
        return lines;
    }

    function replaceTemplate(rel, path) {
        return queue('Reading the new Word file…', async () => {
            const r = await api().agencyPackDraftReplaceTemplate({ id: E.id, rel, path: path || undefined });
            if (!take(r, 'Could not replace the template')) return;
            const x = r.result;
            E.notice = { title: `Replaced ${x.title}`, lines: replacedLines(x) };
            E.tab = 'templates';
            render();
        });
    }

    // Every listed file replaces the template it matched (one file per template; the rest stay listed).
    function replaceAll() {
        const seen = new Set();
        const todo = E.conflicts.filter(c => (seen.has(c.rel) ? false : (seen.add(c.rel), true)));
        E.conflicts = E.conflicts.filter(c => !todo.includes(c));
        return queue('Replacing templates…', async () => {
            const lines = [];
            let done = 0;
            for (const c of todo) {
                const r = await api().agencyPackDraftReplaceTemplate({ id: E.id, rel: c.rel, path: c.path });
                if (!r || !r.success) { lines.push({ cls: 'text-rose-300', html: `${esc(c.file)}: ${esc((r && r.error) || 'could not be read')}` }); continue; }
                if (r.draft) E.view = r.draft;
                done++;
                const x = r.result;
                const extra = [];
                if (x.added.length) extra.push(`<span class="text-viper-cyan">new: ${x.added.map(n => '[' + esc(n) + ']').join(', ')}</span>`);
                if (x.removed.length) extra.push(`<span class="text-amber-300">gone: ${x.removed.map(n => '[' + esc(n) + ']').join(', ')}</span>`);
                if (x.unhighlighted) extra.push(`<span class="text-amber-300">${plural(x.unhighlighted, '[bracket]')} not highlighted</span>`);
                lines.push({ html: `<span class="text-white">${esc(x.title)}</span>: ${plural(x.kept, 'field')} kept${extra.length ? ' · ' + extra.join(' · ') : ''}` });
            }
            E.notice = { title: done ? `Replaced ${plural(done, 'template')}` : 'Nothing was replaced', error: !done, lines };
            E.tab = 'templates';
            render();
        });
    }

    function preview(rel) {
        return queue('Opening in Word…', async () => {
            const r = await api().agencyPackDraftPreview({ id: E.id, rel });
            if (r && !r.success) toast(r.error || 'Could not open the preview', 'error');
        });
    }

    async function removeTemplate(rel) {
        const t = E.view.templates.find(x => x.rel === rel);
        const ok = await confirmBox(`Remove "${t ? t.title : rel}" from this pack?\n\nIts field settings are removed with it. Documents already made are not affected.`, { danger: true, okText: 'Remove template' });
        if (!ok) return;
        delete E.openNotes[rel];
        E.conflicts = E.conflicts.filter(c => c.rel !== rel);
        await op('removeTemplate', { rel }, 'Removing…');
    }

    async function save() {
        const st = E.view && E.view.stale;
        let force = false;
        if (st) {
            const ok = await confirmBox(
                `Version ${st.installedVersion} of this pack was installed after you made these changes (they were made to version ${st.baseVersion}).\n\nSaving now replaces version ${st.installedVersion} with your changes, and anything that changed in version ${st.installedVersion} is lost.\n\nTo keep version ${st.installedVersion}, cancel and choose "Start from version ${st.installedVersion}".`,
                { danger: true, okText: `Replace version ${st.installedVersion}` });
            if (!ok) return;
            force = true;
        }
        return queue('Saving the pack…', async () => {
            const r = await api().agencyPackDraftSave(force ? { id: E.id, force: true } : E.id);
            if (!take(r, 'Could not save the pack')) return;
            E.resumed = false;
            const p = r.pack || {};
            toast(`${p.name || 'Pack'} saved as version ${p.packVersion} (${plural(p.templateCount || 0, 'template')})`, 'success');
            render();
            try { if (window.ViperAgencyPacksSettings) window.ViperAgencyPacksSettings.refresh(); } catch (_) { /* ignore */ }
        });
    }

    async function startOver() {
        const st = E.view && E.view.stale;
        const msg = st
            ? `Throw away your unsaved changes and load version ${st.installedVersion}, the one installed now?\n\nIf you still need some of your changes, make them again on version ${st.installedVersion}.`
            : 'Discard the changes that were never saved and start again from the installed pack?';
        const ok = await confirmBox(msg, { danger: true, okText: st ? `Load version ${st.installedVersion}` : 'Discard changes' });
        if (!ok) return;
        await queue('Loading the installed pack…', async () => {
            const r = await api().agencyPackDraftOpen({ id: E.id, fresh: true });
            if (!take(r, 'Could not load the installed pack')) return;
            E.resumed = false; E.expanded = null; E.notice = null; E.openNotes = {}; E.conflicts = [];
            render();
        });
    }

    const API = { open, close, _state: E };
    if (typeof window !== 'undefined') window.ViperPackEditor = API;
})();
