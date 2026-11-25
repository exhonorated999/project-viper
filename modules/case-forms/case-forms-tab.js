/**
 * modules/case-forms/case-forms-tab.js — the case page's "Forms" tab.
 *
 * Pick a form from an installed agency form set, say who is on it (the
 * subject, a parent, a vehicle...), check the values VIPER filled in from the
 * case, type what it could not, then open it to print or save it into the
 * case's Forms folder. Nothing typed here is kept outside the filled PDF.
 *
 *   window.ViperCaseFormsTab.mount(el, ctx)
 *     ctx: { caseId, caseNumber, currentCase, getStores() → { suspects, victims,
 *            witnesses, involvedPersons, recoveredVehicles }, offenseDescription,
 *            toast(msg, kind) }
 *
 * The pure helpers at the top also load under node for tests.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root && root.document) root.ViperCaseFormsTab = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const Sources = () => (root && root.ViperCaseFormSources) || require('./form-sources.js');
    const str = (v) => (v == null ? '' : String(v)).trim();
    const LANG_NAMES = { en: 'English', es: 'Spanish' };
    const langName = (l) => LANG_NAMES[String(l || '').slice(0, 2)] || String(l || '').toUpperCase();
    const FILLABLE = new Set(['text', 'checkbox', 'dropdown', 'list', 'radio']);

    /* ── Pure helpers ─────────────────────────────────────────────────── */

    /**
     * The form list: forms sharing a `group` (one form in several languages)
     * become one entry. Returns [{ category, entries: [{ key, title, forms: [form] }] }].
     */
    function formGroups(forms) {
        const entries = [];
        const byGroup = new Map();
        (forms || []).forEach(f => {
            const g = str(f.group);
            if (g && byGroup.has(g)) { byGroup.get(g).forms.push(f); return; }
            const e = { key: g ? 'g:' + g : 'f:' + f.id, title: g || f.title, category: str(f.category) || 'Other', forms: [f] };
            if (g) byGroup.set(g, e);
            entries.push(e);
        });
        // A group with one form shows that form's own title.
        entries.forEach(e => { if (e.forms.length === 1) e.title = e.forms[0].title; });
        const cats = new Map();
        entries.forEach(e => {
            if (!cats.has(e.category)) cats.set(e.category, []);
            cats.get(e.category).push(e);
        });
        return [...cats.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b))
            .map(c => ({ category: c, entries: cats.get(c) }));
    }

    /**
     * Who fills each slot when the form is first opened: the first person
     * not already on another slot, trying the slot's roles in the order the
     * form lists them (['witness', 'victim'] prefers a witness).
     * A slot with no roles takes a suspect only when it is the form's first slot.
     */
    function defaultPicks(slots, people, vehicleSlots, vehicles) {
        const picks = {}, used = new Set();
        (slots || []).forEach((s, i) => {
            const roles = Array.isArray(s.roles) && s.roles.length ? s.roles : (i === 0 ? ['suspect'] : null);
            if (!roles) return;
            let hit = null;
            for (const role of roles) {
                hit = (people || []).find(p => p.role === role && !used.has(p.key));
                if (hit) break;
            }
            if (hit) { picks[s.id] = hit.key; used.add(hit.key); }
        });
        const vpicks = {};
        (vehicleSlots || []).forEach((s, i) => { if (vehicles && vehicles[i]) vpicks[s.id] = vehicles[i].key; });
        return { people: picks, vehicles: vpicks };
    }

    function describeBinding(b, slots, vehicleSlots) {
        if (!b || !b.src || b.src === 'ask') return { kind: 'ask', text: 'Type it' };
        if (b.src === 'const') return { kind: 'const', text: typeof b.value === 'boolean' ? (b.value ? 'Always checked' : 'Always unchecked') : 'Fixed text' };
        const src = Sources().SOURCE_BY_ID[b.src];
        if (!src) return { kind: 'ask', text: 'Type it' };
        let who = '';
        if (src.needs === 'person') { const s = (slots || []).find(x => x.id === b.slot); who = s ? s.label : b.slot; }
        else if (src.needs === 'vehicle') { const s = (vehicleSlots || []).find(x => x.id === b.slot); who = s ? s.label : b.slot; }
        else who = src.group;
        return { kind: 'case', text: (who ? who + ' · ' : '') + src.label };
    }

    /**
     * One row per fillable PDF field, in the PDF's reading order.
     * edited: { [field]: value } typed by the officer (wins over the case).
     */
    function computeRows(spec, ctxInput, edited) {
        const S = Sources();
        const form = spec.form || {};
        const bindings = form.bindings || {};
        const ctx = S.buildContext(ctxInput || {});
        const fields = (spec.pdf && spec.pdf.fields) || [];
        const rows = [];
        let skipped = 0;
        fields.forEach(f => {
            if (!FILLABLE.has(f.type) || f.readOnly) { skipped++; return; }
            const b = bindings[f.name];
            let how = describeBinding(b, form.slots, form.vehicleSlots);
            const bound = !!(b && b.src && b.src !== 'ask');
            let auto = bound ? S.resolve(b, ctx) : '';
            // Unbound field: start from what the blank form already holds.
            const preset = !bound && f.value != null && f.value !== '';
            if (preset) { auto = f.value; how = { kind: 'const', text: 'Form default' }; }
            if (f.type === 'checkbox') auto = auto === true || (typeof auto === 'string' && /^(true|yes|on|x|1)$/i.test(auto));
            const has = Object.prototype.hasOwnProperty.call(edited || {}, f.name);
            const value = has ? edited[f.name] : auto;
            rows.push({
                name: f.name, type: f.type, page: f.page, multiline: !!f.multiline, maxLength: f.maxLength || 0,
                options: Array.isArray(f.options) ? f.options : [], required: !!f.required,
                how, auto, value, edited: has, bound, preset,
                blank: f.type === 'checkbox' ? false : str(value) === '',
            });
        });
        return { rows, skipped };
    }

    /** What goes to the fill call: every value that says something, every bound box, and every box the officer changed. */
    function collectValues(rows) {
        const out = {};
        (rows || []).forEach(r => {
            if (r.type === 'checkbox') { if (r.value === true || r.edited || r.auto === true || r.bound) out[r.name] = !!r.value; return; }
            const v = r.value == null ? '' : String(r.value);
            if (v !== '' || r.edited) out[r.name] = v;
        });
        return out;
    }

    /** "DOE, John" for the file name: the first person slot, else the first vehicle's plate. */
    function nameHint(spec, ctxInput) {
        const S = Sources();
        const form = spec.form || {};
        const people = (ctxInput && ctxInput.people) || {};
        for (const s of form.slots || []) {
            if (people[s.id]) {
                const p = S.normPerson(people[s.id]);
                const v = p.lastName ? p.lastName.toUpperCase() + (p.firstName ? ', ' + p.firstName : '') : p.fullName;
                if (v) return v;
            }
        }
        const veh = (ctxInput && ctxInput.vehicles) || {};
        for (const s of form.vehicleSlots || []) {
            if (veh[s.id]) { const v = S.normVehicle(veh[s.id]); if (v.plate) return v.plate; }
        }
        return '';
    }

    const helpers = { formGroups, defaultPicks, describeBinding, computeRows, collectValues, nameHint, langName };
    if (!root || !root.document) return helpers;

    /* ── The tab (renderer only) ─────────────────────────────────────── */

    const api = () => root.electronAPI || {};
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const IN = 'w-full px-2 py-1 text-sm rounded bg-viper-dark border border-gray-600 text-white focus:border-viper-cyan focus:outline-none';
    const BTN = 'px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50';
    const BTN_MAIN = `${BTN} bg-viper-cyan/20 hover:bg-viper-cyan/30 border-viper-cyan text-viper-cyan`;
    const BTN_GREY = `${BTN} border-gray-600 text-gray-200 hover:bg-gray-700/40`;

    let S = null;   // state for the mounted case
    let el = null;

    function toast(msg, kind) {
        try { if (S && S.ctx.toast) return S.ctx.toast(msg, kind); } catch (_) { /* fall through */ }
        try { if (root.viperToast) root.viperToast(msg, kind); } catch (_) { /* ignore */ }
    }

    function officerProfile() {
        let raw = {};
        try { raw = JSON.parse(root.localStorage.getItem('viperAgencyProfile') || '{}') || {}; } catch (_) { raw = {}; }
        const AP = root.WarrantAuthorAgencyProfile;
        try { return AP && typeof AP.normalize === 'function' ? AP.normalize(raw) : raw; } catch (_) { return raw; }
    }

    function stores() {
        let s = {};
        try { s = (S.ctx.getStores && S.ctx.getStores()) || {}; } catch (_) { s = {}; }
        return s;
    }

    function ctxInput() {
        const st = stores();
        const people = {}, vehicles = {};
        Object.keys(S.picks.people).forEach(slot => {
            const p = S.people.find(x => x.key === S.picks.people[slot]);
            if (p) people[slot] = p.record;
        });
        Object.keys(S.picks.vehicles).forEach(slot => {
            const v = S.vehicles.find(x => x.key === S.picks.vehicles[slot]);
            if (v) vehicles[slot] = v.record;
        });
        return {
            currentCase: S.ctx.currentCase || { caseNumber: S.ctx.caseNumber },
            suspects: Array.isArray(st.suspects) ? st.suspects : [],
            offenseDescription: S.ctx.offenseDescription || '',
            officer: officerProfile(),
            people, vehicles,
            now: new Date(),
        };
    }

    function refreshPeople() {
        const st = stores();
        S.people = Sources().peopleFromCase(st);
        S.vehicles = Sources().vehiclesFromCase(st);
    }

    async function mount(target, ctx) {
        el = target;
        if (!el) return;
        const sameCase = S && S.ctx && S.ctx.caseId === (ctx && ctx.caseId);
        if (!sameCase) {
            S = { ctx: ctx || {}, sets: [], setId: '', entryKey: '', formId: '', spec: null, loadingForm: false,
                picks: { people: {}, vehicles: {} }, edited: {}, onlyBlank: false, busy: false, files: [], people: [], vehicles: [], error: '' };
        } else {
            S.ctx = ctx || S.ctx;
        }
        if (!el.__cfWired) {
            el.__cfWired = true;
            el.addEventListener('click', onClick);
            el.addEventListener('change', onChange);
            el.addEventListener('input', onInput);
        }
        refreshPeople();
        el.innerHTML = '<div class="text-sm text-gray-400">Loading forms…</div>';
        await loadSets();
        await loadFiles();
        if (S.formId && S.spec) S.rows = computeRows(S.spec, ctxInput(), S.edited);
        render();
    }

    async function loadSets() {
        const fn = api().caseFormsInstalled;
        if (typeof fn !== 'function') { S.sets = []; S.error = 'Agency forms are not available in this build.'; return; }
        try {
            const r = await fn();
            S.sets = r && r.success ? (r.sets || []).filter(s => !s.error) : [];
            S.error = r && !r.success ? (r.error || 'Could not list form sets') : '';
        } catch (e) { S.sets = []; S.error = String(e && e.message || e); }
        try { root.localStorage.setItem('viperCaseFormsAvailable', S.sets.length ? 'true' : 'false'); } catch (_) { /* ignore */ }
        if (!S.sets.find(s => s.id === S.setId)) { S.setId = S.sets[0] ? S.sets[0].id : ''; S.entryKey = ''; S.formId = ''; S.spec = null; }
    }

    async function loadFiles() {
        const fn = api().caseFormsCaseFiles;
        if (typeof fn !== 'function' || !S.ctx.caseNumber) { S.files = []; return; }
        try {
            const r = await fn({ caseNumber: S.ctx.caseNumber });
            S.files = r && r.success ? (r.files || []) : [];
        } catch (_) { S.files = []; }
    }

    const currentSet = () => S.sets.find(s => s.id === S.setId) || null;

    async function openForm(formId, keepPicks) {
        const set = currentSet();
        if (!set || !formId) return;
        S.formId = formId; S.loadingForm = true; S.spec = null; S.edited = {}; render();
        try {
            const r = await api().caseFormsGetForm({ setId: set.id, formId });
            if (S.formId !== formId) return;
            if (!r || !r.success) { toast((r && r.error) || 'Could not open that form', 'error'); S.formId = ''; return; }
            S.spec = r;
            refreshPeople();
            const prev = S.picks;
            const def = defaultPicks(r.form.slots, S.people, r.form.vehicleSlots, S.vehicles);
            S.picks = { people: {}, vehicles: {} };
            (r.form.slots || []).forEach(s => {
                const keep = keepPicks && prev.people[s.id] && S.people.some(p => p.key === prev.people[s.id]);
                if (keep) S.picks.people[s.id] = prev.people[s.id]; else if (def.people[s.id]) S.picks.people[s.id] = def.people[s.id];
            });
            (r.form.vehicleSlots || []).forEach(s => {
                const keep = keepPicks && prev.vehicles[s.id] && S.vehicles.some(v => v.key === prev.vehicles[s.id]);
                if (keep) S.picks.vehicles[s.id] = prev.vehicles[s.id]; else if (def.vehicles[s.id]) S.picks.vehicles[s.id] = def.vehicles[s.id];
            });
            S.rows = computeRows(S.spec, ctxInput(), S.edited);
        } catch (e) {
            toast('Could not open that form: ' + (e && e.message || e), 'error');
            S.formId = '';
        } finally {
            S.loadingForm = false;
            render();
        }
    }

    function recompute() {
        if (!S.spec) return;
        S.rows = computeRows(S.spec, ctxInput(), S.edited);
    }

    async function fill(mode) {
        if (S.busy || !S.spec) return;
        recompute();
        const input = ctxInput();
        const req = {
            setId: S.spec.set.id, formId: S.spec.form.id, mode,
            values: collectValues(S.rows.rows),
            caseNumber: S.ctx.caseNumber || '',
            nameHint: nameHint(S.spec, input),
        };
        S.busy = true; render();
        try {
            const r = await api().caseFormsFill(req);
            if (!r || r.canceled) return;
            if (!r.success) return toast(r.error || 'Could not fill the form', 'error');
            const warn = (r.warnings || []).filter(w => w.code !== 'missing');
            const tail = warn.length ? ` — ${warn.length} warning${warn.length === 1 ? '' : 's'}: ${warn.slice(0, 3).map(w => (w.field ? w.field + ': ' : '') + w.message).join('; ')}` : '';
            if (mode === 'case') {
                toast(`Saved to the case: ${r.fileName}${tail}`, warn.length ? 'warning' : 'success');
                await loadFiles();
            } else if (mode === 'saveAs') {
                toast(`Saved: ${r.filePath}${tail}`, warn.length ? 'warning' : 'success');
            } else if (warn.length) {
                toast(`Opened.${tail}`, 'warning');
            }
        } catch (e) {
            toast('Could not fill the form: ' + (e && e.message || e), 'error');
        } finally {
            S.busy = false; render();
        }
    }

    async function openSaved(fileName, action) {
        try {
            const r = await api().caseFormsOpen({ caseNumber: S.ctx.caseNumber, fileName, action });
            if (!r || !r.success) toast((r && r.error) || 'Could not open that form', 'error');
        } catch (e) { toast('Could not open that form: ' + (e && e.message || e), 'error'); }
    }

    /* ── Events ──────────────────────────────────────────────────────── */

    function onClick(e) {
        const b = e.target && e.target.closest && e.target.closest('[data-cft-act]');
        if (!b || b.disabled) return;
        const act = b.getAttribute('data-cft-act');
        const arg = b.getAttribute('data-cft-arg') || '';
        if (act === 'entry') {
            const entry = findEntry(arg);
            if (!entry) return;
            S.entryKey = arg;
            const pick = entry.forms.find(f => f.language === 'en') || entry.forms[0];
            openForm(pick.id, false);
        } else if (act === 'lang') {
            if (arg !== S.formId) openForm(arg, true);
        } else if (act === 'fill') fill(arg);
        else if (act === 'reset') {
            const i = Number(arg);
            const row = S.rows && S.rows.rows[i];
            if (row) { delete S.edited[row.name]; recompute(); render(); }
        } else if (act === 'reset-all') { S.edited = {}; recompute(); render(); }
        else if (act === 'reload') {
            refreshPeople(); recompute(); render();
            toast('Case data reloaded', 'info');
        } else if (act === 'saved-open') openSaved(arg, 'open');
        else if (act === 'saved-show') openSaved(arg, 'show');
        else if (act === 'close-form') { S.formId = ''; S.entryKey = ''; S.spec = null; render(); }
    }

    function onChange(e) {
        const t = e.target;
        if (!t || !t.getAttribute) return;
        if (t.hasAttribute('data-cft-set')) {
            S.setId = t.value; S.entryKey = ''; S.formId = ''; S.spec = null; render();
        } else if (t.hasAttribute('data-cft-slot')) {
            const slot = t.getAttribute('data-cft-slot');
            if (t.value) S.picks.people[slot] = t.value; else delete S.picks.people[slot];
            recompute(); render();
        } else if (t.hasAttribute('data-cft-vslot')) {
            const slot = t.getAttribute('data-cft-vslot');
            if (t.value) S.picks.vehicles[slot] = t.value; else delete S.picks.vehicles[slot];
            recompute(); render();
        } else if (t.hasAttribute('data-cft-onlyblank')) {
            S.onlyBlank = !!t.checked; render();
        } else if (t.hasAttribute('data-cft-field')) {
            setField(t, true);
        }
    }

    // Typing updates the value without re-rendering (keeps the caret).
    function onInput(e) {
        const t = e.target;
        if (t && t.hasAttribute && t.hasAttribute('data-cft-field') && t.type !== 'checkbox' && t.tagName !== 'SELECT') setField(t, false);
    }

    function setField(t, rerender) {
        const i = Number(t.getAttribute('data-cft-field'));
        const row = S.rows && S.rows.rows[i];
        if (!row) return;
        const v = t.type === 'checkbox' ? !!t.checked : t.value;
        S.edited[row.name] = v;
        row.value = v; row.edited = true;
        row.blank = row.type === 'checkbox' ? false : str(v) === '';
        if (rerender) render();
        else {
            const tr = t.closest('[data-cft-row]');
            if (tr) tr.classList.toggle('cft-edited', true);
            const counts = el.querySelector('[data-cft-counts]');
            if (counts) counts.innerHTML = countsHtml();
        }
    }

    function findEntry(key) {
        const set = currentSet();
        if (!set) return null;
        for (const g of formGroups(set.forms)) for (const e of g.entries) if (e.key === key) return e;
        return null;
    }

    /* ── Rendering ───────────────────────────────────────────────────── */

    function render() {
        if (!el || !S) return;
        // Keep the scroll position of the values list across re-renders.
        const list = el.querySelector('[data-cft-values]');
        const scroll = list ? list.scrollTop : 0;
        el.innerHTML = `
            <div class="space-y-4">
                ${headerHtml()}
                ${S.error ? `<div class="p-3 rounded border border-rose-500/40 bg-rose-500/10 text-sm text-rose-200">${esc(S.error)}</div>` : ''}
                ${S.sets.length ? `
                <div class="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-4 items-start">
                    <div class="space-y-4">${formListHtml()}${savedHtml()}</div>
                    <div>${formPanelHtml()}</div>
                </div>` : emptyHtml()}
            </div>`;
        const list2 = el.querySelector('[data-cft-values]');
        if (list2 && scroll) list2.scrollTop = scroll;
    }

    function headerHtml() {
        const sets = S.sets;
        const picker = sets.length > 1
            ? `<select data-cft-set class="px-2 py-1.5 text-sm rounded-lg bg-viper-dark border border-gray-600 text-white">${sets.map(s =>
                `<option value="${esc(s.id)}" ${s.id === S.setId ? 'selected' : ''}>${esc(s.name)}${s.agency ? ' — ' + esc(s.agency) : ''}</option>`).join('')}</select>`
            : (sets[0] ? `<span class="text-xs text-gray-400">${esc(sets[0].name)}${sets[0].agency ? ' · ' + esc(sets[0].agency) : ''} · v${esc(sets[0].version)}</span>` : '');
        return `
            <div class="flex items-center justify-between gap-3 flex-wrap">
                <h3 class="text-2xl font-bold flex items-center">
                    <svg class="w-6 h-6 mr-2 text-viper-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>
                    Forms
                </h3>
                ${picker}
            </div>`;
    }

    function emptyHtml() {
        return `<div class="glass-card rounded-xl p-6 text-sm text-gray-400">
            No agency form set is switched on. Open <span class="text-gray-200">Settings → Agency Forms</span> and switch on your agency's set.</div>`;
    }

    function formListHtml() {
        const set = currentSet();
        if (!set) return '';
        const groups = formGroups(set.forms);
        return `
            <div class="glass-card rounded-xl p-3 space-y-3" data-cft-list>
                ${groups.map(g => `
                    <div>
                        <div class="text-[10px] uppercase tracking-wide text-gray-500 mb-1">${esc(g.category)}</div>
                        <div class="space-y-1">${g.entries.map(e => {
                            const active = e.key === S.entryKey;
                            const langs = [...new Set(e.forms.map(f => f.language).filter(Boolean))];
                            return `<button type="button" data-cft-act="entry" data-cft-arg="${esc(e.key)}"
                                class="w-full text-left px-2.5 py-1.5 rounded-lg text-sm border ${active ? 'border-viper-cyan/60 bg-viper-cyan/10 text-white' : 'border-transparent hover:bg-gray-700/30 text-gray-200'}">
                                ${esc(e.title)}${langs.length > 1 ? `<span class="ml-1 text-[10px] text-gray-500">${esc(langs.map(l => l.toUpperCase()).join(' / '))}</span>` : ''}</button>`;
                        }).join('')}</div>
                    </div>`).join('')}
            </div>`;
    }

    function fmtWhen(iso) {
        const d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function savedHtml() {
        const files = S.files || [];
        return `
            <div class="glass-card rounded-xl p-3" data-cft-saved>
                <div class="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Saved in this case</div>
                ${files.length ? `<div class="space-y-1.5">${files.slice(0, 50).map(f => `
                    <div class="flex items-center justify-between gap-2 text-xs">
                        <div class="min-w-0"><div class="text-gray-200 truncate" title="${esc(f.fileName)}">${esc(f.fileName)}</div><div class="text-[10px] text-gray-500">${esc(fmtWhen(f.modifiedAt))}</div></div>
                        <div class="flex gap-1 shrink-0">
                            <button type="button" data-cft-act="saved-open" data-cft-arg="${esc(f.fileName)}" class="px-2 py-0.5 rounded border border-gray-600 text-gray-300 hover:bg-gray-700/40">Open</button>
                            <button type="button" data-cft-act="saved-show" data-cft-arg="${esc(f.fileName)}" class="px-2 py-0.5 rounded border border-gray-600 text-gray-300 hover:bg-gray-700/40" title="Show in folder">Folder</button>
                        </div>
                    </div>`).join('')}</div>` : '<div class="text-xs text-gray-500 italic">No filled forms yet.</div>'}
            </div>`;
    }

    function countsHtml() {
        const rows = (S.rows && S.rows.rows) || [];
        const fromCase = rows.filter(r => r.how.kind === 'case' && !r.blank && !r.edited).length;
        const blanks = rows.filter(r => r.blank).length;
        const edited = rows.filter(r => r.edited).length;
        return [
            `${fromCase} from the case`,
            `<span class="${blanks ? 'text-amber-300' : ''}">${blanks} blank</span>`,
            edited ? `${edited} typed` : '',
        ].filter(Boolean).join(' · ');
    }

    function slotPickersHtml() {
        const form = S.spec.form;
        const slots = form.slots || [], vslots = form.vehicleSlots || [];
        if (!slots.length && !vslots.length) return '';
        const personSel = (s) => {
            const roles = Array.isArray(s.roles) && s.roles.length ? s.roles : null;
            const list = roles ? S.people.filter(p => roles.includes(p.role)).concat(S.people.filter(p => !roles.includes(p.role))) : S.people;
            const cur = S.picks.people[s.id] || '';
            return `<label class="text-[11px] text-gray-400 block">${esc(s.label)}
                <select data-cft-slot="${esc(s.id)}" class="${IN} mt-0.5">
                    <option value="">— nobody —</option>
                    ${list.map(p => `<option value="${esc(p.key)}" ${p.key === cur ? 'selected' : ''}>${esc(p.roleLabel)}: ${esc(p.label)}</option>`).join('')}
                </select></label>`;
        };
        const vehicleSel = (s) => {
            const cur = S.picks.vehicles[s.id] || '';
            return `<label class="text-[11px] text-gray-400 block">${esc(s.label)}
                <select data-cft-vslot="${esc(s.id)}" class="${IN} mt-0.5">
                    <option value="">— none —</option>
                    ${S.vehicles.map(v => `<option value="${esc(v.key)}" ${v.key === cur ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
                </select></label>`;
        };
        const none = (slots.length && !S.people.length) ? '<p class="text-[11px] text-amber-300 mt-1">This case has no suspects, victims, witnesses or involved persons yet — add them on their tabs, or type the names below.</p>' : '';
        const noneV = (vslots.length && !S.vehicles.length) ? '<p class="text-[11px] text-amber-300 mt-1">This case has no vehicles yet — type the vehicle below.</p>' : '';
        return `
            <div class="p-3 rounded-lg border border-gray-700/60 bg-viper-dark/40">
                <div class="flex items-center justify-between mb-2">
                    <div class="text-xs font-semibold text-gray-300">Who is on this form</div>
                    <button type="button" data-cft-act="reload" class="text-[11px] text-gray-400 hover:text-viper-cyan" title="Pick up changes made on other tabs">Reload case data</button>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">${slots.map(personSel).join('')}${vslots.map(vehicleSel).join('')}</div>
                ${none}${noneV}
            </div>`;
    }

    function inputHtml(r, i) {
        const attr = `data-cft-field="${i}" aria-label="${esc(r.name)}"`;
        if (r.type === 'checkbox') {
            return `<input type="checkbox" ${attr} ${r.value === true ? 'checked' : ''} class="w-4 h-4 rounded border-gray-600 text-viper-cyan">`;
        }
        if (r.type === 'dropdown' || r.type === 'list' || r.type === 'radio') {
            const v = r.value == null ? '' : String(r.value);
            const opts = r.options.slice();
            if (v && !opts.includes(v)) opts.unshift(v);
            return `<select ${attr} class="${IN}"><option value="">—</option>${opts.map(o => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        }
        const max = r.maxLength ? ` maxlength="${r.maxLength}"` : '';
        if (r.multiline) return `<textarea ${attr}${max} rows="3" class="${IN}">${esc(r.value)}</textarea>`;
        return `<input type="text" ${attr}${max} value="${esc(r.value)}" class="${IN}">`;
    }

    function rowsHtml() {
        const rows = (S.rows && S.rows.rows) || [];
        const pages = new Set(rows.map(r => r.page)).size > 1;
        let lastPage = -1;
        const out = [];
        rows.forEach((r, i) => {
            if (S.onlyBlank && !r.blank && !r.edited) return;
            if (pages && r.page !== lastPage) {
                lastPage = r.page;
                out.push(`<tr><td colspan="3" class="pt-3 pb-1 text-[10px] uppercase tracking-wide text-gray-500">Page ${r.page + 1}</td></tr>`);
            }
            const howCls = r.how.kind === 'case' ? 'text-viper-cyan/80' : r.how.kind === 'const' ? 'text-gray-500' : 'text-amber-300/80';
            out.push(`
                <tr data-cft-row class="border-t border-gray-800 align-top ${r.edited ? 'cft-edited' : ''}">
                    <td class="py-1.5 pr-3 w-[38%]">
                        <div class="text-xs text-gray-200 break-words">${esc(r.name)}${r.required ? ' <span class="text-rose-300">*</span>' : ''}</div>
                        <div class="text-[10px] ${howCls}">${esc(r.how.text)}</div>
                    </td>
                    <td class="py-1.5">${inputHtml(r, i)}</td>
                    <td class="py-1.5 pl-2 w-14 text-right">${r.edited ? `<button type="button" data-cft-act="reset" data-cft-arg="${i}" class="text-[10px] text-gray-400 hover:text-viper-cyan" title="Back to the value from the case">Undo</button>` : ''}</td>
                </tr>`);
        });
        if (!out.length) return `<div class="text-xs text-gray-500 italic p-2">${S.onlyBlank ? 'Nothing left blank.' : 'This form has no fillable boxes.'}</div>`;
        return `<table class="w-full">${out.join('')}</table>`;
    }

    function formPanelHtml() {
        if (S.loadingForm) return '<div class="glass-card rounded-xl p-6 text-sm text-gray-400">Opening the form…</div>';
        if (!S.spec) return '<div class="glass-card rounded-xl p-6 text-sm text-gray-400">Choose a form on the left.</div>';
        const form = S.spec.form;
        const entry = findEntry(S.entryKey);
        const langForms = entry ? entry.forms.filter(f => f.language) : [];
        const langBtns = langForms.length > 1 ? `
            <div class="flex gap-1" role="group" aria-label="Language">${langForms.map(f => `
                <button type="button" data-cft-act="lang" data-cft-arg="${esc(f.id)}"
                    class="px-2.5 py-1 text-xs rounded border ${f.id === form.id ? 'border-viper-cyan bg-viper-cyan/20 text-viper-cyan' : 'border-gray-600 text-gray-300 hover:bg-gray-700/40'}">${esc(langName(f.language))}</button>`).join('')}
            </div>` : '';
        const skipped = S.rows && S.rows.skipped ? `<span class="text-gray-500"> · ${S.rows.skipped} signature/other boxes left for paper</span>` : '';
        const anyEdited = Object.keys(S.edited).length > 0;
        return `
            <div class="glass-card rounded-xl p-4 space-y-3" data-cft-form="${esc(form.id)}">
                <div class="flex items-start justify-between gap-3 flex-wrap">
                    <div class="min-w-0">
                        <div class="text-lg font-semibold text-white">${esc(form.title)}</div>
                        <div class="text-[11px] text-gray-400">${esc(S.spec.set.name)} v${esc(S.spec.set.version)}${form.category ? ' · ' + esc(form.category) : ''}${form.flatten ? ' · saved flattened (not editable afterwards)' : ''}</div>
                    </div>
                    <div class="flex items-center gap-2">${langBtns}
                        <button type="button" data-cft-act="close-form" class="text-gray-400 hover:text-white text-lg leading-none px-1" title="Close">×</button>
                    </div>
                </div>
                ${slotPickersHtml()}
                <div>
                    <div class="flex items-center justify-between gap-2 mb-1 flex-wrap">
                        <div class="text-[11px] text-gray-400" data-cft-counts>${countsHtml()}</div>
                        <div class="flex items-center gap-3">
                            ${anyEdited ? '<button type="button" data-cft-act="reset-all" class="text-[11px] text-gray-400 hover:text-viper-cyan">Undo all typing</button>' : ''}
                            <label class="text-[11px] text-gray-400 flex items-center gap-1.5"><input type="checkbox" data-cft-onlyblank ${S.onlyBlank ? 'checked' : ''} class="w-3.5 h-3.5"> Only blanks</label>
                        </div>
                    </div>
                    <div class="max-h-[55vh] overflow-y-auto pr-1" data-cft-values>${rowsHtml()}</div>
                    <div class="text-[10px] text-gray-500 mt-1">Values typed here go into this PDF only; they do not change the case.${skipped}</div>
                </div>
                <div class="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-700/50">
                    <button type="button" data-cft-act="fill" data-cft-arg="case" ${S.busy ? 'disabled' : ''} class="${BTN_MAIN}" title="Save the filled PDF in this case's Forms folder">Save to case</button>
                    <button type="button" data-cft-act="fill" data-cft-arg="open" ${S.busy ? 'disabled' : ''} class="${BTN_GREY}" title="Open the filled PDF to check or print it, without saving it to the case">Open to check / print</button>
                    <button type="button" data-cft-act="fill" data-cft-arg="saveAs" ${S.busy ? 'disabled' : ''} class="${BTN_GREY}">Save as…</button>
                    ${S.busy ? '<span class="text-xs text-gray-400">Filling…</span>' : ''}
                </div>
            </div>`;
    }

    return Object.assign({}, helpers, { mount });
}));
